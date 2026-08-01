/**
 * The defect register (T3; plan Task 6.2).
 *
 * Seeded with the two defects the design stage found before any code existed,
 * so neither can be reintroduced silently. Each case names the finding and
 * says *why* the naive alternative is wrong — a regression pin without that
 * reasoning is just another assertion someone will "simplify" away.
 *
 * Any further defect discovered while implementing belongs here too: T3 says
 * "every defect", and this file is the register.
 */

import { chmodSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

function sqliteErrorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "errcode" in error) {
    const errcode = (error as { errcode?: unknown }).errcode;
    return typeof errcode === "number" ? errcode : undefined;
  }
  return undefined;
}

const SQLITE_CONSTRAINT_TRIGGER = 1811;

let directory: string;
let path: string;
let db: StateDatabase;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  path = temp.path;
  db = openStateDatabase({ path, clock: createFakeClock(), ids: createDeterministicIds(1) });
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function seedRun(): number {
  const handle = internalHandle(db);
  const event = handle
    .prepare(
      "INSERT INTO state_event" +
        " (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)" +
        " VALUES ('evt-1', 'run-1', 'cor-1', NULL, 'run.created', '2026-01-01T00:00:00.000Z', '{}')",
    )
    .run();
  const sequence = Number(event.lastInsertRowid);
  handle
    .prepare(
      "INSERT INTO run_projection" +
        " (run_id, status, revision, last_event_sequence, codebase_id, updated_at)" +
        " VALUES ('run-1', 'queued', 1, ?, 'cb-1', '2026-01-01T00:00:00.000Z')",
    )
    .run(sequence);
  const second = handle
    .prepare(
      "INSERT INTO state_event" +
        " (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)" +
        " VALUES ('evt-2', 'run-1', 'cor-1', NULL, 'run.status_changed', '2026-01-01T00:00:00.000Z', '{}')",
    )
    .run();
  return Number(second.lastInsertRowid);
}

describe("R-V9 — an upsert fires BEFORE INSERT even on the UPDATE branch (finding V9/C4)", () => {
  /*
   * Both variants are pinned together, and that pairing is the point.
   *
   * A builder who reaches for the idiomatic upsert — carrying the intended
   * next revision in the VALUES row, variant A — produces a package that
   * cannot advance ANY projection past its first event, and the error it
   * reports points at the wrong thing entirely ("first projection revision
   * must be 1" on what is logically an update). SQLite evaluates BEFORE
   * INSERT triggers *before* conflict resolution, so the guard never sees the
   * DO UPDATE clause at all.
   *
   * A builder who instead writes variant B — revision 1 in VALUES, the real
   * next revision computed in DO UPDATE SET — is not caught by that trap.
   * Pinning only variant A would therefore leave "the upsert is banned"
   * reading as a schema-enforced property, which it is not: it is a rule
   * about which SQL `commitStateChange` may emit. Both facts have to stay
   * true simultaneously, so both are pinned.
   */

  it("variant A is rejected by the first-revision guard, verbatim message and errcode", () => {
    const secondSequence = seedRun();
    let caught: unknown;
    try {
      internalHandle(db)
        .prepare(
          "INSERT INTO run_projection" +
            " (run_id, status, revision, last_event_sequence, codebase_id, updated_at)" +
            " VALUES ('run-1', 'running', 2, ?, 'cb-1', '2026-01-01T00:00:00.000Z')" +
            " ON CONFLICT(run_id) DO UPDATE SET revision = excluded.revision," +
            " status = excluded.status, last_event_sequence = excluded.last_event_sequence," +
            " updated_at = excluded.updated_at",
        )
        .run(secondSequence);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("first projection revision must be 1");
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_TRIGGER);

    // Still frozen at its first revision — the visible symptom of the defect.
    const row = internalHandle(db)
      .prepare("SELECT revision FROM run_projection WHERE run_id = 'run-1'")
      .get();
    expect(row?.revision).toBe(1);
  });

  it("variant B succeeds and advances the row — pinned so nobody 'fixes' variant A into it by accident", () => {
    const secondSequence = seedRun();
    const result = internalHandle(db)
      .prepare(
        "INSERT INTO run_projection" +
          " (run_id, status, revision, last_event_sequence, codebase_id, updated_at)" +
          " VALUES ('run-1', 'running', 1, ?, 'cb-1', '2026-01-01T00:00:00.000Z')" +
          " ON CONFLICT(run_id) DO UPDATE SET revision = run_projection.revision + 1," +
          " status = excluded.status, last_event_sequence = excluded.last_event_sequence," +
          " updated_at = excluded.updated_at",
      )
      .run(secondSequence);
    expect(result.changes).toBe(1);

    const row = internalHandle(db)
      .prepare("SELECT revision FROM run_projection WHERE run_id = 'run-1'")
      .get();
    expect(row?.revision).toBe(2);
  });
});

describe("R-V6 — opening first and chmod-ing afterwards leaves the sidecars exposed (finding V6/D13)", () => {
  /*
   * The `-wal` sidecar can hold committed rows that have not been
   * checkpointed into the main file yet, so a world-readable `-wal` is a real
   * exposure of real state, not a cosmetic permissions nit. That is why
   * `openStateDatabase` pre-creates the main file at 0o600 *before* handing
   * the path to `DatabaseSync` — the ordering cannot be refactored into a
   * tidier "open, then fix up the modes" shape.
   */

  it("the defective ordering: SQLite creates the files, and a later chmod does not reach the sidecars", () => {
    const defectivePath = join(directory, "defective.sqlite");
    const raw = new DatabaseSync(defectivePath);
    try {
      raw.exec("PRAGMA journal_mode = WAL");
      raw.exec("CREATE TABLE probe (a INTEGER) STRICT");
      raw.exec("INSERT INTO probe (a) VALUES (1)");

      // The mode SQLite itself gave these files, captured BEFORE the repair.
      // Anchoring on this rather than on a hand-computed `0o666 & ~umask`
      // avoids encoding SQLite's own base mode (it creates database files
      // from 0o644, not 0o666) and keeps the case correct under any umask.
      const createdMode = statSync(defectivePath).mode & 0o777;

      // The naive repair: fix up the main file after the fact.
      chmodSync(defectivePath, 0o600);
      expect(statSync(defectivePath).mode & 0o777).toBe(0o600);

      // ...which provably does not reach the sidecars. They still carry the
      // exact mode SQLite created them with.
      const walMode = statSync(`${defectivePath}-wal`).mode & 0o777;
      const shmMode = statSync(`${defectivePath}-shm`).mode & 0o777;
      expect(walMode).toBe(createdMode);
      expect(shmMode).toBe(createdMode);
      if (createdMode !== 0o600) {
        // The exposure is only observable when the ambient umask does not
        // already produce private files. Under a umask strict enough to yield
        // 0o600 the defective ordering coincidentally looks fine — the
        // ordering is still wrong, it just cannot be caught by inspecting
        // modes, which is exactly why openStateDatabase does not rely on the
        // umask being helpful.
        expect(walMode).not.toBe(0o600);
        expect(shmMode).not.toBe(0o600);
      }
    } finally {
      raw.close();
    }
  });

  it("openStateDatabase's pre-creation ordering yields 0o600 on the main file and both sidecars", () => {
    // `db` is already open and migrated from the shared beforeEach, so the
    // WAL sidecars exist.
    internalHandle(db).exec("PRAGMA wal_checkpoint(PASSIVE)");
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      expect(statSync(candidate).mode & 0o777).toBe(0o600);
    }
  });
});
