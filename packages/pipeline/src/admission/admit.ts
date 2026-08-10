/**
 * One admission door for named and one-off pipeline definitions (Q032).
 *
 * Named precedence (resolved by the caller before admission): bundled →
 * global (`config/pipelines`) → codebase copy-on-write override. This module
 * stays filesystem-pure: bundled templates are in-memory, and non-bundled
 * named definitions arrive already loaded. One-offs always re-enter through
 * `PipelineDefinition/v1` parse/normalize/validate — never a caller-asserted
 * “already validated” graph. Overrides are closed: unknown, sensitive,
 * unsupported, or forbidden fields reject admission; nothing is dropped.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalJsonStringify, type JsonValue } from "@heniek/config";
import type {
  PipelineAppliedOverrideV1,
  PipelineDefinitionSourceV1,
  PipelineInvocationOverrideRequestV1,
  PipelineRunSnapshotV1,
  PipelineValidateRequestV1,
  PipelineValidateResultV1,
} from "@heniek/contracts";
import {
  PipelineAppliedOverrideV1 as AppliedOverrideSchema,
  PipelineInvocationOverrideRequestV1 as OverrideRequestSchema,
} from "@heniek/contracts";
import { redactJson } from "@heniek/secrets";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getBundledPipeline, loadBundledPipeline } from "../bundled/index.js";
import type { PipelineGraph } from "../document.js";
import { parsePipelineDocument } from "../parse.js";
import { renderPipelineGraph } from "../render.js";

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => !Number.isNaN(Date.parse(value)));
}

const PROFILE_FIELDS = new Set([
  "engine",
  "account",
  "billing",
  "model",
  "effort",
  "executor",
  "focus",
  "max_duration",
  "workspace_strategy",
]);

const HARD_LIMIT_FIELDS = new Set([
  "max_pipeline_duration",
  "max_concurrent_workers",
  "max_repair_attempts",
  "max_graph_revisions",
]);

const CLOSED_FIELDS = new Set([
  "mode",
  "engine",
  "account",
  "billing",
  "model",
  "effort",
  "executor",
  "focus",
  "max_duration",
  "workspace_strategy",
  "max_pipeline_duration",
  "max_concurrent_workers",
  "max_repair_attempts",
  "max_graph_revisions",
]);

/** Pre-loaded named definition when the source is not a bundled template. */
export interface ResolvedNamedDefinition {
  readonly text: string;
  readonly source: PipelineDefinitionSourceV1;
}

export interface AdmitPipelineInput {
  readonly request: PipelineValidateRequestV1;
  /**
   * Required for named sources that are not bundled. Callers that own the
   * filesystem (daemon) resolve codebase-override → global precedence and
   * pass the winning text here.
   */
  readonly namedDefinition?: ResolvedNamedDefinition;
  readonly profileOverridable?: ReadonlyMap<string, readonly string[]>;
  readonly now?: string;
}

export type AdmitPipelineResult = PipelineValidateResultV1;

interface Diagnostic {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly pointer?: string;
  readonly suggestion?: string;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isSensitive(value: unknown): boolean {
  return JSON.stringify(redactJson(value as never)) !== JSON.stringify(value);
}

function cloneGraph(graph: PipelineGraph): PipelineGraph {
  return JSON.parse(renderPipelineGraph(graph)) as PipelineGraph;
}

function graphDigest(graph: PipelineGraph): string {
  return sha256Text(renderPipelineGraph(graph));
}

function contentDigestForOneOff(graph: PipelineGraph): string {
  const withoutId = { ...cloneGraph(graph), pipelineId: "_" };
  return sha256Text(renderPipelineGraph(withoutId as PipelineGraph));
}

function oneOffPipelineId(contentDigest: string): string {
  return `oneoff.${contentDigest}`;
}

function resolveNamedSource(
  pipelineId: string,
  namedDefinition: ResolvedNamedDefinition | undefined,
):
  | { readonly ok: true; readonly source: PipelineDefinitionSourceV1; readonly text: string }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] } {
  const bundled = getBundledPipeline(pipelineId, 1);
  if (bundled !== undefined) {
    // Pin hashes against the generation-time manifest before admitting.
    loadBundledPipeline(pipelineId, 1);
    return {
      ok: true,
      text: bundled.source,
      source: {
        schemaVersion: 1,
        kind: "bundled",
        identity: `${pipelineId}.v1`,
        digest: bundled.sourceSha256,
        path: `bundled:${pipelineId}.v1`,
      },
    };
  }

  if (namedDefinition !== undefined) {
    return { ok: true, text: namedDefinition.text, source: namedDefinition.source };
  }

  return {
    ok: false,
    diagnostics: [
      {
        code: "pipeline.admission.unknown-named",
        severity: "error",
        message: `No named pipeline definition found for ${pipelineId}.`,
        suggestion: "Use a bundled id (fast, careful), a global template, or a codebase override.",
      },
    ],
  };
}

function parseDefinitionText(
  text: string,
  format: "yaml" | "json",
  sourcePath: string,
  knownProfileIds: readonly string[] | undefined,
): ReturnType<typeof parsePipelineDocument> {
  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "pipeline.admission.invalid-json",
            severity: "error",
            message: `One-off definition is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
    // Re-enter the YAML admission door with a deterministic serialization so
    // schema + normalize + conformance share one path with named pipelines.
    const yamlText = canonicalJsonStringify(parsed as JsonValue);
    return parsePipelineDocument(yamlText, {
      sourcePath,
      ...(knownProfileIds === undefined ? {} : { knownProfileIds }),
    });
  }
  return parsePipelineDocument(text, {
    sourcePath,
    ...(knownProfileIds === undefined ? {} : { knownProfileIds }),
  });
}

function applyOverrides(
  base: PipelineGraph,
  overrides: readonly PipelineInvocationOverrideRequestV1[],
  profileOverridable: ReadonlyMap<string, readonly string[]> | undefined,
):
  | {
      readonly ok: true;
      readonly graph: PipelineGraph;
      readonly applied: readonly PipelineAppliedOverrideV1[];
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const applied: PipelineAppliedOverrideV1[] = [];
  const graph = cloneGraph(base);
  const stagesById = new Map(graph.stages.map((stage) => [stage.id, stage]));

  for (const [index, raw] of overrides.entries()) {
    if (!Value.Check(OverrideRequestSchema, raw)) {
      diagnostics.push({
        code: "pipeline.override.invalid-request",
        severity: "error",
        message: `Override at index ${index} does not satisfy PipelineInvocationOverrideRequest/v1.`,
        pointer: `/overrides/${index}`,
      });
      continue;
    }
    const override = raw;
    const field = override.field;
    const pointer = `/overrides/${index}`;

    if (!CLOSED_FIELDS.has(field)) {
      diagnostics.push({
        code: "pipeline.override.unknown-field",
        severity: "error",
        message: `Override field ${field} is not in the closed invocation-override contract.`,
        pointer,
        suggestion: "Remove the field or use an allowlisted override key.",
      });
      continue;
    }
    if (isSensitive(override.value)) {
      diagnostics.push({
        code: "pipeline.override.sensitive-value",
        severity: "error",
        message: `Override field ${field} contains a credential-shaped value and was rejected.`,
        pointer,
      });
      continue;
    }

    if (HARD_LIMIT_FIELDS.has(field)) {
      if (override.target.kind !== "pipeline") {
        diagnostics.push({
          code: "pipeline.override.forbidden-target",
          severity: "error",
          message: `Hard-limit field ${field} may only target the pipeline.`,
          pointer,
        });
        continue;
      }
      const limits = { ...(graph.limits ?? {}) } as Record<string, unknown>;
      const existing = limits[toCamelLimit(field)];
      const next = coerceLimit(field, override.value, diagnostics, pointer);
      if (next === undefined) continue;
      limits[toCamelLimit(field)] = strictestLimit(field, existing, next);
      (graph as { limits: typeof graph.limits }).limits = limits as typeof graph.limits;
      const entry: PipelineAppliedOverrideV1 = {
        schemaVersion: 1,
        target: { kind: "pipeline" },
        field: field as PipelineAppliedOverrideV1["field"],
        value: redactJson(next as never),
        source: "configuration-policy",
        redacted: false,
      };
      if (!Value.Check(AppliedOverrideSchema, entry)) {
        diagnostics.push({
          code: "pipeline.override.internal",
          severity: "error",
          message: "Applied override failed contract validation.",
          pointer,
        });
        continue;
      }
      applied.push(entry);
      continue;
    }

    if (override.target.kind !== "stage") {
      diagnostics.push({
        code: "pipeline.override.forbidden-target",
        severity: "error",
        message: `Field ${field} requires a stage target.`,
        pointer,
      });
      continue;
    }

    const stage = stagesById.get(override.target.stageId);
    if (stage === undefined) {
      diagnostics.push({
        code: "pipeline.override.unknown-stage",
        severity: "error",
        message: `Stage ${override.target.stageId} does not exist on the graph.`,
        pointer,
      });
      continue;
    }

    const stageAllow = new Set(stage.overridable);
    if (!stageAllow.has(field)) {
      diagnostics.push({
        code: "pipeline.override.stage-not-permitted",
        severity: "error",
        message: `Stage ${stage.id} does not declare ${field} as overridable.`,
        pointer,
      });
      continue;
    }

    if (field === "mode") {
      if (override.value !== "autonomous" && override.value !== "hitl") {
        diagnostics.push({
          code: "pipeline.override.invalid-value",
          severity: "error",
          message: "mode override must be autonomous or hitl.",
          pointer,
        });
        continue;
      }
      (stage as { mode: "autonomous" | "hitl" }).mode = override.value;
      applied.push({
        schemaVersion: 1,
        target: { kind: "stage", stageId: stage.id },
        field: "mode",
        value: override.value,
        source: "stage-allowlist",
        redacted: false,
      });
      continue;
    }

    if (!PROFILE_FIELDS.has(field)) {
      diagnostics.push({
        code: "pipeline.override.unsupported-field",
        severity: "error",
        message: `Field ${field} is not supported as a stage profile override.`,
        pointer,
      });
      continue;
    }

    const profileId = stage.profile;
    if (profileId === undefined) {
      diagnostics.push({
        code: "pipeline.override.no-profile",
        severity: "error",
        message: `Stage ${stage.id} has no profile to override.`,
        pointer,
      });
      continue;
    }
    const profileAllow = new Set(profileOverridable?.get(profileId) ?? []);
    if (!profileAllow.has(field)) {
      diagnostics.push({
        code: "pipeline.override.profile-not-permitted",
        severity: "error",
        message: `Profile ${profileId} does not declare ${field} as overridable.`,
        pointer,
      });
      continue;
    }

    // Persist as applied provenance; profile materialization happens at dispatch.
    applied.push({
      schemaVersion: 1,
      target: { kind: "stage", stageId: stage.id },
      field: field as PipelineAppliedOverrideV1["field"],
      value: redactJson(override.value as never),
      source: "invocation",
      redacted: isSensitive(override.value),
    });
  }

  if (diagnostics.some((d) => d.severity === "error")) {
    return { ok: false, diagnostics };
  }
  return { ok: true, graph, applied };
}

function toCamelLimit(field: string): string {
  switch (field) {
    case "max_pipeline_duration":
      return "maxPipelineDurationMs";
    case "max_concurrent_workers":
      return "maxConcurrentWorkers";
    case "max_repair_attempts":
      return "maxRepairAttempts";
    case "max_graph_revisions":
      return "maxGraphRevisions";
    default:
      return field;
  }
}

function coerceLimit(
  field: string,
  value: unknown,
  diagnostics: Diagnostic[],
  pointer: string,
): number | undefined {
  if (field === "max_pipeline_duration") {
    if (typeof value !== "string" && typeof value !== "number") {
      diagnostics.push({
        code: "pipeline.override.invalid-value",
        severity: "error",
        message: "max_pipeline_duration must be a duration string or millisecond number.",
        pointer,
      });
      return undefined;
    }
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 1) {
        diagnostics.push({
          code: "pipeline.override.invalid-value",
          severity: "error",
          message: "max_pipeline_duration numeric value must be a positive integer.",
          pointer,
        });
        return undefined;
      }
      return value;
    }
    const match = /^([1-9][0-9]*)(ms|s|m|h|d)$/.exec(value);
    if (match === null) {
      diagnostics.push({
        code: "pipeline.override.invalid-value",
        severity: "error",
        message: "max_pipeline_duration must match the duration pattern.",
        pointer,
      });
      return undefined;
    }
    const amount = Number(match[1]);
    const unit = match[2];
    const mult =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1000
          : unit === "m"
            ? 60_000
            : unit === "h"
              ? 3_600_000
              : 86_400_000;
    return amount * mult;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    diagnostics.push({
      code: "pipeline.override.invalid-value",
      severity: "error",
      message: `${field} must be a positive integer.`,
      pointer,
    });
    return undefined;
  }
  return value;
}

function strictestLimit(field: string, existing: unknown, next: number): number {
  if (typeof existing !== "number") return next;
  // Strictest-wins: lower magnitude is stricter for all current hard limits.
  return Math.min(existing, next);
}

export function admitPipeline(input: AdmitPipelineInput): AdmitPipelineResult {
  const diagnostics: Diagnostic[] = [];
  const request = input.request;
  const overrides = request.overrides ?? [];

  let source: PipelineDefinitionSourceV1;
  let parsed: ReturnType<typeof parsePipelineDocument>;

  if (request.source.kind === "named") {
    const named = resolveNamedSource(request.source.pipelineId, input.namedDefinition);
    if (!named.ok) {
      return {
        schemaVersion: 1,
        accepted: false,
        appliedOverrides: [],
        diagnostics: [...named.diagnostics],
      };
    }
    source = named.source;
    parsed = parsePipelineDocument(named.text, {
      sourcePath: named.source.path ?? named.source.identity,
      ...(request.knownProfileIds === undefined
        ? {}
        : { knownProfileIds: request.knownProfileIds }),
    });
  } else {
    parsed = parseDefinitionText(
      request.source.definitionText,
      request.source.format,
      "one-off.definition",
      request.knownProfileIds,
    );
    if (!parsed.ok) {
      return {
        schemaVersion: 1,
        accepted: false,
        appliedOverrides: [],
        diagnostics: parsed.diagnostics.map((d) => ({
          code: d.code,
          severity: d.severity,
          message: d.message,
          ...(d.pointer !== undefined ? { pointer: d.pointer } : {}),
          ...(d.suggestion !== undefined ? { suggestion: d.suggestion } : {}),
        })),
      };
    }
    const contentDigest = contentDigestForOneOff(parsed.graph);
    const pipelineId = oneOffPipelineId(contentDigest);
    const rewritten = { ...cloneGraph(parsed.graph), pipelineId } as PipelineGraph;
    parsed = { ok: true, graph: rewritten, diagnostics: parsed.diagnostics };
    source = {
      schemaVersion: 1,
      kind: "one-off",
      identity: pipelineId,
      digest: sha256Text(request.source.definitionText),
    };
  }

  if (!parsed.ok) {
    return {
      schemaVersion: 1,
      accepted: false,
      source,
      appliedOverrides: [],
      diagnostics: parsed.diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        message: d.message,
        ...(d.pointer !== undefined ? { pointer: d.pointer } : {}),
        ...(d.suggestion !== undefined ? { suggestion: d.suggestion } : {}),
      })),
    };
  }

  for (const d of parsed.diagnostics) {
    diagnostics.push({
      code: d.code,
      severity: d.severity,
      message: d.message,
      ...(d.pointer !== undefined ? { pointer: d.pointer } : {}),
      ...(d.suggestion !== undefined ? { suggestion: d.suggestion } : {}),
    });
  }

  const baseGraph = parsed.graph;
  const baseGraphDigest = graphDigest(baseGraph);
  const overridden = applyOverrides(baseGraph, overrides, input.profileOverridable);
  if (!overridden.ok) {
    return {
      schemaVersion: 1,
      accepted: false,
      pipelineId: baseGraph.pipelineId,
      source,
      baseGraph,
      baseGraphDigest,
      appliedOverrides: [],
      diagnostics: [...diagnostics, ...overridden.diagnostics],
    } as AdmitPipelineResult;
  }

  const effectiveGraph = overridden.graph;
  const effectiveGraphDigest = graphDigest(effectiveGraph);
  const hasError = diagnostics.some((d) => d.severity === "error");

  return {
    schemaVersion: 1,
    accepted: !hasError,
    pipelineId: effectiveGraph.pipelineId,
    source,
    baseGraph,
    effectiveGraph,
    baseGraphDigest,
    effectiveGraphDigest,
    appliedOverrides: [...overridden.applied],
    diagnostics,
  } as AdmitPipelineResult;
}

export function buildRunSnapshot(input: {
  readonly runId: string;
  readonly admission: AdmitPipelineResult;
  readonly requestedOverrides: readonly PipelineInvocationOverrideRequestV1[];
  readonly recordedAt: string;
  readonly resolvedProfiles?: PipelineRunSnapshotV1["resolvedProfiles"];
}): PipelineRunSnapshotV1 | undefined {
  if (
    !input.admission.accepted ||
    input.admission.effectiveGraph === undefined ||
    input.admission.baseGraph === undefined ||
    input.admission.source === undefined ||
    input.admission.pipelineId === undefined ||
    input.admission.baseGraphDigest === undefined ||
    input.admission.effectiveGraphDigest === undefined
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    runId: input.runId as PipelineRunSnapshotV1["runId"],
    pipelineId: input.admission.pipelineId,
    source: input.admission.source,
    baseGraph: input.admission.baseGraph,
    effectiveGraph: input.admission.effectiveGraph,
    baseGraphDigest: input.admission.baseGraphDigest,
    effectiveGraphDigest: input.admission.effectiveGraphDigest,
    resolvedProfiles: input.resolvedProfiles ?? [],
    requestedOverrides: [...input.requestedOverrides],
    appliedOverrides: [...input.admission.appliedOverrides],
    effectiveLimits: (input.admission.effectiveGraph.limits ?? {}) as Record<string, unknown>,
    recordedAt: input.recordedAt,
  };
}

export function codebasePipelineOverridesDirectory(
  codebasesDirectory: string,
  codebaseId: string,
): string {
  return join(codebasesDirectory, codebaseId, "pipeline-overrides");
}
