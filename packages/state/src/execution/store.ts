import type {
  ArtifactId,
  ExecutionStatus,
  InteractionAnswerSetV1,
  PendingInteractionV2,
} from "@heniek/contracts";
import { RunStatus } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { commitStateChange } from "../command/commit.js";
import { internalClock, internalHandle, type StateDatabase } from "../database/open.js";
import { toNullableText, toSafeInteger, toText } from "../database/pragma.js";
import { StateDatabaseCorruptionError, StateStoreError } from "../errors.js";
import {
  acceptInteractionAnswer,
  legacyAnswerSubmission,
  markExecutionOperationDelivered,
  readLegacyPendingInteractions,
  synchronizePendingInteractions,
} from "../interaction/store.js";
import { readRunProjection } from "../projection/run.js";

export interface RegisteredExecutionContext {
  readonly codebaseId: string;
  readonly repositoryId: string;
  readonly codebaseRoot: string;
  readonly repositoryPath: string;
  readonly defaultRemote: string;
  readonly defaultBranch: string;
}

export interface StageExecutionRow {
  readonly runId: string;
  readonly stageId: string;
  readonly codebaseId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly backendKind: string;
  readonly backendExecutionId: string | null;
  readonly status: ExecutionStatus;
  readonly prompt: string;
  readonly artifactPath: string;
  readonly limits: { readonly maxDurationMs?: number; readonly maxTurns?: number };
  readonly summary: string | null;
  readonly sessionId: string | null;
  readonly error: string | null;
  readonly finalized: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateStageExecutionInput {
  readonly runId: string;
  readonly stageId: string;
  readonly codebaseId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly backendKind: string;
  readonly prompt: string;
  readonly artifactPath: string;
  readonly limits: { readonly maxDurationMs?: number; readonly maxTurns?: number };
}

export interface ArtifactRecord {
  readonly artifactId: ArtifactId;
  readonly runId: string;
  readonly stageId: string;
  readonly name: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly relativePath: string;
}

const EXECUTION_COLUMNS =
  "run_id, stage_id, codebase_id, repository_id, workspace_id, backend_kind," +
  " backend_execution_id, status, prompt, artifact_path, summary, session_id, error, finalized," +
  " limits_json, created_at, updated_at";

function executionLimits(value: unknown): StageExecutionRow["limits"] {
  const raw = toText(value, "stage_execution.limits_json");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const limits = parsed as Record<string, unknown>;
    if (
      (limits.maxDurationMs !== undefined &&
        (!Number.isSafeInteger(limits.maxDurationMs) || (limits.maxDurationMs as number) < 1)) ||
      (limits.maxTurns !== undefined &&
        (!Number.isSafeInteger(limits.maxTurns) || (limits.maxTurns as number) < 1))
    ) {
      throw new Error();
    }
    return {
      ...(limits.maxDurationMs === undefined
        ? {}
        : { maxDurationMs: limits.maxDurationMs as number }),
      ...(limits.maxTurns === undefined ? {} : { maxTurns: limits.maxTurns as number }),
    };
  } catch (error) {
    throw new StateDatabaseCorruptionError("stage execution limits JSON is malformed", {
      cause: error,
    });
  }
}

function executionStatus(value: unknown): ExecutionStatus {
  const status = toText(value, "stage_execution.status");
  if (!(RunStatus.values as readonly string[]).includes(status)) {
    throw new StateDatabaseCorruptionError(`stage_execution.status is unknown: ${status}`);
  }
  return status as ExecutionStatus;
}

function executionRow(raw: Record<string, unknown>): StageExecutionRow {
  const finalized = toSafeInteger(raw.finalized, "stage_execution.finalized");
  if (finalized !== 0 && finalized !== 1) {
    throw new StateDatabaseCorruptionError("stage_execution.finalized is not boolean");
  }
  return {
    runId: toText(raw.run_id, "stage_execution.run_id"),
    stageId: toText(raw.stage_id, "stage_execution.stage_id"),
    codebaseId: toText(raw.codebase_id, "stage_execution.codebase_id"),
    repositoryId: toText(raw.repository_id, "stage_execution.repository_id"),
    workspaceId: toText(raw.workspace_id, "stage_execution.workspace_id"),
    backendKind: toText(raw.backend_kind, "stage_execution.backend_kind"),
    backendExecutionId: toNullableText(
      raw.backend_execution_id,
      "stage_execution.backend_execution_id",
    ),
    status: executionStatus(raw.status),
    prompt: toText(raw.prompt, "stage_execution.prompt"),
    artifactPath: toText(raw.artifact_path, "stage_execution.artifact_path"),
    limits: executionLimits(raw.limits_json),
    summary: toNullableText(raw.summary, "stage_execution.summary"),
    sessionId: toNullableText(raw.session_id, "stage_execution.session_id"),
    error: toNullableText(raw.error, "stage_execution.error"),
    finalized: finalized === 1,
    createdAt: toText(raw.created_at, "stage_execution.created_at"),
    updatedAt: toText(raw.updated_at, "stage_execution.updated_at"),
  };
}

export function findRegisteredExecutionContext(
  db: StateDatabase,
  currentDirectory: string,
): RegisteredExecutionContext | undefined {
  const row = internalHandle(db)
    .prepare(
      `SELECT c.codebase_id, c.root_path, r.repository_id, r.repository_path,
              r.default_remote, r.default_branch
         FROM repository r
         JOIN codebase c ON c.codebase_id = r.codebase_id
        WHERE (? = r.repository_path OR ? LIKE r.repository_path || '/%')
          AND c.root_path IS NOT NULL
          AND r.repository_path IS NOT NULL
          AND r.default_remote IS NOT NULL
          AND r.default_branch IS NOT NULL
        ORDER BY length(r.repository_path) DESC
        LIMIT 1`,
    )
    .get(currentDirectory, currentDirectory);
  if (row === undefined) return undefined;
  return {
    codebaseId: toText(row.codebase_id, "codebase.codebase_id"),
    repositoryId: toText(row.repository_id, "repository.repository_id"),
    codebaseRoot: toText(row.root_path, "codebase.root_path"),
    repositoryPath: toText(row.repository_path, "repository.repository_path"),
    defaultRemote: toText(row.default_remote, "repository.default_remote"),
    defaultBranch: toText(row.default_branch, "repository.default_branch"),
  };
}

export function createStageExecution(db: StateDatabase, input: CreateStageExecutionInput): void {
  const now = internalClock(db).nowIso();
  internalHandle(db)
    .prepare(
      `INSERT INTO stage_execution (
         run_id, stage_id, codebase_id, repository_id, workspace_id, backend_kind,
         backend_execution_id, status, prompt, artifact_path, summary, session_id, error,
         finalized, limits_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'queued', ?, ?, NULL, NULL, NULL, 0, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.stageId,
      input.codebaseId,
      input.repositoryId,
      input.workspaceId,
      input.backendKind,
      input.prompt,
      input.artifactPath,
      JSON.stringify(input.limits),
      now,
      now,
    );
}

export function readStageExecution(
  db: StateDatabase,
  runId: string,
): StageExecutionRow | undefined {
  const row = internalHandle(db)
    .prepare(`SELECT ${EXECUTION_COLUMNS} FROM stage_execution WHERE run_id = ?`)
    .get(runId);
  return row === undefined ? undefined : executionRow(row);
}

export function readActiveStageExecutions(db: StateDatabase): readonly StageExecutionRow[] {
  return internalHandle(db)
    .prepare(
      `SELECT ${EXECUTION_COLUMNS} FROM stage_execution
        WHERE status NOT IN ('succeeded','failed','cancelled')
        ORDER BY run_id`,
    )
    .all()
    .map((row) => executionRow(row));
}

export function assignBackendExecution(
  db: StateDatabase,
  runId: string,
  backendExecutionId: string,
): void {
  const existing = readStageExecution(db, runId);
  if (existing === undefined) throw new StateStoreError(`stage execution does not exist: ${runId}`);
  if (existing.backendExecutionId !== null && existing.backendExecutionId !== backendExecutionId) {
    throw new StateStoreError(`stage execution already has a different backend handle: ${runId}`);
  }
  internalHandle(db)
    .prepare(
      `UPDATE stage_execution
          SET backend_execution_id = ?, updated_at = ?
        WHERE run_id = ?`,
    )
    .run(backendExecutionId, internalClock(db).nowIso(), runId);
}

export function updateStageExecutionStatus(
  db: StateDatabase,
  runId: string,
  status: ExecutionStatus,
  details: { readonly summary?: string; readonly sessionId?: string; readonly error?: string } = {},
): void {
  const run = readRunProjection(db, runId);
  if (run === undefined) throw new StateStoreError(`run does not exist: ${runId}`);
  if (run.status !== status) {
    commitStateChange(db, {
      runId,
      type: "run.status_changed",
      payload: { runId, status },
    });
  }
  internalHandle(db)
    .prepare(
      `UPDATE stage_execution
          SET status = ?, summary = COALESCE(?, summary), session_id = COALESCE(?, session_id),
              error = COALESCE(?, error), updated_at = ?
        WHERE run_id = ?`,
    )
    .run(
      status,
      details.summary ?? null,
      details.sessionId ?? null,
      details.error ?? null,
      internalClock(db).nowIso(),
      runId,
    );
}

export function replacePendingInteractions(
  db: StateDatabase,
  runId: string,
  interactions: readonly Static<typeof PendingInteractionV2>[],
): void {
  synchronizePendingInteractions(db, runId, interactions);
}

export function readPendingInteractions(
  db: StateDatabase,
  runId: string,
): readonly Static<typeof PendingInteractionV2>[] {
  return readLegacyPendingInteractions(db, runId);
}

export function recordInteractionAnswer(
  db: StateDatabase,
  runId: string,
  answer: Static<typeof InteractionAnswerSetV1>,
): void {
  const accepted = acceptInteractionAnswer(
    db,
    runId,
    legacyAnswerSubmission(db, runId, answer),
    "legacy-internal",
  );
  markExecutionOperationDelivered(db, accepted.operationId);
}

export function markArtifactImport(
  db: StateDatabase,
  input:
    | {
        readonly runId: string;
        readonly backendArtifactId: string;
        readonly artifactId?: ArtifactId;
        readonly contentHash: string;
        readonly byteLength: number;
        readonly state: "pending";
      }
    | {
        readonly runId: string;
        readonly backendArtifactId: string;
        readonly artifactId: ArtifactId;
        readonly contentHash: string;
        readonly byteLength: number;
        readonly state: "completed";
      },
): void {
  internalHandle(db)
    .prepare(
      `INSERT INTO backend_artifact_import (
         run_id, backend_artifact_id, artifact_id, content_hash, byte_length, state, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, backend_artifact_id) DO UPDATE SET
         artifact_id = excluded.artifact_id,
         content_hash = excluded.content_hash,
         byte_length = excluded.byte_length,
         state = excluded.state,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.runId,
      input.backendArtifactId,
      input.artifactId ?? null,
      input.contentHash,
      input.byteLength,
      input.state,
      internalClock(db).nowIso(),
    );
}

export function completePendingArtifactImports(db: StateDatabase, runId: string): number {
  const report = internalHandle(db)
    .prepare(
      `UPDATE backend_artifact_import
          SET artifact_id = (
                SELECT artifact.artifact_id
                  FROM artifact
                 WHERE artifact.run_id = backend_artifact_import.run_id
                   AND artifact.content_hash = backend_artifact_import.content_hash
                   AND artifact.byte_length = backend_artifact_import.byte_length
                 ORDER BY artifact.artifact_id
                 LIMIT 1
              ),
              state = 'completed',
              updated_at = ?
        WHERE run_id = ?
          AND state = 'pending'
          AND EXISTS (
                SELECT 1
                  FROM artifact
                 WHERE artifact.run_id = backend_artifact_import.run_id
                   AND artifact.content_hash = backend_artifact_import.content_hash
                   AND artifact.byte_length = backend_artifact_import.byte_length
              )`,
    )
    .run(internalClock(db).nowIso(), runId);
  return Number(report.changes);
}

/**
 * Finalization is one-shot.
 *
 * Until Q023 the `WHERE` clause was `run_id = ?` alone, with no `finalized`
 * guard and no `changes` assertion — last writer wins. Two completions for
 * the same run silently overwrote each other, so a run that had already been
 * reported `succeeded` could be rewritten to `failed` (or the reverse) with
 * nothing anywhere recording that it happened. That is not a hypothetical
 * ordering: `observe`'s catch block finalizes as `failed` when
 * `finalizeSuccess` throws, and `finalizeSuccess` finalizes as `succeeded`
 * before its last statements run.
 *
 * `finalized = 0` in the `WHERE` makes the guard atomic rather than a
 * read-then-write, and the `changes` assertion turns the second attempt into
 * a loud typed error at the exact call that made it. The bridge's submit
 * path leans on this as its backstop, but the hole predates the bridge and
 * the guard belongs here regardless.
 */
export function markExecutionFinalized(
  db: StateDatabase,
  runId: string,
  details: {
    readonly status: "succeeded" | "failed" | "cancelled";
    readonly summary: string;
    readonly sessionId?: string;
    readonly error?: string;
  },
): void {
  const report = internalHandle(db)
    .prepare(
      `UPDATE stage_execution
          SET status = ?, summary = ?, session_id = ?, error = ?, finalized = 1, updated_at = ?
        WHERE run_id = ?
          AND finalized = 0`,
    )
    .run(
      details.status,
      details.summary,
      details.sessionId ?? null,
      details.error ?? null,
      internalClock(db).nowIso(),
      runId,
    );
  if (toSafeInteger(report.changes, "stage execution changes") !== 1) {
    throw new StateStoreError(
      `stage execution is already finalized or missing: ${runId} (attempted ${details.status})`,
    );
  }
}

export function readArtifactRecord(
  db: StateDatabase,
  artifactId: string,
): ArtifactRecord | undefined {
  const row = internalHandle(db)
    .prepare(
      `SELECT artifact_id, run_id, stage_id, name, content_hash, byte_length, media_type,
              relative_path
         FROM artifact WHERE artifact_id = ?`,
    )
    .get(artifactId);
  if (row === undefined) return undefined;
  return {
    artifactId: toText(row.artifact_id, "artifact.artifact_id") as ArtifactId,
    runId: toText(row.run_id, "artifact.run_id"),
    stageId: toText(row.stage_id, "artifact.stage_id"),
    name: toText(row.name, "artifact.name"),
    contentHash: toText(row.content_hash, "artifact.content_hash"),
    byteLength: toSafeInteger(row.byte_length, "artifact.byte_length"),
    mediaType: toText(row.media_type, "artifact.media_type"),
    relativePath: toText(row.relative_path, "artifact.relative_path"),
  };
}

export function readStageArtifacts(db: StateDatabase, runId: string): readonly ArtifactRecord[] {
  return internalHandle(db)
    .prepare(
      `SELECT a.artifact_id, a.run_id, a.stage_id, a.name, a.content_hash, a.byte_length,
              a.media_type, a.relative_path
         FROM stage_artifact_alias alias
         JOIN artifact a ON a.artifact_id = alias.artifact_id
        WHERE alias.run_id = ?
        ORDER BY alias.name`,
    )
    .all(runId)
    .map((row) => ({
      artifactId: toText(row.artifact_id, "artifact.artifact_id") as ArtifactId,
      runId: toText(row.run_id, "artifact.run_id"),
      stageId: toText(row.stage_id, "artifact.stage_id"),
      name: toText(row.name, "artifact.name"),
      contentHash: toText(row.content_hash, "artifact.content_hash"),
      byteLength: toSafeInteger(row.byte_length, "artifact.byte_length"),
      mediaType: toText(row.media_type, "artifact.media_type"),
      relativePath: toText(row.relative_path, "artifact.relative_path"),
    }));
}

export function executionCleanupCounts(db: StateDatabase): {
  readonly missingHandles: number;
  readonly partialImports: number;
  readonly terminalUnfinalized: number;
  readonly expiredActiveLeases: number;
  readonly terminalActiveLeases: number;
} {
  const row = internalHandle(db)
    .prepare(
      `SELECT
         (SELECT count(*) FROM stage_execution
           WHERE status NOT IN ('succeeded','failed','cancelled') AND backend_execution_id IS NULL)
           AS missing_handles,
         (SELECT count(*) FROM backend_artifact_import WHERE state = 'pending') AS partial_imports,
         (SELECT count(*) FROM stage_execution
           WHERE status IN ('succeeded','failed','cancelled') AND finalized = 0) AS terminal_unfinalized,
         (SELECT count(*) FROM workspace_lease
           WHERE lease_state = 'active' AND expires_at <= ?) AS expired_active_leases,
         (SELECT count(*) FROM stage_execution e
           JOIN workspace w ON w.workspace_id = e.workspace_id
           JOIN workspace_lease l ON l.checkout_path = w.checkout_path
          WHERE e.status IN ('succeeded','failed','cancelled') AND l.lease_state = 'active')
           AS terminal_active_leases`,
    )
    .get(internalClock(db).nowIso());
  if (row === undefined) throw new StateDatabaseCorruptionError("cleanup query returned no row");
  return {
    missingHandles: toSafeInteger(row.missing_handles, "cleanup.missing_handles"),
    partialImports: toSafeInteger(row.partial_imports, "cleanup.partial_imports"),
    terminalUnfinalized: toSafeInteger(row.terminal_unfinalized, "cleanup.terminal_unfinalized"),
    expiredActiveLeases: toSafeInteger(row.expired_active_leases, "cleanup.expired_active_leases"),
    terminalActiveLeases: toSafeInteger(
      row.terminal_active_leases,
      "cleanup.terminal_active_leases",
    ),
  };
}
