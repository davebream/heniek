/**
 * Raw-SQL constraint suite for the migrated schema (plan Tasks 2.6 and 3.5,
 * design §8 suite 2). Both halves now: the journal's immutability and STRICT
 * constraints, then the projection tables' causal guards. Every case runs raw
 * SQL through `internalHandle` — `commitStateChange` does not exist until
 * Phase 4, and that is the point. AC2 has to be a property the *schema*
 * enforces against any writer, not a promise the command unit keeps.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

/**
 * `node:sqlite` does not type a `SqliteError` class or an `errcode` field
 * (design D17), so a raw SQLite failure is narrowed by hand — mirroring the
 * identical helper in `test/pragma-posture.test.ts` and `src/database/open.ts`.
 */
function sqliteErrorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "errcode" in error) {
    const errcode = (error as { errcode?: unknown }).errcode;
    return typeof errcode === "number" ? errcode : undefined;
  }
  return undefined;
}

function sqliteNodeCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

const SQLITE_CONSTRAINT_TRIGGER = 1811;
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_CHECK = 275;

let directory: string;
let path: string;
let db: StateDatabase;

beforeEach(async () => {
  ({ directory, path } = await makeTempDbPath());
  db = openStateDatabase({ path, clock: createFakeClock(), ids: createDeterministicIds(1) });
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function insertBaseEvent(
  overrides: {
    readonly eventId?: string;
    readonly correlationId?: string;
    readonly causationEventId?: string | null;
    readonly type?: string;
    readonly payload?: string;
  } = {},
): void {
  const handle = internalHandle(db);
  handle
    .prepare(
      "INSERT INTO state_event " +
        "(event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload) " +
        "VALUES (?, NULL, ?, ?, ?, ?, ?)",
    )
    .run(
      overrides.eventId ?? "evt-1",
      overrides.correlationId ?? "cor-1",
      overrides.causationEventId ?? null,
      overrides.type ?? "run.created",
      "2026-01-01T00:00:00.000Z",
      overrides.payload ?? "{}",
    );
}

describe("state_event immutability (design D5)", () => {
  it("raises on UPDATE, verbatim message and pinned errcodes", () => {
    insertBaseEvent();
    const handle = internalHandle(db);
    let caught: unknown;
    try {
      handle.exec("UPDATE state_event SET type = 'changed'");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("state_event is append-only");
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_TRIGGER);
    expect(sqliteNodeCode(caught)).toBe("ERR_SQLITE_ERROR");
  });

  it("raises on DELETE, verbatim message and pinned errcodes", () => {
    insertBaseEvent();
    const handle = internalHandle(db);
    let caught: unknown;
    try {
      handle.exec("DELETE FROM state_event");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("state_event is append-only");
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_TRIGGER);
    expect(sqliteNodeCode(caught)).toBe("ERR_SQLITE_ERROR");
  });

  it("the named, deliberate escape hatch: DROP TRIGGER then UPDATE succeeds (D5) — the layered answer is Phase 5's divergence checker, not the trigger", () => {
    insertBaseEvent();
    const handle = internalHandle(db);
    handle.exec("DROP TRIGGER state_event_immutable_update");
    expect(() => handle.exec("UPDATE state_event SET type = 'changed'")).not.toThrow();
  });

  it("INSERT OR REPLACE conflicting on event_id fires the append-only trigger, only because recursive_triggers is ON (issue #7, Phase 2 fix S1)", () => {
    insertBaseEvent({ eventId: "evt-1" });
    const handle = internalHandle(db);
    let caught: unknown;
    try {
      handle
        .prepare(
          "INSERT OR REPLACE INTO state_event " +
            "(event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload) " +
            "VALUES (?, NULL, ?, NULL, ?, ?, ?)",
        )
        .run("evt-1", "cor-tamper", "run.tampered", "2026-01-01T00:00:00.000Z", "{}");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("state_event is append-only");
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_TRIGGER);
    expect(sqliteNodeCode(caught)).toBe("ERR_SQLITE_ERROR");
  });

  it("REPLACE INTO conflicting on the rowid overwrites the row in place, only prevented because recursive_triggers is ON (issue #7, Phase 2 fix S1)", () => {
    insertBaseEvent({ eventId: "evt-1" });
    const handle = internalHandle(db);
    let caught: unknown;
    try {
      handle
        .prepare(
          "REPLACE INTO state_event " +
            "(sequence, event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload) " +
            "VALUES (1, ?, NULL, ?, NULL, ?, ?, ?)",
        )
        .run("evt-tampered", "cor-tamper", "run.tampered", "2026-01-01T00:00:00.000Z", "{}");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("state_event is append-only");
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_TRIGGER);
    expect(sqliteNodeCode(caught)).toBe("ERR_SQLITE_ERROR");
  });

  it("RAISE(ABORT) inside an explicit transaction rolls back only the aborting statement, leaving the transaction open (G7)", () => {
    insertBaseEvent({ eventId: "evt-1" });
    const handle = internalHandle(db);
    handle.exec("BEGIN");
    let caught: unknown;
    try {
      handle.exec("UPDATE state_event SET type = 'changed'");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("state_event is append-only");
    // The abort undid only the aborting statement — the transaction opened
    // above by BEGIN is still open, and work done before the abort (or after
    // it, within the same transaction) still commits.
    expect(handle.isTransaction).toBe(true);
    insertBaseEvent({ eventId: "evt-2" });
    handle.exec("COMMIT");

    const rows = handle.prepare("SELECT event_id FROM state_event ORDER BY sequence").all();
    expect(rows.map((row) => row.event_id)).toEqual(["evt-1", "evt-2"]);
  });
});

describe("state_event STRICT and CHECK constraints (design D4)", () => {
  it("STRICT rejects a value a non-STRICT table accepts (matched pair, issue #7 fix G2)", () => {
    // The previous version of this test inserted a non-numeric string into
    // `sequence` (`INTEGER PRIMARY KEY`, the rowid alias) — but SQLite
    // rejects a non-integer rowid on *every* table, STRICT or not (rowid
    // enforcement, not the STRICT typing path), so removing `STRICT` from
    // `list.ts` left that test green. This matched pair discriminates for
    // real: the same insert on the same column type succeeds without
    // `STRICT` and fails with it.
    const handle = internalHandle(db);
    handle.exec("CREATE TABLE strict_probe_non_strict (a INTEGER)");
    handle.exec("CREATE TABLE strict_probe_strict (a INTEGER) STRICT");

    expect(() =>
      handle.prepare("INSERT INTO strict_probe_non_strict (a) VALUES (?)").run("x"),
    ).not.toThrow();

    let caught: unknown;
    try {
      handle.prepare("INSERT INTO strict_probe_strict (a) VALUES (?)").run("x");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/cannot store/i);
  });

  it("CHECK (json_valid(payload)) rejects a non-JSON payload", () => {
    let caught: unknown;
    try {
      insertBaseEvent({ payload: "not json" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/CHECK constraint failed/i);
  });

  it("a causation_event_id naming a non-existent event_id fails its foreign key", () => {
    let caught: unknown;
    try {
      insertBaseEvent({ eventId: "evt-orphan", causationEventId: "no-such-event" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/FOREIGN KEY constraint failed/i);
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_FOREIGNKEY);
  });
});

/**
 * Inserts `count` journal events and returns their assigned sequences, in
 * order. Projection rows must cite a real `state_event.sequence` (the FK), so
 * every case below seeds its causative events first.
 */
function seedEvents(count: number): readonly number[] {
  const handle = internalHandle(db);
  const sequences: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    const result = handle
      .prepare(
        "INSERT INTO state_event " +
          "(event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload) " +
          "VALUES (?, NULL, 'cor-1', NULL, 'run.created', '2026-01-01T00:00:00.000Z', '{}')",
      )
      .run(`seed-evt-${index}`);
    sequences.push(Number(result.lastInsertRowid));
  }
  return sequences;
}

/**
 * `seedEvents` returns an array, so destructuring it yields `number |
 * undefined` under `noUncheckedIndexedAccess`. These two wrappers do the
 * narrowing once, with a real check, so no case below needs a non-null
 * assertion (biome's `noNonNullAssertion`) — an assertion would also silently
 * paper over a seeding bug that returned fewer rows than asked for.
 */
function seedOneEvent(): number {
  const [first] = seedEvents(1);
  if (first === undefined) {
    throw new Error("seedOneEvent: expected exactly one seeded event");
  }
  return first;
}

function seedTwoEvents(): { readonly first: number; readonly second: number } {
  const [first, second] = seedEvents(2);
  if (first === undefined || second === undefined) {
    throw new Error("seedTwoEvents: expected exactly two seeded events");
  }
  return { first, second };
}

/**
 * One descriptor per projection table, carrying that table's SQL literally
 * rather than building identifiers by concatenation (V15). The four tables
 * differ in their primary-key column and in which extra columns they carry,
 * so a single parameterised statement would either interpolate identifiers or
 * lie about one of the four — both worse than four explicit strings.
 */
interface ProjectionTable {
  readonly table: string;
  readonly key: string;
  readonly id: string;
  /** Rows this table's foreign keys require before any insert (repository/workspace need a codebase). */
  seedParents(sequence: number): void;
  insertSql: string;
  /**
   * Bound values for `insertSql`, in order: (id, revision, sequence).
   * Typed as the concrete scalar union rather than `unknown[]` so it is
   * assignable to `node:sqlite`'s `SQLInputValue` at the `.run(...)` spread.
   */
  insertValues(revision: number, sequence: number, id?: string): readonly (string | number)[];
  updateSql: string;
  staleUpdateSql: string;
  upsertVariantASql: string;
  upsertVariantBSql: string;
  /**
   * An INSERT whose bound parameter lands in `last_event_sequence`
   * (INTEGER). Binding a non-numeric string there is what STRICT must
   * refuse — `revision` is fixed at 1 so the first-revision trigger stays
   * silent and cannot mask the type error, and `updated_at` is a real
   * timestamp because an INTEGER *is* losslessly convertible to TEXT and
   * would sail straight through.
   */
  wrongTypeSql: string;
}

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function seedCodebase(sequence: number, id = "cb-parent"): void {
  internalHandle(db)
    .prepare(
      "INSERT INTO codebase (codebase_id, revision, last_event_sequence, updated_at) VALUES (?, 1, ?, ?)",
    )
    .run(id, sequence, TIMESTAMP);
}

const ARTIFACT_CONTENT_HASH = "a".repeat(64);

/**
 * `artifact.run_id REFERENCES run_projection(run_id)` (issue #8, Phase 2 fix
 * cycle G1, finding F4): every `seedArtifact` row below cites the same fixed
 * `'run-fixed'` run id (mirroring `repository`/`workspace`'s `'cb-parent'`
 * precedent above), so this seeds that one parent row. Idempotent — guarded
 * by a `SELECT` first — because a single test (the "second INSERT for a new
 * artifact_id succeeds" case) calls `seedArtifact` twice against the same
 * fixed run id, and `run_projection_first_revision` would abort a second raw
 * INSERT for a row that already exists.
 */
function seedRun(sequence: number, id = "run-fixed"): void {
  const handle = internalHandle(db);
  const existing = handle.prepare("SELECT 1 FROM run_projection WHERE run_id = ?").get(id);
  if (existing !== undefined) {
    return;
  }
  handle
    .prepare(
      "INSERT INTO run_projection (run_id, status, revision, last_event_sequence, codebase_id, updated_at)" +
        " VALUES (?, 'queued', 1, ?, 'cb-run-parent', ?)",
    )
    .run(id, sequence, TIMESTAMP);
}

/**
 * `stage_artifact_alias`'s FK parent (Task 2.3): a single, fixed `artifact`
 * row every alias-table case below points at. `run_id`/`stage_id` here are
 * deliberately the same fixed literals `PROJECTION_TABLES`'s
 * `stage_artifact_alias` entry hardcodes into its own SQL (the same pattern
 * `repository`/`workspace` use for `cb-parent`), so this row is always the
 * one the alias rows' own FK resolves to. `seedRun` runs first (F4) — the
 * `artifact.run_id` FK needs that `run_projection` row to exist before this
 * INSERT.
 */
function seedArtifact(sequence: number, id = "artifact-parent"): void {
  seedRun(sequence);
  internalHandle(db)
    .prepare(
      "INSERT INTO artifact (artifact_id, run_id, stage_id, name, content_hash, byte_length," +
        " media_type, content_schema_id, producer, source_lineage, relative_path, created_at," +
        " revision, last_event_sequence)" +
        ` VALUES (?, 'run-fixed', 'stage-fixed', 'artifact-name', '${ARTIFACT_CONTENT_HASH}', 0,` +
        " 'text/plain', 'heniek://contract/Example/v1', 'test-producer', '[]'," +
        ` 'blobs/sha256/${ARTIFACT_CONTENT_HASH}', ?, 1, ?)`,
    )
    .run(id, TIMESTAMP, sequence);
}

const PROJECTION_TABLES: readonly ProjectionTable[] = [
  {
    table: "run_projection",
    key: "run_id",
    id: "run-1",
    seedParents: () => {},
    insertSql:
      "INSERT INTO run_projection (run_id, status, revision, last_event_sequence, codebase_id, updated_at)" +
      " VALUES (?, 'queued', ?, ?, 'cb-1', '2026-01-01T00:00:00.000Z')",
    insertValues: (revision, sequence, id = "run-1") => [id, revision, sequence],
    updateSql: "UPDATE run_projection SET revision = ?, last_event_sequence = ? WHERE run_id = ?",
    staleUpdateSql:
      "UPDATE run_projection SET revision = ?, last_event_sequence = ? WHERE run_id = ? AND revision = ?",
    upsertVariantASql:
      "INSERT INTO run_projection (run_id, status, revision, last_event_sequence, codebase_id, updated_at)" +
      " VALUES (?, 'running', 2, ?, 'cb-1', '2026-01-01T00:00:00.000Z')" +
      " ON CONFLICT(run_id) DO UPDATE SET revision = excluded.revision, status = excluded.status," +
      " last_event_sequence = excluded.last_event_sequence, updated_at = excluded.updated_at",
    upsertVariantBSql:
      "INSERT INTO run_projection (run_id, status, revision, last_event_sequence, codebase_id, updated_at)" +
      " VALUES (?, 'running', 1, ?, 'cb-1', '2026-01-01T00:00:00.000Z')" +
      " ON CONFLICT(run_id) DO UPDATE SET revision = run_projection.revision + 1, status = excluded.status," +
      " last_event_sequence = excluded.last_event_sequence, updated_at = excluded.updated_at",
    wrongTypeSql:
      "INSERT INTO run_projection (run_id, status, revision, last_event_sequence, codebase_id, updated_at)" +
      " VALUES ('run-typed', 'queued', 1, ?, 'cb-1', '2026-01-01T00:00:00.000Z')",
  },
  {
    table: "codebase",
    key: "codebase_id",
    id: "cb-1",
    seedParents: () => {},
    insertSql:
      "INSERT INTO codebase (codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
    insertValues: (revision, sequence, id = "cb-1") => [id, revision, sequence],
    updateSql: "UPDATE codebase SET revision = ?, last_event_sequence = ? WHERE codebase_id = ?",
    staleUpdateSql:
      "UPDATE codebase SET revision = ?, last_event_sequence = ? WHERE codebase_id = ? AND revision = ?",
    upsertVariantASql:
      "INSERT INTO codebase (codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, 2, ?, '2026-01-01T00:00:00.000Z')" +
      " ON CONFLICT(codebase_id) DO UPDATE SET revision = excluded.revision," +
      " last_event_sequence = excluded.last_event_sequence, updated_at = excluded.updated_at",
    upsertVariantBSql:
      "INSERT INTO codebase (codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, 1, ?, '2026-01-01T00:00:00.000Z')" +
      " ON CONFLICT(codebase_id) DO UPDATE SET revision = codebase.revision + 1," +
      " last_event_sequence = excluded.last_event_sequence, updated_at = excluded.updated_at",
    wrongTypeSql:
      "INSERT INTO codebase (codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES ('cb-typed', 1, ?, '2026-01-01T00:00:00.000Z')",
  },
  {
    table: "repository",
    key: "repository_id",
    id: "repo-1",
    seedParents: (sequence) => seedCodebase(sequence),
    insertSql:
      "INSERT INTO repository (repository_id, codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, 'cb-parent', ?, ?, '2026-01-01T00:00:00.000Z')",
    insertValues: (revision, sequence, id = "repo-1") => [id, revision, sequence],
    updateSql:
      "UPDATE repository SET revision = ?, last_event_sequence = ? WHERE repository_id = ?",
    staleUpdateSql:
      "UPDATE repository SET revision = ?, last_event_sequence = ? WHERE repository_id = ? AND revision = ?",
    upsertVariantASql:
      "INSERT INTO repository (repository_id, codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, 'cb-parent', 2, ?, '2026-01-01T00:00:00.000Z')" +
      " ON CONFLICT(repository_id) DO UPDATE SET revision = excluded.revision," +
      " last_event_sequence = excluded.last_event_sequence, updated_at = excluded.updated_at",
    upsertVariantBSql:
      "INSERT INTO repository (repository_id, codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, 'cb-parent', 1, ?, '2026-01-01T00:00:00.000Z')" +
      " ON CONFLICT(repository_id) DO UPDATE SET revision = repository.revision + 1," +
      " last_event_sequence = excluded.last_event_sequence, updated_at = excluded.updated_at",
    wrongTypeSql:
      "INSERT INTO repository (repository_id, codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES ('repo-typed', 'cb-parent', 1, ?, '2026-01-01T00:00:00.000Z')",
  },
  {
    table: "workspace",
    key: "workspace_id",
    id: "ws-1",
    seedParents: (sequence) => seedCodebase(sequence),
    insertSql:
      "INSERT INTO workspace (workspace_id, codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, 'cb-parent', ?, ?, '2026-01-01T00:00:00.000Z')",
    insertValues: (revision, sequence, id = "ws-1") => [id, revision, sequence],
    updateSql: "UPDATE workspace SET revision = ?, last_event_sequence = ? WHERE workspace_id = ?",
    staleUpdateSql:
      "UPDATE workspace SET revision = ?, last_event_sequence = ? WHERE workspace_id = ? AND revision = ?",
    upsertVariantASql:
      "INSERT INTO workspace (workspace_id, codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, 'cb-parent', 2, ?, '2026-01-01T00:00:00.000Z')" +
      " ON CONFLICT(workspace_id) DO UPDATE SET revision = excluded.revision," +
      " last_event_sequence = excluded.last_event_sequence, updated_at = excluded.updated_at",
    upsertVariantBSql:
      "INSERT INTO workspace (workspace_id, codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES (?, 'cb-parent', 1, ?, '2026-01-01T00:00:00.000Z')" +
      " ON CONFLICT(workspace_id) DO UPDATE SET revision = workspace.revision + 1," +
      " last_event_sequence = excluded.last_event_sequence, updated_at = excluded.updated_at",
    wrongTypeSql:
      "INSERT INTO workspace (workspace_id, codebase_id, revision, last_event_sequence, updated_at)" +
      " VALUES ('ws-typed', 'cb-parent', 1, ?, '2026-01-01T00:00:00.000Z')",
  },
  /**
   * `stage_artifact_alias` (Task 2.3, migration 4) — carries the ordinary
   * `*_first_revision`/`*_causal_update` guard pair, so it fits this matrix
   * exactly like the four tables above. `artifact` does **not** appear in
   * this matrix: N2's literal DDL gives it a BEFORE UPDATE/DELETE
   * `RAISE(ABORT)` pair instead (append-only, not causally-updated), so
   * every case below — which exercises the causal-update guard specifically
   * — would not apply to it. `artifact`'s own trigger pair is proven
   * separately, in the "artifact immutability" describe block below,
   * mirroring `state_event immutability` above it in this file.
   *
   * `run_id`/`stage_id` are fixed literals ('run-fixed'/'stage-fixed'),
   * mirroring how `repository`/`workspace` above hardcode `'cb-parent'` —
   * `key`/`id` vary only the discriminating `name` column, which is unique
   * across this describe.each's single-row-per-test fixtures.
   */
  {
    table: "stage_artifact_alias",
    key: "name",
    id: "alias-1",
    seedParents: (sequence) => seedArtifact(sequence),
    insertSql:
      "INSERT INTO stage_artifact_alias" +
      " (run_id, stage_id, name, artifact_id, revision, last_event_sequence, updated_at)" +
      " VALUES ('run-fixed', 'stage-fixed', ?, 'artifact-parent', ?, ?, '2026-01-01T00:00:00.000Z')",
    insertValues: (revision, sequence, id = "alias-1") => [id, revision, sequence],
    updateSql:
      "UPDATE stage_artifact_alias SET revision = ?, last_event_sequence = ?" +
      " WHERE run_id = 'run-fixed' AND stage_id = 'stage-fixed' AND name = ?",
    staleUpdateSql:
      "UPDATE stage_artifact_alias SET revision = ?, last_event_sequence = ?" +
      " WHERE run_id = 'run-fixed' AND stage_id = 'stage-fixed' AND name = ? AND revision = ?",
    upsertVariantASql:
      "INSERT INTO stage_artifact_alias" +
      " (run_id, stage_id, name, artifact_id, revision, last_event_sequence, updated_at)" +
      " VALUES ('run-fixed', 'stage-fixed', ?, 'artifact-parent', 2, ?, '2026-01-01T00:00:00.000Z')" +
      " ON CONFLICT(run_id, stage_id, name) DO UPDATE SET revision = excluded.revision," +
      " last_event_sequence = excluded.last_event_sequence, updated_at = excluded.updated_at",
    upsertVariantBSql:
      "INSERT INTO stage_artifact_alias" +
      " (run_id, stage_id, name, artifact_id, revision, last_event_sequence, updated_at)" +
      " VALUES ('run-fixed', 'stage-fixed', ?, 'artifact-parent', 1, ?, '2026-01-01T00:00:00.000Z')" +
      " ON CONFLICT(run_id, stage_id, name) DO UPDATE SET" +
      " revision = stage_artifact_alias.revision + 1," +
      " last_event_sequence = excluded.last_event_sequence, updated_at = excluded.updated_at",
    wrongTypeSql:
      "INSERT INTO stage_artifact_alias" +
      " (run_id, stage_id, name, artifact_id, revision, last_event_sequence, updated_at)" +
      " VALUES ('run-fixed', 'stage-fixed', 'alias-typed', 'artifact-parent', 1, ?," +
      " '2026-01-01T00:00:00.000Z')",
  },
];

/**
 * The projection half of design §8 suite 2 (plan Task 3.5). Everything runs
 * raw SQL through `internalHandle`: `commitStateChange` does not exist yet,
 * and that is exactly the point — AC2's guarantee has to hold against *any*
 * writer, not only against the command unit that Phase 4 adds.
 *
 * Corrected claim (finding C4): the triggers do not enforce AC2 as a blanket
 * statement for every writer. Concretely they enforce (a) on INSERT, that a
 * row's first revision is 1; and (b) on UPDATE, that `last_event_sequence`
 * advances strictly and `revision = OLD.revision + 1`. What they do *not*
 * constrain is which SQL shape a writer picks to reach that state — which is
 * precisely why the two upsert variants below are pinned separately.
 */
describe.each(PROJECTION_TABLES.map((entry) => [entry.table, entry] as const))(
  "projection causal guards — %s (AC2, design D8)",
  (_name, projection) => {
    it("INSERT with revision 0 is blocked, verbatim message and pinned errcode", () => {
      const first = seedOneEvent();
      projection.seedParents(first);
      expect(() =>
        internalHandle(db)
          .prepare(projection.insertSql)
          .run(...projection.insertValues(0, first)),
      ).toThrow("first projection revision must be 1");
    });

    it("INSERT with revision 2 is blocked — a projection may not start mid-history", () => {
      const first = seedOneEvent();
      projection.seedParents(first);
      let caught: unknown;
      try {
        internalHandle(db)
          .prepare(projection.insertSql)
          .run(...projection.insertValues(2, first));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect((caught as Error).message).toContain("first projection revision must be 1");
      expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_TRIGGER);
    });

    it("INSERT with revision 1 citing a real event succeeds", () => {
      const first = seedOneEvent();
      projection.seedParents(first);
      const result = internalHandle(db)
        .prepare(projection.insertSql)
        .run(...projection.insertValues(1, first));
      expect(result.changes).toBe(1);
    });

    it("INSERT citing a non-existent last_event_sequence fails its foreign key", () => {
      const first = seedOneEvent();
      projection.seedParents(first);
      let caught: unknown;
      try {
        internalHandle(db)
          .prepare(projection.insertSql)
          .run(...projection.insertValues(1, 9999));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect((caught as Error).message).toContain("FOREIGN KEY constraint failed");
      expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_FOREIGNKEY);
    });

    it("UPDATE citing the same event is blocked — last_event_sequence must advance strictly", () => {
      const first = seedOneEvent();
      projection.seedParents(first);
      const handle = internalHandle(db);
      handle.prepare(projection.insertSql).run(...projection.insertValues(1, first));
      expect(() => handle.prepare(projection.updateSql).run(2, first, projection.id)).toThrow(
        "projection update must advance revision by 1 and cite a newer event",
      );
    });

    it("UPDATE citing an older event is blocked", () => {
      const { first, second } = seedTwoEvents();
      projection.seedParents(first);
      const handle = internalHandle(db);
      handle.prepare(projection.insertSql).run(...projection.insertValues(1, second));
      expect(() => handle.prepare(projection.updateSql).run(2, first, projection.id)).toThrow(
        "projection update must advance revision by 1 and cite a newer event",
      );
    });

    it("UPDATE advancing the event but leaving revision unchanged is blocked", () => {
      const { first, second } = seedTwoEvents();
      projection.seedParents(first);
      const handle = internalHandle(db);
      handle.prepare(projection.insertSql).run(...projection.insertValues(1, first));
      expect(() => handle.prepare(projection.updateSql).run(1, second, projection.id)).toThrow(
        "projection update must advance revision by 1 and cite a newer event",
      );
    });

    it("UPDATE jumping revision 1 → 9 is blocked even though the event advances", () => {
      const { first, second } = seedTwoEvents();
      projection.seedParents(first);
      const handle = internalHandle(db);
      handle.prepare(projection.insertSql).run(...projection.insertValues(1, first));
      expect(() => handle.prepare(projection.updateSql).run(9, second, projection.id)).toThrow(
        "projection update must advance revision by 1 and cite a newer event",
      );
    });

    it("UPDATE advancing revision and event by exactly one step succeeds", () => {
      const { first, second } = seedTwoEvents();
      projection.seedParents(first);
      const handle = internalHandle(db);
      handle.prepare(projection.insertSql).run(...projection.insertValues(1, first));
      const result = handle.prepare(projection.updateSql).run(2, second, projection.id);
      expect(result.changes).toBe(1);
    });

    it("UPDATE guarded on a stale revision reports changes === 0 — the optimistic-concurrency primitive Phase 4 builds on", () => {
      const { first, second } = seedTwoEvents();
      projection.seedParents(first);
      const handle = internalHandle(db);
      handle.prepare(projection.insertSql).run(...projection.insertValues(1, first));
      // The row is at revision 1; this update claims it was last seen at 7.
      // No trigger fires — the WHERE clause simply matches nothing, which is
      // exactly the signal `commitStateChange` turns into
      // CausalityViolationError rather than a silent no-op.
      const result = handle.prepare(projection.staleUpdateSql).run(2, second, projection.id, 7);
      expect(result.changes).toBe(0);
    });

    it("upsert variant A is BLOCKED by the first-revision guard, even though the conflict resolves to the UPDATE branch (V9)", () => {
      const { first, second } = seedTwoEvents();
      projection.seedParents(first);
      const handle = internalHandle(db);
      handle.prepare(projection.insertSql).run(...projection.insertValues(1, first));
      let caught: unknown;
      try {
        handle.prepare(projection.upsertVariantASql).run(projection.id, second);
      } catch (error) {
        caught = error;
      }
      // SQLite evaluates BEFORE INSERT triggers *before* conflict resolution,
      // so the guard sees the literal VALUES row (revision 2) and aborts —
      // reporting an error that points at the wrong thing entirely. Left
      // unpinned, this idiom freezes every projection at revision 1.
      expect(caught).toBeDefined();
      expect((caught as Error).message).toContain("first projection revision must be 1");
      expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_TRIGGER);
    });

    it("upsert variant B SUCCEEDS — pinned explicitly so nobody 'fixes' variant A into it by accident (C4)", () => {
      const { first, second } = seedTwoEvents();
      projection.seedParents(first);
      const handle = internalHandle(db);
      handle.prepare(projection.insertSql).run(...projection.insertValues(1, first));
      const result = handle.prepare(projection.upsertVariantBSql).run(projection.id, second);
      expect(result.changes).toBe(1);
      const row = handle
        .prepare(`SELECT revision FROM ${projection.table} WHERE ${projection.key} = ?`)
        .get(projection.id);
      // Carrying revision 1 in VALUES and computing the real next revision in
      // the DO UPDATE clause sails through the same guard, because the trigger
      // never sees the DO UPDATE clause's values. This is why "the upsert is
      // banned" is a rule about which SQL `commitStateChange` may emit — not a
      // property the schema enforces unconditionally.
      expect(row?.revision).toBe(2);
    });

    it("STRICT rejects a non-numeric value bound to an INTEGER column", () => {
      const first = seedOneEvent();
      projection.seedParents(first);
      // Matches the journal half's matched-pair reasoning (fix G2): assert
      // SQLite's own "cannot store" wording rather than a bare toThrow(),
      // which would stay green if the insert started failing for an
      // unrelated reason — an FK violation, say, or a renamed column.
      let caught: unknown;
      try {
        internalHandle(db).prepare(projection.wrongTypeSql).run("x");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/cannot store/i);
    });
  },
);

/**
 * `artifact` (Task 2.3, migration 4, design D11a) mirrors `state_event
 * immutability` above rather than the `PROJECTION_TABLES` matrix: N2's
 * literal DDL gives it a BEFORE UPDATE/DELETE `RAISE(ABORT)` pair, not the
 * `*_first_revision`/`*_causal_update` guard pair every `PROJECTION_TABLES`
 * entry carries — mirroring `state_event`'s append-only posture (D11a), not
 * the other three projection tables' mutable-with-a-causal-guard posture.
 */
describe("artifact immutability (design D11a, migration 4)", () => {
  it("raises on UPDATE, verbatim message and pinned errcodes", () => {
    const sequence = seedOneEvent();
    seedArtifact(sequence);
    const handle = internalHandle(db);
    let caught: unknown;
    try {
      handle.exec("UPDATE artifact SET media_type = 'application/octet-stream'");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("artifact is append-only");
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_TRIGGER);
    expect(sqliteNodeCode(caught)).toBe("ERR_SQLITE_ERROR");
  });

  it("raises on DELETE, verbatim message and pinned errcodes", () => {
    const sequence = seedOneEvent();
    seedArtifact(sequence);
    const handle = internalHandle(db);
    let caught: unknown;
    try {
      handle.exec("DELETE FROM artifact");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("artifact is append-only");
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_TRIGGER);
    expect(sqliteNodeCode(caught)).toBe("ERR_SQLITE_ERROR");
  });

  it("the named, deliberate escape hatch: DROP TRIGGER then UPDATE succeeds (D5, mirrored) — the layered answer is Phase 5's divergence checker, not the trigger", () => {
    const sequence = seedOneEvent();
    seedArtifact(sequence);
    const handle = internalHandle(db);
    handle.exec("DROP TRIGGER artifact_immutable_update");
    expect(() =>
      handle.exec("UPDATE artifact SET media_type = 'application/octet-stream'"),
    ).not.toThrow();
  });

  it("a second INSERT for a new artifact_id succeeds — immutability blocks UPDATE/DELETE, never a later append", () => {
    const { first, second } = seedTwoEvents();
    seedArtifact(first, "artifact-parent");
    seedArtifact(second, "artifact-second");
    const count = internalHandle(db).prepare("SELECT COUNT(*) AS c FROM artifact").get();
    expect(count?.c).toBe(2);
  });

  /**
   * Phase 2 fix cycle G1: nothing previously enforced `artifact.revision =
   * 1` — `INSERT ... revision = 7` succeeded, contradicting
   * `commit.ts`'s docblock claim that the schema's guard triggers enforce
   * the causal shape "against any writer". `artifact` is not in
   * `PROJECTION_TABLES` (it carries no `*_causal_update` trigger — an
   * artifact row is never updated again), so this first-revision guard is a
   * `CHECK (revision = 1)` on the column, proven here rather than by the
   * shared matrix above.
   */
  it("INSERT with revision other than 1 is blocked (G1 — first-revision guard)", () => {
    const sequence = seedOneEvent();
    const handle = internalHandle(db);
    let caught: unknown;
    try {
      handle
        .prepare(
          "INSERT INTO artifact (artifact_id, run_id, stage_id, name, content_hash, byte_length," +
            " media_type, content_schema_id, producer, source_lineage, relative_path, created_at," +
            " revision, last_event_sequence)" +
            ` VALUES ('artifact-bad-revision', 'run-fixed', 'stage-fixed', 'artifact-name',` +
            ` '${ARTIFACT_CONTENT_HASH}', 0, 'text/plain', 'heniek://contract/Example/v1',` +
            ` 'test-producer', '[]', 'blobs/sha256/${ARTIFACT_CONTENT_HASH}', ?, 7, ?)`,
        )
        .run(TIMESTAMP, sequence);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/CHECK constraint failed/i);
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_CHECK);
  });

  it("INSERT with revision 1 succeeds (G1 — the accepted case)", () => {
    const sequence = seedOneEvent();
    seedArtifact(sequence, "artifact-good-revision");
    const row = internalHandle(db)
      .prepare("SELECT revision FROM artifact WHERE artifact_id = 'artifact-good-revision'")
      .get();
    expect(row?.revision).toBe(1);
  });
});

describe("projection relationship foreign keys (design D8, §16.3)", () => {
  it("INSERT INTO repository naming an unregistered codebase_id fails its foreign key", () => {
    const first = seedOneEvent();
    let caught: unknown;
    try {
      internalHandle(db)
        .prepare(
          "INSERT INTO repository (repository_id, codebase_id, revision, last_event_sequence, updated_at)" +
            " VALUES ('repo-orphan', 'cb-does-not-exist', 1, ?, '2026-01-01T00:00:00.000Z')",
        )
        .run(first);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("FOREIGN KEY constraint failed");
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_FOREIGNKEY);
  });

  it("INSERT INTO workspace naming an unregistered codebase_id fails its foreign key", () => {
    const first = seedOneEvent();
    let caught: unknown;
    try {
      internalHandle(db)
        .prepare(
          "INSERT INTO workspace (workspace_id, codebase_id, revision, last_event_sequence, updated_at)" +
            " VALUES ('ws-orphan', 'cb-does-not-exist', 1, ?, '2026-01-01T00:00:00.000Z')",
        )
        .run(first);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("FOREIGN KEY constraint failed");
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_FOREIGNKEY);
  });

  it("run_projection.workspace_id is nullable and carries no foreign key — a run exists before its workspace is provisioned (Q011)", () => {
    const first = seedOneEvent();
    const handle = internalHandle(db);
    handle
      .prepare(
        "INSERT INTO run_projection (run_id, status, revision, last_event_sequence, codebase_id, updated_at, workspace_id)" +
          " VALUES ('run-nows', 'queued', 1, ?, 'cb-1', '2026-01-01T00:00:00.000Z', NULL)",
      )
      .run(first);
    const row = handle
      .prepare("SELECT workspace_id FROM run_projection WHERE run_id = 'run-nows'")
      .get();
    expect(row?.workspace_id).toBeNull();
  });

  /**
   * `artifact.run_id REFERENCES run_projection(run_id)` (issue #8, Phase 2
   * fix cycle G1, finding F4) — mirrors the `repository`/`workspace` cases
   * above. The shipped DDL had neither this `REFERENCES` clause nor a
   * reducer-side check, so an artifact could be committed for a run that
   * never existed.
   */
  it("INSERT INTO artifact naming a non-existent run_id fails its foreign key", () => {
    const first = seedOneEvent();
    let caught: unknown;
    try {
      internalHandle(db)
        .prepare(
          "INSERT INTO artifact (artifact_id, run_id, stage_id, name, content_hash, byte_length," +
            " media_type, content_schema_id, producer, source_lineage, relative_path, created_at," +
            " revision, last_event_sequence)" +
            ` VALUES ('artifact-orphan', 'run-does-not-exist', 'stage-1', 'plan.md',` +
            ` '${ARTIFACT_CONTENT_HASH}', 0, 'text/plain', 'heniek://contract/Example/v1',` +
            ` 'test-producer', '[]', 'blobs/sha256/${ARTIFACT_CONTENT_HASH}', ?, 1, ?)`,
        )
        .run(TIMESTAMP, first);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("FOREIGN KEY constraint failed");
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_FOREIGNKEY);
  });
});

/**
 * `CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')`
 * (issue #8, Phase 2 fix cycle G1, finding F1) — the path-traversal hole the
 * shipped CHECK left open. The shipped constraint was `content_hash =
 * lower(content_hash)`, which only rejects uppercase letters: `lower(X) = X`
 * is also true for a 64-character string containing `.` and `/`, so nothing
 * stopped `relative_path = 'blobs/sha256/' || content_hash` from denoting a
 * path outside the blob root. This test is the regression proof — it fails
 * (accepts the traversal payload) against the old `= lower(content_hash)`
 * CHECK and passes only with the GLOB alphabet restriction in place.
 */
describe("artifact content_hash CHECK — path-traversal closure (issue #8, F1)", () => {
  it("rejects a 64-character, already-lowercase content_hash that encodes a path-traversal sequence", () => {
    const first = seedOneEvent();
    // Seeds the 'run-fixed' FK parent first (F4) so the only constraint this
    // INSERT can trip is the content_hash CHECK under test — otherwise a
    // regression back to the old, permissive CHECK would surface as a
    // FOREIGN KEY failure instead of no error at all, masking the hole this
    // test exists to catch.
    seedRun(first);
    // 64 characters, all lowercase, satisfies the old `= lower(content_hash)`
    // CHECK — but resolves `'blobs/sha256/' || content_hash` to a path
    // outside the blob root once `../` segments are walked.
    const traversalHash = `${"../".repeat(18)}etc/passwd`;
    expect(traversalHash.length).toBe(64);
    expect(traversalHash).toBe(traversalHash.toLowerCase());

    let caught: unknown;
    try {
      internalHandle(db)
        .prepare(
          "INSERT INTO artifact (artifact_id, run_id, stage_id, name, content_hash, byte_length," +
            " media_type, content_schema_id, producer, source_lineage, relative_path, created_at," +
            " revision, last_event_sequence)" +
            ` VALUES ('artifact-traversal', 'run-fixed', 'stage-fixed', 'artifact-name',` +
            ` '${traversalHash}', 0, 'text/plain', 'heniek://contract/Example/v1',` +
            ` 'test-producer', '[]', 'blobs/sha256/${traversalHash}', ?, 1, ?)`,
        )
        .run(TIMESTAMP, first);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/CHECK constraint failed/i);
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_CHECK);
  });

  it("accepts a 64-character lowercase hex content_hash", () => {
    const sequence = seedOneEvent();
    seedArtifact(sequence, "artifact-valid-hash");
    const row = internalHandle(db)
      .prepare("SELECT content_hash FROM artifact WHERE artifact_id = 'artifact-valid-hash'")
      .get();
    expect(row?.content_hash).toBe(ARTIFACT_CONTENT_HASH);
  });
});
