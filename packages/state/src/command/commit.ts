/**
 * `commitStateChange` — the package's **only** mutation path (design D10;
 * plan Task 4.4).
 *
 * This is what closes AC2's structural claim: there is no exported way to
 * reach a projection table except through the unit that writes the causative
 * event first, in the same transaction. The schema's guard triggers enforce
 * the causal shape against any writer; this function is the only writer the
 * package offers.
 *
 * **Deliberately not implemented** (D10's rejections): exporting the handle
 * "for advanced use"; a `withTransaction(db, fn)` callback (inside `fn` the
 * caller has exactly the unconstrained write access the FKs and triggers
 * exist to prevent); batching several events per transaction (§16.6's atomic
 * pair is one event plus one projection update — a batch API is additive
 * later, and designing multi-event causality semantics with no consumer to
 * constrain them is guesswork).
 */

import {
  internalClock,
  internalHandle,
  internalIds,
  type StateDatabase,
} from "../database/open.js";
import { toSafeInteger } from "../database/pragma.js";
import { CausalityViolationError, StateStoreError } from "../errors.js";
import { appendEvent } from "../journal/append.js";
import { asCorrelationId } from "../journal/brand.js";
import type { CausationEventId, CorrelationId, EventId, EventSequence } from "../journal/event.js";
import { readEventById } from "../journal/read.js";
import type { JsonValue } from "../json.js";
import { applyEvent, eventScope } from "../projection/reducer.js";
import {
  diffProjectionState,
  loadScopedProjectionState,
  type ProjectionTable,
  type ProjectionWrite,
} from "../projection/state.js";

export interface StateCommand {
  /**
   * `?:`, not `: string | null` (finding C5) — omit for the three identity
   * commands; every `run.*` command supplies it.
   */
  readonly runId?: string;
  readonly type: string;
  readonly payload: JsonValue;
  /** Absent ⇒ this event roots a new causal chain and mints a correlation id. */
  readonly causationEventId?: CausationEventId;
}

export interface CommitReport {
  readonly eventId: EventId;
  readonly sequence: EventSequence;
  readonly correlationId: CorrelationId;
  /** The revision of the primary row this command advanced. */
  readonly revision: number;
  readonly writes: readonly {
    readonly table: ProjectionTable;
    readonly key: string;
    readonly revision: number;
  }[];
  /**
   * When the command unit finished its work, from the second clock read
   * (round-1 CRIT-02). This is a real production fact, not a test-only seam:
   * the read sits exactly at C2's boundary — the event row exists, the
   * projection row does not yet — which is where the boundary and crash
   * suites inject a clock that throws, but the value itself is reported
   * rather than written into any projection row.
   */
  readonly committedAt: string;
}

/**
 * A fixed literal map, never string concatenation of a runtime value. The
 * column list per table is likewise a literal (finding MIN-10): `row`'s keys
 * are same-origin — produced by this package's own reducer, never caller
 * input — so building the list from them would not be a vulnerability, but
 * pinning it here keeps the one string-built SQL path in this function
 * auditable at a glance. A reviewer can read every column name these
 * statements can ever emit without first having to prove `row` is trustworthy.
 */
interface TableSql {
  readonly insert: string;
  readonly update: string;
  /** Bound-parameter order for `insert`, and for `update`'s SET clause. */
  readonly insertColumns: readonly string[];
  readonly updateColumns: readonly string[];
}

const TABLE_SQL: Readonly<Record<ProjectionTable, TableSql>> = {
  run_projection: {
    insert:
      "INSERT INTO run_projection" +
      " (run_id, status, revision, last_event_sequence, codebase_id, updated_at, workspace_id)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?)",
    insertColumns: [
      "run_id",
      "status",
      "revision",
      "last_event_sequence",
      "codebase_id",
      "updated_at",
      "workspace_id",
    ],
    update:
      "UPDATE run_projection SET status = ?, revision = ?, last_event_sequence = ?," +
      " codebase_id = ?, updated_at = ?, workspace_id = ? WHERE run_id = ? AND revision = ?",
    updateColumns: [
      "status",
      "revision",
      "last_event_sequence",
      "codebase_id",
      "updated_at",
      "workspace_id",
    ],
  },
  codebase: {
    insert:
      "INSERT INTO codebase (codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, ?, ?, ?)",
    insertColumns: ["codebase_id", "revision", "last_event_sequence", "updated_at"],
    update:
      "UPDATE codebase SET revision = ?, last_event_sequence = ?, updated_at = ?" +
      " WHERE codebase_id = ? AND revision = ?",
    updateColumns: ["revision", "last_event_sequence", "updated_at"],
  },
  repository: {
    insert:
      "INSERT INTO repository (repository_id, codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, ?, ?, ?, ?)",
    insertColumns: [
      "repository_id",
      "codebase_id",
      "revision",
      "last_event_sequence",
      "updated_at",
    ],
    update:
      "UPDATE repository SET codebase_id = ?, revision = ?, last_event_sequence = ?, updated_at = ?" +
      " WHERE repository_id = ? AND revision = ?",
    updateColumns: ["codebase_id", "revision", "last_event_sequence", "updated_at"],
  },
  workspace: {
    insert:
      "INSERT INTO workspace (workspace_id, codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, ?, ?, ?, ?)",
    insertColumns: ["workspace_id", "codebase_id", "revision", "last_event_sequence", "updated_at"],
    update:
      "UPDATE workspace SET codebase_id = ?, revision = ?, last_event_sequence = ?, updated_at = ?" +
      " WHERE workspace_id = ? AND revision = ?",
    updateColumns: ["codebase_id", "revision", "last_event_sequence", "updated_at"],
  },
};

function boundValues(
  write: ProjectionWrite,
  columns: readonly string[],
): readonly (string | number | null)[] {
  return columns.map((column) => {
    const value = write.row[column];
    if (value === undefined) {
      // The reducer built `row` from the same literal column set above, so
      // this is unreachable short of the two drifting apart — which is
      // precisely the drift worth failing loudly on rather than binding a
      // silent NULL into a NOT NULL column.
      throw new StateStoreError(
        `commitStateChange: projection row for ${write.table} is missing column ${column}`,
      );
    }
    return value;
  });
}

function writtenRevision(write: ProjectionWrite): number {
  const value = write.row.revision;
  if (typeof value !== "number") {
    throw new StateStoreError(
      `commitStateChange: projection row for ${write.table} has a non-numeric revision`,
    );
  }
  return value;
}

export function commitStateChange(db: StateDatabase, command: StateCommand): CommitReport {
  const handle = internalHandle(db);

  // Step 1 — refuse a caller-opened transaction. A nested BEGIN throws
  // "cannot start a transaction within a transaction"; this makes it a typed
  // error rather than a raw one (V8).
  if (handle.isTransaction) {
    throw new StateStoreError(
      "commitStateChange: refusing to run inside a transaction opened by the caller",
    );
  }

  // Step 2 — BEGIN IMMEDIATE, never a deferred BEGIN. A deferred BEGIN
  // succeeds and then fails on the first write with SQLITE_BUSY, after the
  // caller has done work, at a statement unrelated to the real cause (V10).
  handle.exec("BEGIN IMMEDIATE");

  try {
    // Step 3 — resolve the correlation id. A caller can never supply one:
    // D6's propagation rule is executed, not documented.
    let correlationId: CorrelationId;
    if (command.causationEventId === undefined) {
      correlationId = asCorrelationId(internalIds(db).next("cor"));
    } else {
      const parent = readEventById(db, command.causationEventId);
      if (parent === undefined) {
        throw new CausalityViolationError(
          `commitStateChange: causation event does not exist: ${command.causationEventId}`,
        );
      }
      correlationId = parent.correlationId;
    }

    // Step 4 — clock call 1 (P1).
    const recordedAt = internalClock(db).nowIso();

    // Step 5 — the conditional spread is required under
    // `exactOptionalPropertyTypes`: a caller-omitted `runId` must stay
    // omitted all the way to the bound SQL parameter (finding C5).
    const event = appendEvent(db, {
      ...(command.runId !== undefined ? { runId: command.runId } : {}),
      type: command.type,
      payload: command.payload,
      correlationId,
      causationEventId: command.causationEventId ?? null,
      recordedAt,
    });

    // Step 6 — clock call 2 (P1). Reported, never written to a projection row.
    const committedAt = internalClock(db).nowIso();

    // Steps 7-8 — read inside this transaction, then fold with the same pure
    // reducer replay uses. No post-processing of the reducer's output:
    // `applyEvent` already set `updatedAt: event.recordedAt`, and that is the
    // value that reaches storage unmodified. There is no "substitute
    // updatedAt" step; do not add one.
    const before = loadScopedProjectionState(db, eventScope(event));
    const after = applyEvent(before, event);

    // Step 9 — explicit INSERT or UPDATE, never an upsert (V9).
    const writes = diffProjectionState(before, after);
    const reported: { table: ProjectionTable; key: string; revision: number }[] = [];
    for (const write of writes) {
      const sql = TABLE_SQL[write.table];
      const revision = writtenRevision(write);
      if (write.previousRevision === null) {
        handle.prepare(sql.insert).run(...boundValues(write, sql.insertColumns));
      } else {
        const result = handle
          .prepare(sql.update)
          .run(...boundValues(write, sql.updateColumns), write.key, write.previousRevision);
        // The optimistic-concurrency check, free from the WHERE clause: zero
        // rows changed means the stored revision was not the one the reducer
        // read, so someone else advanced this row concurrently.
        if (toSafeInteger(result.changes, "projection update changes") !== 1) {
          throw new CausalityViolationError(
            `commitStateChange: projection row ${write.table}/${write.key} was not at revision ` +
              `${write.previousRevision}`,
          );
        }
      }
      reported.push({ table: write.table, key: write.key, revision });
    }

    // Step 10.
    handle.exec("COMMIT");

    // Step 11.
    const primary = reported[0];
    return {
      eventId: event.eventId,
      sequence: event.sequence,
      correlationId,
      revision: primary?.revision ?? 0,
      writes: reported,
      committedAt,
    };
  } catch (error) {
    // Step 12 — guarded, because RAISE(ABORT) rolls back only the *statement*
    // and leaves the transaction open (V7), while an unguarded ROLLBACK with
    // no active transaction throws its own error that would mask the real one
    // (V8). Rethrow unchanged.
    if (handle.isTransaction) {
      handle.exec("ROLLBACK");
    }
    throw error;
  }
}
