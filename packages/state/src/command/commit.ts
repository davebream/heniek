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
import {
  ArtifactCountExceededError,
  CausalityViolationError,
  StageAssertionFailedError,
  StateStoreError,
} from "../errors.js";
import { appendEvent } from "../journal/append.js";
import { asCorrelationId } from "../journal/brand.js";
import type { CausationEventId, CorrelationId, EventId, EventSequence } from "../journal/event.js";
import { readEventById } from "../journal/read.js";
import type { JsonValue } from "../json.js";
import { applyEvent, eventScope } from "../projection/reducer.js";
import {
  diffProjectionState,
  loadScopedProjectionState,
  type ProjectionState,
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
  /**
   * The revision of the primary row this command advanced.
   *
   * **Unspecified for an event that writes more than one table** (today,
   * only `stage.completed` — it writes an `artifact` row per published ref
   * plus the `stage_artifact_alias` row that re-points that name). This
   * field is `reported[0]?.revision`, i.e. the revision of whichever write
   * `TABLE_ORDER` sorts first among the writes this command produced —
   * `artifact` sorts before `stage_artifact_alias`, so for `stage.completed`
   * today it always reports the new `artifact` row's revision, which is
   * always `1`, regardless of which row a caller might actually care about.
   * Callers that need a specific table's revision should read `writes`
   * instead, which reports every table this command touched by name.
   * Phase 4's `primaryTable` work (design open item, plan Task 4.1) makes
   * this field precise by letting each event type declare which table's
   * revision it means — not implemented here.
   */
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
 * I6 — the per-`completeStage` artifact-count cap (plan Task 4.2). Enforced
 * purely and pre-lock, in `commitStateChangeInternal`, against
 * `options.artifactRelativePaths.length`. Reconciled against
 * `journal/append.ts`'s 64 KiB event-payload cap (`MAX_PAYLOAD_BYTES`): the
 * two caps are not independent — a realistic `ArtifactRefV1` row makes the
 * byte cap bind well before 64 artifacts — but this cap exists so the fd
 * high-water mark and the under-lock `fstat`/`lstat` count (S2) stay
 * contract-bounded rather than bounded only by whichever artifact shape
 * happens to fill 64 KiB first.
 */
export const MAX_ARTIFACTS_PER_COMMAND = 64;

/**
 * The two tables Q007 adds that must never be reachable from the public
 * `commitStateChange` entry point without a verified publication assertion
 * (AC-1 unbypassability). Derived from `ProjectionTable` — a closed union
 * this module already exhaustively switches on in `TABLE_SQL`, not a
 * caller-suppliable string — so `assertGuardedWritesAreVerified` below
 * refuses *any* write that lands in one of these tables, regardless of which
 * `event.type` produced it. `StateCommand.type` is an unconstrained
 * `string`; keying the guard on it instead would be a blacklist a future
 * seventh event type could silently reopen. Keying it on the table a write
 * actually touches cannot be reopened that way: a new event type that
 * writes into `artifact`/`stage_artifact_alias` is caught automatically,
 * and a genuinely new table would require an explicit edit to this set.
 */
const ARTIFACT_GUARDED_TABLES: ReadonlySet<ProjectionTable> = new Set<ProjectionTable>([
  "artifact",
  "stage_artifact_alias",
]);

/**
 * One filesystem assertion `completeStage` (`artifact/complete-stage.ts`)
 * attaches to a `stage.completed` command. `relativePath` is the exact
 * value the corresponding `artifact` row's `relative_path` (or, for a
 * `stage_artifact_alias` write, the aliased artifact's own `relative_path`)
 * will carry — matching between a write and its assertion is always by this
 * value, **never by array position** (S3): a length- or index-based pairing
 * would accept a payload `[A, B]` paired with `[assert(B), assert(A)]`
 * silently swapped, where each individual `assert()` call still succeeds
 * (both blobs genuinely exist) while validating a blob the row it is paired
 * with does not actually record.
 */
export interface StageArtifactAssertion {
  readonly relativePath: string;
  /**
   * Executed under the write lock (`BEGIN IMMEDIATE` already holds it),
   * after every projection row this command produces has been written and
   * immediately before `COMMIT` (S2). Throws `StageAssertionFailedError` on
   * failure — the surrounding transaction rolls back, so the event row and
   * every projection row this command would have written land together or
   * not at all.
   */
  readonly assert: () => void;
}

export interface CommitStateChangeInternalOptions {
  /**
   * Which write's revision `CommitReport.revision` reports (Task 4.1's
   * `TABLE_ORDER`/`reported[0]` fix). Omitted ⇒ the pre-Q007 default,
   * `reported[0]?.revision` (`TABLE_ORDER`-first) — unchanged for
   * `commitStateChange` and any caller that does not pass it.
   */
  readonly primaryTable?: ProjectionTable;
  /**
   * The exact multiset of `blobs/sha256/<hex>` relative paths this
   * command's payload references. Supplied by the caller (`completeStage`)
   * rather than re-derived by parsing `command.payload` here, which would
   * duplicate the reducer's own payload-narrowing (`toArtifactRefPayload`).
   * Must be a bijection against `assertions`' own `relativePath`s (S3,
   * checked purely, before `BEGIN IMMEDIATE`) **and** — inside the
   * transaction, once the real writes are known — every write this command
   * actually produces into a `ARTIFACT_GUARDED_TABLES` table must name a
   * `relativePath` present here (the AC-1 structural guard). The second
   * check is what stops a caller from declaring a matching-but-fake
   * assertion set while the real payload writes something else.
   */
  readonly artifactRelativePaths?: readonly string[];
  /** S2 — filesystem assertions, executed under the write lock, immediately before `COMMIT`. */
  readonly assertions?: readonly StageArtifactAssertion[];
}

/**
 * S3 — pure, pre-lock bijection check between `artifactRelativePaths` and
 * `assertions`' own relative paths. Multiset equality, not array-order
 * equality: a legitimate payload can cite the same content twice under two
 * different names (content-addressed dedup), and reordering the assertions
 * relative to the payload must never matter — only *which* relative paths
 * are asserted, and how many times each, matters.
 */
function assertBijection(
  artifactRelativePaths: readonly string[],
  assertions: readonly StageArtifactAssertion[],
): void {
  if (artifactRelativePaths.length !== assertions.length) {
    throw new StageAssertionFailedError(
      "<multiple>",
      `expected exactly one assertion per payload artifact: ${artifactRelativePaths.length} ` +
        `artifact(s), ${assertions.length} assertion(s)`,
    );
  }
  const remaining = new Map<string, number>();
  for (const relativePath of artifactRelativePaths) {
    remaining.set(relativePath, (remaining.get(relativePath) ?? 0) + 1);
  }
  for (const assertion of assertions) {
    const count = remaining.get(assertion.relativePath) ?? 0;
    if (count === 0) {
      throw new StageAssertionFailedError(
        assertion.relativePath,
        "assertion does not correspond to any payload artifact (S3 bijection)",
      );
    }
    remaining.set(assertion.relativePath, count - 1);
  }
}

/**
 * AC-1's structural unbypassability, enforced inside the transaction once
 * the reducer's real output (`writes`) is known. Every write into an
 * `ARTIFACT_GUARDED_TABLES` table must name a `relativePath` present in
 * `assertedRelativePaths` — `commitStateChange` (public) always calls this
 * with an empty set, so *any* write into either table is refused,
 * regardless of which event type produced it (see `ARTIFACT_GUARDED_TABLES`'s
 * own docblock for why this is structural rather than a type-string
 * blacklist).
 */
function assertGuardedWritesAreVerified(
  writes: readonly ProjectionWrite[],
  after: ProjectionState,
  assertedRelativePaths: ReadonlySet<string>,
): void {
  for (const write of writes) {
    if (!ARTIFACT_GUARDED_TABLES.has(write.table)) {
      continue;
    }
    if (write.table === "artifact") {
      const relativePath = write.row.relative_path;
      if (typeof relativePath !== "string" || !assertedRelativePaths.has(relativePath)) {
        throw new StageAssertionFailedError(
          typeof relativePath === "string" ? relativePath : "<unknown>",
          "writing an artifact row requires a verified publication assertion for its relativePath " +
            "— use completeStage, not commitStateChange, to write this table",
        );
      }
      continue;
    }
    // write.table === "stage_artifact_alias": there is no relativePath on
    // the alias row itself — it points at an artifact_id. `after.artifacts`
    // carries that artifact's own row regardless of whether this command
    // just inserted it or adopted an already-existing one (F2), since
    // `eventScope`'s `artifacts` scope always includes every ref's
    // `artifactId`.
    const artifactId = write.row.artifact_id;
    const artifactState = typeof artifactId === "string" ? after.artifacts[artifactId] : undefined;
    if (artifactState === undefined || !assertedRelativePaths.has(artifactState.relativePath)) {
      throw new StageAssertionFailedError(
        artifactState?.relativePath ?? "<unknown>",
        "writing a stage_artifact_alias row requires a verified publication assertion for its " +
          "artifact's relativePath — use completeStage, not commitStateChange, to write this table",
      );
    }
  }
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
  /**
   * Column names bound, in order, into `update`'s `WHERE` clause ahead of
   * `revision` — read from `write.row`, not from `write.key` (issue #8,
   * Phase 2 fix cycle G1, F5). Every other table has a single-column primary
   * key, where `write.key` and `write.row[keyColumn]` are the same value;
   * `stage_artifact_alias`'s primary key is the composite `(run_id,
   * stage_id, name)`, and `write.key` there is only
   * `stageArtifactAliasKey`'s U+0000-joined map key, not a column any table
   * actually has. Binding the three columns separately — rather than
   * comparing a `run_id || char(0) || stage_id || char(0) || name`
   * expression against that joined string — lets SQLite use the composite
   * primary-key index for the `WHERE` clause, and removes the one place this
   * package built part of a SQL comparison by string-joining caller-derived
   * values instead of binding them as separate parameters.
   */
  readonly updateKeyColumns: readonly string[];
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
    updateKeyColumns: ["run_id"],
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
    updateKeyColumns: ["codebase_id"],
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
    updateKeyColumns: ["repository_id"],
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
    updateKeyColumns: ["workspace_id"],
  },
  artifact: {
    insert:
      "INSERT INTO artifact" +
      " (artifact_id, run_id, stage_id, name, content_hash, byte_length, media_type," +
      " content_schema_id, producer, source_lineage, relative_path, created_at, revision," +
      " last_event_sequence)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    insertColumns: [
      "artifact_id",
      "run_id",
      "stage_id",
      "name",
      "content_hash",
      "byte_length",
      "media_type",
      "content_schema_id",
      "producer",
      "source_lineage",
      "relative_path",
      "created_at",
      "revision",
      "last_event_sequence",
    ],
    // `artifact` carries no `*_causal_update` trigger (migration 4, design
    // D11a) — a row is written once and never updated again, so
    // `diffProjectionState` never takes this branch for this table in
    // practice (`ARTIFACT_VIEW`'s `revisionOf` is always 1, and a key
    // already present in `before` is always identical in `after`). Kept
    // syntactically real, not a placeholder string, so a future regression
    // that *did* reach this branch would fail loudly against the
    // `artifact_immutable_update` trigger's `RAISE(ABORT)` rather than a SQL
    // syntax error.
    update:
      "UPDATE artifact SET revision = ?, last_event_sequence = ? WHERE artifact_id = ? AND revision = ?",
    updateColumns: ["revision", "last_event_sequence"],
    updateKeyColumns: ["artifact_id"],
  },
  stage_artifact_alias: {
    insert:
      "INSERT INTO stage_artifact_alias" +
      " (run_id, stage_id, name, artifact_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?)",
    insertColumns: [
      "run_id",
      "stage_id",
      "name",
      "artifact_id",
      "revision",
      "last_event_sequence",
      "updated_at",
    ],
    // The composite primary key means `write.key` (from
    // `stageArtifactAliasKey`, U+0000-joined) is not itself a column value —
    // it is bound nowhere in this statement. `updateKeyColumns` below carries
    // `run_id`/`stage_id`/`name` instead, read straight out of `write.row`
    // (issue #8, Phase 2 fix cycle G1, F5): binding the three columns
    // separately, rather than comparing a `run_id || char(0) || stage_id ||
    // char(0) || name` expression against the joined `write.key` string,
    // lets SQLite use the `(run_id, stage_id, name)` primary-key index
    // directly for this WHERE clause.
    update:
      "UPDATE stage_artifact_alias SET artifact_id = ?, revision = ?, last_event_sequence = ?," +
      " updated_at = ? WHERE run_id = ? AND stage_id = ? AND name = ? AND revision = ?",
    updateColumns: ["artifact_id", "revision", "last_event_sequence", "updated_at"],
    updateKeyColumns: ["run_id", "stage_id", "name"],
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

/**
 * `commitStateChange` delegates here with every option at its default, so
 * its own behaviour and public signature are exactly unchanged by this
 * function's existence (design D4, plan Task 4.1).
 *
 * INTERNAL — exported from this module but **not** from `src/index.ts`
 * (design D1/D9's package-private-by-construction discipline, mirroring
 * `openStateDatabaseInternal`/`createArtifactStoreInternal`). The only
 * production caller is `completeStage` (`artifact/complete-stage.ts`);
 * everything else reaches this package only through `commitStateChange`.
 */
export function commitStateChangeInternal(
  db: StateDatabase,
  command: StateCommand,
  options: CommitStateChangeInternalOptions,
): CommitReport {
  const handle = internalHandle(db);
  const artifactRelativePaths = options.artifactRelativePaths ?? [];
  const assertions = options.assertions ?? [];

  // Step 1 — refuse a caller-opened transaction. A nested BEGIN throws
  // "cannot start a transaction within a transaction"; this makes it a typed
  // error rather than a raw one (V8).
  if (handle.isTransaction) {
    throw new StateStoreError(
      "commitStateChange: refusing to run inside a transaction opened by the caller",
    );
  }

  // Step 1b (S3) — pure, pre-lock bijection check between the declared
  // payload artifacts and their assertions. Sits next to the caller-
  // transaction refusal above, before BEGIN IMMEDIATE, so a malformed call
  // never takes the RESERVED lock and burns a concurrent writer against the
  // 5 s busy timeout (`database/open.ts:320`).
  assertBijection(artifactRelativePaths, assertions);

  // Step 1c (I6) — also pure, also pre-lock: the per-command artifact-count
  // cap, so the fd high-water mark and the under-lock fstat/lstat count (S2)
  // below stay contract-bounded.
  if (artifactRelativePaths.length > MAX_ARTIFACTS_PER_COMMAND) {
    throw new ArtifactCountExceededError(artifactRelativePaths.length, MAX_ARTIFACTS_PER_COMMAND);
  }

  const assertedRelativePaths = new Set(artifactRelativePaths);

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

    // Step 9b (AC-1) — the structural guard: refuse, before writing a
    // single row, any write this command produces that lands in a Q007
    // guarded table without a matching verified assertion. Runs for every
    // call, including `commitStateChange`'s own (empty `assertedRelativePaths`),
    // which is what makes the public path structurally unable to write
    // `artifact`/`stage_artifact_alias` at all.
    assertGuardedWritesAreVerified(writes, after, assertedRelativePaths);

    const reported: { table: ProjectionTable; key: string; revision: number }[] = [];
    for (const write of writes) {
      const sql = TABLE_SQL[write.table];
      const revision = writtenRevision(write);
      if (write.previousRevision === null) {
        handle.prepare(sql.insert).run(...boundValues(write, sql.insertColumns));
      } else {
        const result = handle
          .prepare(sql.update)
          .run(
            ...boundValues(write, sql.updateColumns),
            ...boundValues(write, sql.updateKeyColumns),
            write.previousRevision,
          );
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

    // Step 9c (S2) — every caller-supplied filesystem assertion, run now:
    // after every projection row this command produces has been written,
    // still under the write lock, immediately before COMMIT. This is also
    // the fault-injection seam Task 4.5 exercises — an assertion (or the
    // `ArtifactFileSystem` call it wraps) throwing here is caught below,
    // which rolls back, proving the event row and every projection row this
    // command would have written land together or not at all.
    for (const assertion of assertions) {
      assertion.assert();
    }

    // Step 10.
    handle.exec("COMMIT");

    // Step 11 — `primaryTable`, when supplied, picks a specific write's
    // revision (Task 4.1's `TABLE_ORDER`/`reported[0]` fix) rather than
    // whichever write `TABLE_ORDER` happens to sort first. Omitted ⇒ the
    // pre-Q007 default.
    const primary =
      options.primaryTable !== undefined
        ? reported.find((write) => write.table === options.primaryTable)
        : reported[0];
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

/**
 * `commitStateChange` — the package's **only public** mutation path (design
 * D10; plan Task 4.4). Delegates to `commitStateChangeInternal` with no
 * options, so `artifactRelativePaths`/`assertions` are both empty and
 * `primaryTable` is unset — the pre-Q007 behaviour, byte-for-byte.
 *
 * This is what closes AC-1's structural claim, together with
 * `assertGuardedWritesAreVerified` above: there is no exported way to reach
 * `artifact` or `stage_artifact_alias` except through `completeStage`, which
 * supplies verified assertions for exactly the relative paths its payload
 * references.
 */
export function commitStateChange(db: StateDatabase, command: StateCommand): CommitReport {
  return commitStateChangeInternal(db, command, {});
}
