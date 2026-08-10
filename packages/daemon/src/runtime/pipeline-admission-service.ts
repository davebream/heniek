/**
 * Daemon-side pipeline admission: validate, run (schedule + snapshot), and
 * ad-hoc attach. Heavy logic lives here so `compose.ts` stays a thin wire.
 *
 * Named-template filesystem resolution (codebase override → global) lives here
 * so `@heniek/pipeline` admission stays pure.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ApplicationHome, canonicalJsonStringify, type JsonValue } from "@heniek/config";
import {
  type PipelineAttachedStageDefinitionV1,
  PipelineAttachRequestV1,
  type PipelineAttachResultV1,
  type PipelineDefinitionSourceV1,
  PipelineGraphV1,
  PipelineRunRequestV1,
  type PipelineRunResultV1,
  PipelineValidateRequestV1,
  type PipelineValidateResultV1,
} from "@heniek/contracts";
import {
  admitPipeline,
  buildRunSnapshot,
  codebasePipelineOverridesDirectory,
  createDiagnosticReporter,
  type PipelineGraph,
  type ResolvedNamedDefinition,
  validatePipelineGraph,
} from "@heniek/pipeline";
import {
  attachAdHocStage,
  createPipelineSchedule,
  readPipelineGraph,
  readPipelineSchedule,
  readPipelineStageProjections,
  readStageArtifacts,
  type SourceArtifactLink,
  type StateDatabase,
  type PipelineGraph as StatePipelineGraph,
  writePipelineRunSnapshot,
} from "@heniek/state";
import { Value } from "@sinclair/typebox/value";
import { STAGE_RESULT_CONTENT_SCHEMA_ID } from "./stage-completion.js";

type Diagnostic = PipelineValidateResultV1["diagnostics"][number];

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function loadNamedDefinitionFromHome(
  home: ApplicationHome,
  pipelineId: string,
  codebaseId: string | undefined,
): ResolvedNamedDefinition | undefined {
  if (codebaseId !== undefined) {
    const overridePath = join(
      codebasePipelineOverridesDirectory(home.paths.codebasesDirectory, codebaseId),
      `${pipelineId}.v1.yaml`,
    );
    if (existsSync(overridePath)) {
      const text = readFileSync(overridePath, "utf8");
      const source: PipelineDefinitionSourceV1 = {
        schemaVersion: 1,
        kind: "codebase-override",
        identity: pipelineId,
        digest: sha256Text(text),
        path: overridePath,
      };
      return { text, source };
    }
  }

  const globalPath = join(home.paths.pipelinesDirectory, `${pipelineId}.v1.yaml`);
  if (existsSync(globalPath)) {
    const text = readFileSync(globalPath, "utf8");
    const source: PipelineDefinitionSourceV1 = {
      schemaVersion: 1,
      kind: "global",
      identity: pipelineId,
      digest: sha256Text(text),
      path: globalPath,
    };
    return { text, source };
  }

  return undefined;
}

function namedDefinitionForRequest(
  home: ApplicationHome,
  request: PipelineValidateRequestV1,
): ResolvedNamedDefinition | undefined {
  if (request.source.kind !== "named") return undefined;
  return loadNamedDefinitionFromHome(home, request.source.pipelineId, request.source.codebaseId);
}

export function handlePipelineValidate(input: {
  readonly request: PipelineValidateRequestV1;
  readonly home: ApplicationHome;
}): PipelineValidateResultV1 {
  const namedDefinition = namedDefinitionForRequest(input.home, input.request);
  return admitPipeline({
    request: input.request,
    ...(namedDefinition === undefined ? {} : { namedDefinition }),
  });
}

export function handlePipelineRun(input: {
  readonly request: PipelineRunRequestV1;
  readonly home: ApplicationHome;
  readonly db: StateDatabase;
  readonly now: string;
}): PipelineRunResultV1 {
  const validateRequest: PipelineValidateRequestV1 = {
    schemaVersion: 1,
    source:
      input.request.source.kind === "named"
        ? {
            kind: "named",
            pipelineId: input.request.source.pipelineId,
            codebaseId: input.request.codebaseId,
          }
        : input.request.source,
    ...(input.request.overrides === undefined ? {} : { overrides: input.request.overrides }),
    ...(input.request.knownProfileIds === undefined
      ? {}
      : { knownProfileIds: input.request.knownProfileIds }),
  };
  const namedDefinition = namedDefinitionForRequest(input.home, validateRequest);
  const admission = admitPipeline({
    request: validateRequest,
    ...(namedDefinition === undefined ? {} : { namedDefinition }),
  });
  if (
    !admission.accepted ||
    admission.effectiveGraph === undefined ||
    admission.pipelineId === undefined
  ) {
    return {
      schemaVersion: 1,
      accepted: false,
      diagnostics: [...admission.diagnostics],
    };
  }

  const schedule = createPipelineSchedule(input.db, {
    runId: input.request.runId,
    pipelineId: admission.pipelineId,
    graph: admission.effectiveGraph as StatePipelineGraph,
    ...(input.request.deadlineAt === undefined ? {} : { deadlineAt: input.request.deadlineAt }),
    now: input.now,
  });

  const snapshot = buildRunSnapshot({
    runId: input.request.runId,
    admission,
    requestedOverrides: input.request.overrides ?? [],
    recordedAt: input.now,
  });
  if (snapshot === undefined) {
    return {
      schemaVersion: 1,
      accepted: false,
      diagnostics: [
        {
          code: "pipeline.run.snapshot-incomplete",
          severity: "error",
          message: "Admission accepted but run snapshot could not be built.",
        },
      ],
    };
  }
  writePipelineRunSnapshot(input.db, snapshot);

  return {
    schemaVersion: 1,
    accepted: true,
    runId: input.request.runId,
    pipelineId: admission.pipelineId,
    graphRevision: schedule.graphRevision,
    scheduleRevision: schedule.scheduleRevision,
    snapshot,
    diagnostics: [...admission.diagnostics],
  } satisfies PipelineRunResultV1;
}

function requiredArtifactNames(
  completion: PipelineAttachedStageDefinitionV1["completion"],
): readonly string[] {
  if (completion === undefined) return [];
  const names: string[] = [];
  for (const entry of completion.require) {
    if (typeof entry === "object" && entry !== null) {
      const record = entry as Record<string, unknown>;
      if (typeof record.artifact === "string") {
        names.push(record.artifact);
      } else if (record.kind === "artifact" && typeof record.name === "string") {
        names.push(record.name);
      }
    }
  }
  return names;
}

function normalizeAttachedStage(
  stage: PipelineAttachedStageDefinitionV1,
): PipelineGraph["stages"][number] {
  return {
    id: stage.id,
    type: stage.type,
    mode: stage.mode ?? "autonomous",
    optional: stage.optional ?? false,
    ...(stage.profile === undefined ? {} : { profile: stage.profile }),
    reads: [...(stage.reads ?? [])].sort(),
    writes: [...(stage.writes ?? [])].sort(),
    overridable: [...(stage.overridable ?? [])].sort(),
    ...(stage.completion === undefined
      ? {}
      : {
          completion: {
            require: stage.completion.require.map((entry) => {
              if (entry === "valid_result_envelope") {
                return { kind: "result_envelope" as const };
              }
              if (entry === "non_empty_diff") {
                return { kind: "non_empty_diff" as const };
              }
              if (typeof entry === "object" && entry !== null) {
                const record = entry as Record<string, unknown>;
                if (typeof record.artifact === "string") {
                  return { kind: "artifact" as const, name: record.artifact };
                }
                if (record.kind === "artifact" && typeof record.name === "string") {
                  return { kind: "artifact" as const, name: record.name };
                }
                if (record.kind === "result_envelope") {
                  return { kind: "result_envelope" as const };
                }
                if (record.kind === "non_empty_diff") {
                  return { kind: "non_empty_diff" as const };
                }
              }
              // Leave unknown requirement shapes for graph Value.Check to reject.
              return entry as never;
            }),
          },
        }),
  } as PipelineGraph["stages"][number];
}

function augmentGraph(
  current: PipelineGraph,
  stage: PipelineAttachedStageDefinitionV1,
  dependantStageIds: readonly PipelineAttachedStageDefinitionV1["id"][],
): PipelineGraph {
  const attached = normalizeAttachedStage(stage);
  const stages = [...current.stages, attached].sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges = [...current.edges, ...dependantStageIds.map((to) => ({ from: stage.id, to }))].sort(
    (a, b) => {
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      if (a.to !== b.to) return a.to < b.to ? -1 : 1;
      return 0;
    },
  );
  return { ...current, stages, edges };
}

function revalidateAugmentedGraph(graph: PipelineGraph): readonly Diagnostic[] {
  if (!Value.Check(PipelineGraphV1, graph)) {
    return [
      {
        code: "pipeline.attach.invalid-augmented-graph",
        severity: "error",
        message: "Augmented graph does not satisfy PipelineGraph/v1.",
      },
    ];
  }
  const reporter = createDiagnosticReporter({});
  validatePipelineGraph(
    {
      graph,
      edgePointers: graph.edges.map((_, index) => `/edges/${index}`),
      stagePointers: new Map(graph.stages.map((stage, index) => [stage.id, `/stages/${index}`])),
    },
    reporter,
  );
  return reporter.collect().map((d) => ({
    code: d.code,
    severity: d.severity,
    message: d.message,
    ...(d.pointer !== undefined ? { pointer: d.pointer } : {}),
    ...(d.suggestion !== undefined ? { suggestion: d.suggestion } : {}),
  }));
}

export function handlePipelineAttach(input: {
  readonly request: PipelineAttachRequestV1;
  readonly db: StateDatabase;
  readonly now: string;
}): PipelineAttachResultV1 {
  const { request, db, now } = input;
  const diagnostics: Diagnostic[] = [];

  const sourceStages = readPipelineStageProjections(db, request.sourceRunId);
  const sourceStage = sourceStages.find((row) => row.stageId === request.sourceStageId);
  if (sourceStage === undefined) {
    return {
      schemaVersion: 1,
      accepted: false,
      idempotentReplay: false,
      rejectionCode: "source-stage-missing",
      diagnostics: [
        {
          code: "pipeline.attach.source-missing",
          severity: "error",
          message: `Source stage ${request.sourceStageId} was not found on run ${request.sourceRunId}.`,
        },
      ],
    };
  }
  if (sourceStage.state !== "succeeded") {
    return {
      schemaVersion: 1,
      accepted: false,
      idempotentReplay: false,
      rejectionCode: "source-stage-not-succeeded",
      diagnostics: [
        {
          code: "pipeline.attach.source-not-succeeded",
          severity: "error",
          message: `Source stage ${request.sourceStageId} must be succeeded before attachment (was ${sourceStage.state}).`,
        },
      ],
    };
  }

  const sourceArtifacts = readStageArtifacts(db, request.sourceRunId).filter(
    (artifact) => artifact.stageId === request.sourceStageId,
  );
  const sourceByName = new Map(sourceArtifacts.map((artifact) => [artifact.name, artifact]));
  const requiredNames = requiredArtifactNames(request.stage.completion);
  for (const name of requiredNames) {
    if (!sourceByName.has(name)) {
      diagnostics.push({
        code: "pipeline.attach.missing-artifact",
        severity: "error",
        message: `Attached stage completion requires artifact "${name}" but the source stage has no matching alias.`,
      });
    }
  }
  if (diagnostics.some((d) => d.severity === "error")) {
    return {
      schemaVersion: 1,
      accepted: false,
      idempotentReplay: false,
      rejectionCode: "completion-artifacts-missing",
      diagnostics,
    };
  }

  const schedule = readPipelineSchedule(db, request.targetRunId);
  if (schedule === undefined) {
    return {
      schemaVersion: 1,
      accepted: false,
      idempotentReplay: false,
      rejectionCode: "target-missing",
      diagnostics: [
        {
          code: "pipeline.attach.target-missing",
          severity: "error",
          message: `Target run ${request.targetRunId} has no pipeline schedule.`,
        },
      ],
    };
  }

  const currentGraph = readPipelineGraph(db, request.targetRunId, schedule.graphRevision);
  if (currentGraph === undefined) {
    return {
      schemaVersion: 1,
      accepted: false,
      idempotentReplay: false,
      rejectionCode: "target-graph-missing",
      diagnostics: [
        {
          code: "pipeline.attach.target-graph-missing",
          severity: "error",
          message: `Target run ${request.targetRunId} is missing graph revision ${schedule.graphRevision}.`,
        },
      ],
    };
  }

  const augmented = augmentGraph(
    currentGraph as PipelineGraph,
    request.stage,
    request.dependantStageIds,
  );
  const graphDiagnostics = revalidateAugmentedGraph(augmented);
  diagnostics.push(...graphDiagnostics);
  if (graphDiagnostics.some((d) => d.severity === "error")) {
    return {
      schemaVersion: 1,
      accepted: false,
      idempotentReplay: false,
      rejectionCode: "augmented-graph-invalid",
      diagnostics,
    };
  }

  const sourceArtifactLinks: SourceArtifactLink[] = sourceArtifacts.map((artifact) => ({
    name: artifact.name,
    sourceArtifactId: artifact.artifactId,
    contentHash: artifact.contentHash,
    mediaType: artifact.mediaType,
    contentSchemaId: STAGE_RESULT_CONTENT_SCHEMA_ID,
    byteLength: artifact.byteLength,
    relativePath: artifact.relativePath,
  }));

  const requestDigest = sha256Text(canonicalJsonStringify(request as unknown as JsonValue));
  const validationEvidence = {
    schemaVersion: 1,
    sourceStageState: sourceStage.state,
    requiredArtifactNames: [...requiredNames],
    linkedArtifactNames: sourceArtifactLinks.map((link) => link.name).sort(),
    augmentedGraphDigest: sha256Text(canonicalJsonStringify(augmented as unknown as JsonValue)),
  };

  const result = attachAdHocStage(db, {
    request,
    requestDigest,
    now,
    augmentedGraph: augmented as StatePipelineGraph,
    sourceArtifactLinks,
    validationEvidence: validationEvidence as JsonValue,
  });

  if (result.status === "rejected") {
    return {
      schemaVersion: 1,
      accepted: false,
      idempotentReplay: false,
      rejectionCode: result.code,
      diagnostics: [
        ...diagnostics,
        {
          code: `pipeline.attach.${result.code}`,
          severity: "error",
          message: `Attachment rejected: ${result.code}.`,
        },
      ],
    };
  }

  return {
    schemaVersion: 1,
    accepted: true,
    idempotentReplay: result.status === "idempotent-replay",
    lifecycle: result.lifecycle,
    diagnostics,
  };
}

export function isPipelineValidateRequest(
  value: unknown,
): value is import("@heniek/contracts").PipelineValidateRequestV1 {
  return Value.Check(PipelineValidateRequestV1, value);
}

export function isPipelineRunRequest(
  value: unknown,
): value is import("@heniek/contracts").PipelineRunRequestV1 {
  return Value.Check(PipelineRunRequestV1, value);
}

export function isPipelineAttachRequest(
  value: unknown,
): value is import("@heniek/contracts").PipelineAttachRequestV1 {
  return Value.Check(PipelineAttachRequestV1, value);
}
