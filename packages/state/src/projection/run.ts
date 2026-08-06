/**
 * The run projection's row type and named reads (design D8, D10; plan Task
 * 3.4).
 *
 * `RunStatus` is imported from `@heniek/contracts` as **both** a type and a
 * value: `RunStatus.values` is the runtime source `toRunProjectionRow`
 * validates against, and is the concrete runtime use that justifies this
 * package's dependency on `@heniek/contracts` (D1). Note the plan's MIN-02
 * correction — there is no `RunStatusValue` export; `RunStatus` is the union
 * type and the `.values` carrier under one name.
 *
 * Reads are **named functions, not a query escape hatch** (D10). Every
 * "advanced use" imagined so far is a read that belongs here under its own
 * name; adding one later is additive and cheap, whereas an exported
 * `query(sql)` would put every future caller outside the narrowing discipline
 * this module exists to enforce.
 */

import { RunStatus } from "@heniek/contracts";
import { internalHandle, type StateDatabase } from "../database/open.js";
import { toNullableText, toSafeInteger, toText } from "../database/pragma.js";
import { StateDatabaseCorruptionError } from "../errors.js";

export interface RunProjectionRow {
  readonly runId: string;
  /** Narrowed against `RunStatus.values` — never a bare string from the row. */
  readonly status: RunStatus;
  readonly revision: number;
  readonly lastEventSequence: number;
  readonly workspaceId: string | null;
  readonly codebaseId: string;
  readonly updatedAt: string;
  readonly instructionSnapshotSha256: string | null;
  readonly instructionSnapshotJson: string | null;
}

const RUN_PROJECTION_COLUMNS =
  "run_id, status, revision, last_event_sequence, workspace_id, codebase_id, updated_at," +
  " instruction_snapshot_sha256, instruction_snapshot_json";

/**
 * `RunStatus.values` is a `readonly string[]` at the type level, so
 * `.includes(candidate)` type-checks for any string and narrowing needs an
 * explicit predicate rather than a cast.
 */
function isRunStatus(candidate: string): candidate is RunStatus {
  return (RunStatus.values as readonly string[]).includes(candidate);
}

/**
 * The one raw-row → `RunProjectionRow` narrowing. **No `as` on the raw row**:
 * every column routes through `toText`/`toNullableText`/`toSafeInteger`, and
 * `status` additionally has to be a value the contract actually defines.
 *
 * A status outside `RunStatus.values` is `StateDatabaseCorruptionError`, not a
 * generic failure: the column is `TEXT NOT NULL` with no CHECK constraint
 * (the vocabulary lives in `@heniek/contracts`, not in the schema), so the
 * only way an unknown value gets there is a writer that bypassed
 * `commitStateChange` or a database edited out of band — both of which are
 * corruption of exactly the kind this error names.
 */
export function toRunProjectionRow(raw: Record<string, unknown>): RunProjectionRow {
  const status = toText(raw.status, "run_projection.status");
  if (!isRunStatus(status)) {
    throw new StateDatabaseCorruptionError(
      `run_projection.status is not a known RunStatus: ${status}`,
    );
  }
  return {
    runId: toText(raw.run_id, "run_projection.run_id"),
    status,
    revision: toSafeInteger(raw.revision, "run_projection.revision"),
    lastEventSequence: toSafeInteger(raw.last_event_sequence, "run_projection.last_event_sequence"),
    workspaceId: toNullableText(raw.workspace_id, "run_projection.workspace_id"),
    codebaseId: toText(raw.codebase_id, "run_projection.codebase_id"),
    updatedAt: toText(raw.updated_at, "run_projection.updated_at"),
    instructionSnapshotSha256: toNullableText(
      raw.instruction_snapshot_sha256,
      "run_projection.instruction_snapshot_sha256",
    ),
    instructionSnapshotJson: toNullableText(
      raw.instruction_snapshot_json,
      "run_projection.instruction_snapshot_json",
    ),
  };
}

export function readRunProjection(db: StateDatabase, runId: string): RunProjectionRow | undefined {
  const row = internalHandle(db)
    .prepare(`SELECT ${RUN_PROJECTION_COLUMNS} FROM run_projection WHERE run_id = ?`)
    .get(runId);
  return row === undefined ? undefined : toRunProjectionRow(row);
}

export function readAllRunProjections(db: StateDatabase): readonly RunProjectionRow[] {
  const rows = internalHandle(db)
    .prepare(`SELECT ${RUN_PROJECTION_COLUMNS} FROM run_projection ORDER BY run_id`)
    .all();
  return rows.map((row) => toRunProjectionRow(row));
}
