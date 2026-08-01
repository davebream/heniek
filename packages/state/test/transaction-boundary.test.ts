/**
 * The C2 transaction-boundary suite (design §8 suite 3; plan Task 4.6).
 *
 * These cases exist to prove that the event row and the projection row it
 * causes are written as one indivisible pair — never one without the other —
 * and that a failure anywhere inside the unit leaves no transaction open.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitStateChange } from "../src/command/commit.js";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import type { Clock } from "../src/determinism.js";
import { StateStoreError } from "../src/errors.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

/**
 * A `Clock` that can be armed to fail after a given number of further reads.
 * `allowThenFail(1)` is the C2 seam: the commit's first `nowIso()` (which
 * becomes `recorded_at`) succeeds, and the second — taken after the event row
 * is inserted but before any projection write — throws.
 *
 * This is a real injected port, not a test-only production API: `Clock` is a
 * required constructor parameter precisely so this boundary is reachable
 * without `commitStateChange` growing a seam of its own (finding CRIT-03).
 */
function createArmableClock(): Clock & { allowThenFail(calls: number): void } {
  const inner = createFakeClock();
  let remaining = Number.POSITIVE_INFINITY;
  return {
    nowIso: () => {
      if (remaining <= 0) {
        throw new Error("injected clock failure");
      }
      remaining -= 1;
      return inner.nowIso();
    },
    allowThenFail: (calls: number) => {
      remaining = calls;
    },
  };
}

let directory: string;
let path: string;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  path = temp.path;
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function openMigrated(clock: Clock = createFakeClock()): StateDatabase {
  const db = openStateDatabase({ path, clock, ids: createDeterministicIds(1) });
  runMigrations(db);
  return db;
}

function countRows(db: StateDatabase, table: string): number {
  const row = internalHandle(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.n ?? -1);
}

describe("the C2 boundary — the event/projection pair is indivisible", () => {
  it("a throw between the event append and the projection write leaves NEITHER row", () => {
    const clock = createArmableClock();
    const db = openMigrated(clock);
    try {
      // One call allowed (recorded_at), the next one throws — exactly at the
      // point where the event row exists and the projection row does not.
      clock.allowThenFail(1);
      expect(() =>
        commitStateChange(db, {
          runId: "run-1",
          type: "run.created",
          payload: { runId: "run-1", codebaseId: "cb-1" },
        }),
      ).toThrow("injected clock failure");

      // Both tables, not one. A suite that asserted only the projection would
      // pass against an implementation that leaked an orphan event row — the
      // exact failure this case exists to catch.
      expect(countRows(db, "state_event")).toBe(0);
      expect(countRows(db, "run_projection")).toBe(0);
      expect(internalHandle(db).isTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it("a throw after COMMIT returns leaves BOTH rows durable", () => {
    const db = openMigrated();
    try {
      expect(() => {
        commitStateChange(db, {
          runId: "run-1",
          type: "run.created",
          payload: { runId: "run-1", codebaseId: "cb-1" },
        });
        throw new Error("caller failed after the commit returned");
      }).toThrow("caller failed after the commit returned");

      // §16.6's mirror image: once the commit returns, the stage *is*
      // complete, and a later caller failure cannot un-complete it.
      expect(countRows(db, "state_event")).toBe(1);
      expect(countRows(db, "run_projection")).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("guarded ROLLBACK (V7)", () => {
  it("a RAISE(ABORT) inside the unit leaves no open transaction afterwards", () => {
    const db = openMigrated();
    try {
      commitStateChange(db, {
        runId: "run-1",
        type: "run.created",
        payload: { runId: "run-1", codebaseId: "cb-1" },
      });

      // DEVIATION FROM THE PLAN'S LITERAL MECHANISM, recorded rather than
      // silently substituted. Task 4.6 proposed inflating the stored
      // `last_event_sequence` past "any sequence the next event will mint"
      // and letting the causal-guard trigger's older-event branch fire. That
      // is unreachable: `last_event_sequence` is FK-constrained to an
      // existing `state_event.sequence`, and `sequence` is the rowid alias,
      // so every newly appended event necessarily outranks every value the
      // column can legally already hold. (The same argument shows the
      // older-event branch cannot fire during normal operation at all — a
      // reassuring property, not a gap.) The surgery itself is also blocked:
      // an UPDATE that leaves `revision` untouched trips the very trigger the
      // case is trying to reach.
      //
      // What the case actually exists to prove is V7: when a statement inside
      // the unit raises ABORT, SQLite rolls back only that statement and
      // leaves the transaction OPEN, so `commitStateChange`'s guarded
      // ROLLBACK must run. Installing a trigger that refuses the update
      // reaches that state directly and honestly.
      const handle = internalHandle(db);
      handle.exec("DROP TRIGGER run_projection_causal_update");
      handle.exec(
        "CREATE TRIGGER run_projection_causal_update BEFORE UPDATE ON run_projection" +
          " BEGIN SELECT RAISE(ABORT, 'projection update refused by the hostile trigger'); END",
      );

      expect(() =>
        commitStateChange(db, {
          runId: "run-1",
          type: "run.status_changed",
          payload: { runId: "run-1", status: "running" },
        }),
      ).toThrow("projection update refused by the hostile trigger");

      // The point of the whole case: the guarded ROLLBACK ran, so the handle
      // is not stranded inside a transaction that would poison every later
      // command with "cannot start a transaction within a transaction".
      expect(handle.isTransaction).toBe(false);
      // The aborted command left nothing behind — the run is still at the
      // revision its creation set.
      expect(countRows(db, "run_projection")).toBe(1);
      expect(countRows(db, "state_event")).toBe(1);

      // And the handle is genuinely usable afterwards.
      handle.exec("DROP TRIGGER run_projection_causal_update");
      expect(() =>
        commitStateChange(db, {
          runId: "run-1",
          type: "run.status_changed",
          payload: { runId: "run-1", status: "running" },
        }),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("transaction ownership", () => {
  it("close() with an open transaction discards the uncommitted work", () => {
    const first = openMigrated();
    const handle = internalHandle(first);
    handle.exec("BEGIN IMMEDIATE");
    handle
      .prepare(
        "INSERT INTO state_event" +
          " (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)" +
          " VALUES ('evt-uncommitted', NULL, 'cor-1', NULL, 'codebase.registered'," +
          " '2026-01-01T00:00:00.000Z', '{}')",
      )
      .run();
    expect(handle.isTransaction).toBe(true);
    first.close();

    const reopened = openStateDatabase({
      path,
      clock: createFakeClock(),
      ids: createDeterministicIds(1),
    });
    try {
      expect(countRows(reopened, "state_event")).toBe(0);
    } finally {
      reopened.close();
    }
  });

  it("commitStateChange refuses a caller-opened transaction with a typed error and leaves it open", () => {
    const db = openMigrated();
    try {
      const handle = internalHandle(db);
      handle.exec("BEGIN IMMEDIATE");

      let caught: unknown;
      try {
        commitStateChange(db, { type: "codebase.registered", payload: { codebaseId: "cb-1" } });
      } catch (error) {
        caught = error;
      }
      // A typed refusal, not the raw "cannot start a transaction within a
      // transaction" SQLite would otherwise surface (V8).
      expect(caught).toBeInstanceOf(StateStoreError);
      expect((caught as Error).message).not.toContain("cannot start a transaction");

      // The caller's transaction is theirs; the refusal must not have rolled
      // it back underneath them.
      expect(handle.isTransaction).toBe(true);
      handle.exec("ROLLBACK");
    } finally {
      db.close();
    }
  });
});
