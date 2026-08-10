/**
 * Durable pipeline admission store — immutable run snapshots and ad-hoc
 * attachment ledger (Q032).
 *
 * Attachment applies a pre-validated augmented graph under a single
 * `BEGIN IMMEDIATE` transaction with optimistic schedule / run-revision CAS,
 * quiescence checks, and an immutable ledger row for idempotent replay.
 *
 * Artifact linking uses `stage_artifact_alias` rows on the target stage that
 * point at already-validated source `artifact_id`s (no matching-run CHECK on
 * the alias FK). New target-owned artifact rows would require `run_projection`
 * + journal coupling; aliases keep this store focused on durability.
 */

import type {
  PipelineAttachmentLifecycleV1,
  PipelineAttachRequestV1,
  PipelineRunSnapshotV1,
} from "@heniek/contracts";
import { internalClock, internalHandle, type StateDatabase } from "../database/open.js";
import { toSafeInteger, toText } from "../database/pragma.js";
import { StateStoreError } from "../errors.js";
import { type JsonValue, parseJsonValue, stringifyCanonical } from "../json.js";
import { writeCanonicalRunState } from "./recovery-store.js";
import type { PipelineGraph } from "./store.js";

const ACTIVE_STAGE_STATES = new Set(["queued", "running", "waiting", "retrying"]);

export type AttachAdHocStageRejectionCode =
  | "attachment-id-conflict"
  | "source-target-conflict"
  | "target-missing"
  | "target-terminal"
  | "stale-schedule"
  | "canonical-missing"
  | "stale-run-revision"
  | "not-quiescent"
  | "dependant-invalid"
  | "stage-exists"
  | "graph-revision-limit";

export interface SourceArtifactLink {
  readonly name: string;
  readonly sourceArtifactId: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly contentSchemaId: string;
  readonly byteLength: number;
  readonly relativePath: string;
}

export interface AttachAdHocStageInput {
  readonly request: PipelineAttachRequestV1;
  readonly requestDigest: string;
  readonly now?: string;
  readonly augmentedGraph: PipelineGraph;
  readonly sourceArtifactLinks: readonly SourceArtifactLink[];
  readonly validationEvidence: JsonValue;
}

export type AttachAdHocStageResult =
  | {
      readonly status: "committed";
      readonly lifecycle: PipelineAttachmentLifecycleV1;
    }
  | {
      readonly status: "idempotent-replay";
      readonly lifecycle: PipelineAttachmentLifecycleV1;
    }
  | {
      readonly status: "rejected";
      readonly code: AttachAdHocStageRejectionCode;
    };

export interface PipelineAttachmentRow {
  readonly attachmentId: string;
  readonly requestDigest: string;
  readonly sourceRunId: string;
  readonly sourceStageId: string;
  readonly targetRunId: string;
  readonly targetStageId: string;
  readonly request: JsonValue;
  readonly validationEvidence: JsonValue;
  readonly artifactIds: readonly string[];
  readonly lifecycle: PipelineAttachmentLifecycleV1;
  readonly graphRevisionBefore: number;
  readonly graphRevisionAfter: number;
  readonly scheduleRevisionAfter: number;
  readonly runRevisionAfter: number;
  readonly recordedAt: string;
}

function transaction<T>(db: StateDatabase, operation: () => T): T {
  const handle = internalHandle(db);
  if (handle.isTransaction) {
    throw new StateStoreError(
      "pipeline admission operations cannot run inside another transaction",
    );
  }
  handle.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    handle.exec("COMMIT");
    return result;
  } catch (error) {
    if (handle.isTransaction) handle.exec("ROLLBACK");
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = String((error as { code?: string }).code ?? "");
  if (code.startsWith("SQLITE_CONSTRAINT_UNIQUE") || code === "SQLITE_CONSTRAINT") {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("unique constraint failed");
}

function parseLifecycle(json: string): PipelineAttachmentLifecycleV1 {
  return parseJsonValue(json, "lifecycle_json") as PipelineAttachmentLifecycleV1;
}

function mapAttachmentRow(row: Record<string, unknown>): PipelineAttachmentRow {
  const artifactIdsJson = toText(row.artifact_ids_json, "artifact_ids_json");
  const artifactIds = parseJsonValue(artifactIdsJson, "artifact_ids_json");
  if (!Array.isArray(artifactIds) || !artifactIds.every((id) => typeof id === "string")) {
    throw new StateStoreError("pipeline attachment artifact_ids_json must be a string array");
  }
  return {
    attachmentId: toText(row.attachment_id, "row.attachment_id"),
    requestDigest: toText(row.request_digest, "row.request_digest"),
    sourceRunId: toText(row.source_run_id, "row.source_run_id"),
    sourceStageId: toText(row.source_stage_id, "row.source_stage_id"),
    targetRunId: toText(row.target_run_id, "row.target_run_id"),
    targetStageId: toText(row.target_stage_id, "row.target_stage_id"),
    request: parseJsonValue(toText(row.request_json, "request_json"), "request_json"),
    validationEvidence: parseJsonValue(
      toText(row.validation_evidence_json, "validation_evidence_json"),
      "validation_evidence_json",
    ),
    artifactIds,
    lifecycle: parseLifecycle(toText(row.lifecycle_json, "lifecycle_json")),
    graphRevisionBefore: toSafeInteger(row.graph_revision_before, "row.graph_revision_before"),
    graphRevisionAfter: toSafeInteger(row.graph_revision_after, "row.graph_revision_after"),
    scheduleRevisionAfter: toSafeInteger(
      row.schedule_revision_after,
      "row.schedule_revision_after",
    ),
    runRevisionAfter: toSafeInteger(row.run_revision_after, "row.run_revision_after"),
    recordedAt: toText(row.recorded_at, "row.recorded_at"),
  };
}

const ATTACHMENT_SELECT = `SELECT attachment_id, request_digest, source_run_id, source_stage_id,
        target_run_id, target_stage_id, request_json, validation_evidence_json,
        artifact_ids_json, lifecycle_json, graph_revision_before, graph_revision_after,
        schedule_revision_after, run_revision_after, recorded_at
   FROM pipeline_attachment_ledger`;

/** Insert an immutable per-run admission snapshot. Rejects on `run_id` conflict. */
export function writePipelineRunSnapshot(db: StateDatabase, snapshot: PipelineRunSnapshotV1): void {
  transaction(db, () => {
    const handle = internalHandle(db);
    try {
      handle
        .prepare(
          `INSERT INTO pipeline_run_snapshot (
            run_id, pipeline_id, source_kind, source_identity, source_digest, source_path,
            base_graph_json, effective_graph_json, base_graph_digest, effective_graph_digest,
            resolved_profiles_json, requested_overrides_json, applied_overrides_json,
            effective_limits_json, snapshot_json, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.runId,
          snapshot.pipelineId,
          snapshot.source.kind,
          snapshot.source.identity,
          snapshot.source.digest,
          snapshot.source.path ?? null,
          stringifyCanonical(snapshot.baseGraph as JsonValue),
          stringifyCanonical(snapshot.effectiveGraph as JsonValue),
          snapshot.baseGraphDigest,
          snapshot.effectiveGraphDigest,
          stringifyCanonical(snapshot.resolvedProfiles as unknown as JsonValue),
          stringifyCanonical(snapshot.requestedOverrides as unknown as JsonValue),
          stringifyCanonical(snapshot.appliedOverrides as unknown as JsonValue),
          stringifyCanonical(snapshot.effectiveLimits as JsonValue),
          stringifyCanonical(snapshot as unknown as JsonValue),
          snapshot.recordedAt,
        );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StateStoreError(
          `pipeline run snapshot already exists for run ${snapshot.runId}`,
          { cause: error },
        );
      }
      throw error;
    }
  });
}

export function readPipelineRunSnapshot(
  db: StateDatabase,
  runId: string,
): PipelineRunSnapshotV1 | undefined {
  const row = internalHandle(db)
    .prepare(`SELECT snapshot_json FROM pipeline_run_snapshot WHERE run_id = ?`)
    .get(runId);
  if (row === undefined) {
    return undefined;
  }
  return parseJsonValue(
    toText(row.snapshot_json, "snapshot_json"),
    "snapshot_json",
  ) as PipelineRunSnapshotV1;
}

export function readPipelineAttachment(
  db: StateDatabase,
  attachmentId: string,
): PipelineAttachmentRow | undefined {
  const row = internalHandle(db)
    .prepare(`${ATTACHMENT_SELECT} WHERE attachment_id = ?`)
    .get(attachmentId);
  if (row === undefined) {
    return undefined;
  }
  return mapAttachmentRow(row as Record<string, unknown>);
}

/**
 * Commit a pre-validated ad-hoc stage attachment into the target run under
 * one immediate transaction. Callers supply a conformance-checked
 * `augmentedGraph` and validated source artifact links.
 */
export function attachAdHocStage(
  db: StateDatabase,
  input: AttachAdHocStageInput,
): AttachAdHocStageResult {
  const now = input.now ?? internalClock(db).nowIso();
  const { request, requestDigest, augmentedGraph, sourceArtifactLinks, validationEvidence } = input;
  const targetStageId = request.stage.id;

  return transaction(db, () => {
    const handle = internalHandle(db);

    const existingById = handle
      .prepare(`${ATTACHMENT_SELECT} WHERE attachment_id = ?`)
      .get(request.attachmentId) as Record<string, unknown> | undefined;
    if (existingById !== undefined) {
      const storedDigest = toText(existingById.request_digest, "request_digest");
      if (storedDigest === requestDigest) {
        const lifecycle = parseLifecycle(toText(existingById.lifecycle_json, "lifecycle_json"));
        return {
          status: "idempotent-replay" as const,
          lifecycle: {
            ...lifecycle,
            phase: "idempotent-replay",
          },
        };
      }
      return { status: "rejected" as const, code: "attachment-id-conflict" as const };
    }

    const existingByPair = handle
      .prepare(
        `${ATTACHMENT_SELECT}
          WHERE source_run_id = ? AND source_stage_id = ?
            AND target_run_id = ? AND target_stage_id = ?`,
      )
      .get(request.sourceRunId, request.sourceStageId, request.targetRunId, targetStageId) as
      | Record<string, unknown>
      | undefined;
    if (existingByPair !== undefined) {
      return { status: "rejected" as const, code: "source-target-conflict" as const };
    }

    const schedule = handle
      .prepare(
        `SELECT run_id, pipeline_id, graph_revision, schedule_revision, terminal_outcome
           FROM pipeline_schedule WHERE run_id = ?`,
      )
      .get(request.targetRunId) as Record<string, unknown> | undefined;
    if (schedule === undefined) {
      return { status: "rejected" as const, code: "target-missing" as const };
    }
    if (schedule.terminal_outcome !== null && schedule.terminal_outcome !== undefined) {
      return { status: "rejected" as const, code: "target-terminal" as const };
    }

    const graphRevision = toSafeInteger(
      schedule.graph_revision,
      "pipeline_schedule.graph_revision",
    );
    const scheduleRevision = toSafeInteger(
      schedule.schedule_revision,
      "pipeline_schedule.schedule_revision",
    );
    if (
      graphRevision !== request.expectedGraphRevision ||
      scheduleRevision !== request.expectedScheduleRevision
    ) {
      return { status: "rejected" as const, code: "stale-schedule" as const };
    }

    const canonical = handle
      .prepare(
        `SELECT run_id, state_json, revision, updated_at
           FROM pipeline_canonical_run_state WHERE run_id = ?`,
      )
      .get(request.targetRunId) as Record<string, unknown> | undefined;
    if (canonical === undefined) {
      return { status: "rejected" as const, code: "canonical-missing" as const };
    }
    const runRevision = toSafeInteger(canonical.revision, "pipeline_canonical_run_state.revision");
    if (runRevision !== request.expectedRunRevision) {
      return { status: "rejected" as const, code: "stale-run-revision" as const };
    }
    const canonicalState = parseJsonValue(toText(canonical.state_json, "state_json"), "state_json");

    const stageRows = handle
      .prepare(
        `SELECT stage_id, state, attempt_ordinal, current_attempt_id
           FROM pipeline_stage_projection WHERE run_id = ?`,
      )
      .all(request.targetRunId) as Record<string, unknown>[];

    for (const row of stageRows) {
      const state = toText(row.state, "pipeline_stage_projection.state");
      if (ACTIVE_STAGE_STATES.has(state)) {
        return { status: "rejected" as const, code: "not-quiescent" as const };
      }
    }

    const stagesById = new Map(
      stageRows.map((row) => [toText(row.stage_id, "pipeline_stage_projection.stage_id"), row]),
    );

    for (const dependantId of request.dependantStageIds) {
      const dependant = stagesById.get(dependantId);
      if (dependant === undefined) {
        return { status: "rejected" as const, code: "dependant-invalid" as const };
      }
      const state = toText(dependant.state, "dependant.state");
      const attemptOrdinal = toSafeInteger(dependant.attempt_ordinal, "dependant.attempt_ordinal");
      if (state !== "pending" || attemptOrdinal !== 0 || dependant.current_attempt_id !== null) {
        return { status: "rejected" as const, code: "dependant-invalid" as const };
      }
    }

    if (stagesById.has(targetStageId)) {
      return { status: "rejected" as const, code: "stage-exists" as const };
    }

    const currentGraphRow = handle
      .prepare(
        `SELECT graph_json FROM pipeline_graph_revision
          WHERE run_id = ? AND graph_revision = ?`,
      )
      .get(request.targetRunId, graphRevision) as Record<string, unknown> | undefined;
    if (currentGraphRow === undefined) {
      throw new StateStoreError(
        `pipeline graph revision ${graphRevision} missing for run ${request.targetRunId}`,
      );
    }
    const currentGraph = parseJsonValue(
      toText(currentGraphRow.graph_json, "graph_json"),
      "graph_json",
    ) as PipelineGraph;
    const maxGraphRevisions = currentGraph.limits?.maxGraphRevisions;
    if (typeof maxGraphRevisions === "number" && graphRevision + 1 > maxGraphRevisions) {
      return { status: "rejected" as const, code: "graph-revision-limit" as const };
    }

    const nextGraphRevision = graphRevision + 1;
    const nextScheduleRevision = scheduleRevision + 1;
    const pipelineId = toText(schedule.pipeline_id, "pipeline_schedule.pipeline_id");

    handle
      .prepare(
        `INSERT INTO pipeline_graph_revision
          (run_id, graph_revision, pipeline_id, graph_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        request.targetRunId,
        nextGraphRevision,
        pipelineId,
        stringifyCanonical(augmentedGraph as JsonValue),
        now,
      );

    handle
      .prepare(
        `UPDATE pipeline_schedule
            SET graph_revision = ?, schedule_revision = ?, updated_at = ?
          WHERE run_id = ?`,
      )
      .run(nextGraphRevision, nextScheduleRevision, now, request.targetRunId);

    handle
      .prepare(
        `UPDATE pipeline_stage_projection
            SET graph_revision = ?, updated_at = ?
          WHERE run_id = ?`,
      )
      .run(nextGraphRevision, now, request.targetRunId);

    handle
      .prepare(
        `INSERT INTO pipeline_stage_projection
          (run_id, stage_id, graph_revision, generation, state, attempt_ordinal,
           current_attempt_id, last_transition_reason, block_reason, selected, updated_at)
         VALUES (?, ?, ?, 1, 'succeeded', 1, NULL, 'attempt_succeeded', NULL, 1, ?)`,
      )
      .run(request.targetRunId, targetStageId, nextGraphRevision, now);

    const artifactIds: string[] = [];
    for (const link of sourceArtifactLinks) {
      const sourceArtifact = handle
        .prepare(`SELECT artifact_id, last_event_sequence FROM artifact WHERE artifact_id = ?`)
        .get(link.sourceArtifactId) as Record<string, unknown> | undefined;
      if (sourceArtifact === undefined) {
        throw new StateStoreError(
          `source artifact ${link.sourceArtifactId} not found for attachment ${request.attachmentId}`,
        );
      }
      const lastEventSequence = toSafeInteger(
        sourceArtifact.last_event_sequence,
        "artifact.last_event_sequence",
      );
      try {
        handle
          .prepare(
            `INSERT INTO stage_artifact_alias
              (run_id, stage_id, name, artifact_id, revision, last_event_sequence, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            request.targetRunId,
            targetStageId,
            link.name,
            link.sourceArtifactId,
            lastEventSequence,
            now,
          );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StateStoreError(
            `stage artifact alias already exists for ${request.targetRunId}/${targetStageId}/${link.name}`,
            { cause: error },
          );
        }
        throw error;
      }
      artifactIds.push(link.sourceArtifactId);
    }

    const nextRunRevision = writeCanonicalRunState(handle, {
      runId: request.targetRunId,
      state: canonicalState,
      expectedRevision: request.expectedRunRevision,
      now,
    });
    if (nextRunRevision === undefined) {
      // IMMEDIATE lock should make this unreachable after the earlier read;
      // throw so any prior writes in this transaction roll back.
      throw new StateStoreError(
        `canonical run revision CAS failed for ${request.targetRunId} during attachment`,
      );
    }

    const lifecycle: PipelineAttachmentLifecycleV1 = {
      schemaVersion: 1,
      attachmentId: request.attachmentId,
      phase: "committed",
      sourceRunId: request.sourceRunId,
      sourceStageId: request.sourceStageId,
      targetRunId: request.targetRunId,
      targetStageId,
      requestDigest,
      graphRevisionBefore: graphRevision,
      graphRevisionAfter: nextGraphRevision,
      scheduleRevisionAfter: nextScheduleRevision,
      runRevisionAfter: nextRunRevision,
      artifactIds: artifactIds as PipelineAttachmentLifecycleV1["artifactIds"],
      recordedAt: now,
    };

    handle
      .prepare(
        `INSERT INTO pipeline_attachment_ledger (
          attachment_id, request_digest, source_run_id, source_stage_id,
          target_run_id, target_stage_id, request_json, validation_evidence_json,
          artifact_ids_json, lifecycle_json, graph_revision_before, graph_revision_after,
          schedule_revision_after, run_revision_after, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.attachmentId,
        requestDigest,
        request.sourceRunId,
        request.sourceStageId,
        request.targetRunId,
        targetStageId,
        stringifyCanonical(request as unknown as JsonValue),
        stringifyCanonical(validationEvidence),
        stringifyCanonical(artifactIds),
        stringifyCanonical(lifecycle as unknown as JsonValue),
        graphRevision,
        nextGraphRevision,
        nextScheduleRevision,
        nextRunRevision,
        now,
      );

    return { status: "committed" as const, lifecycle };
  });
}
