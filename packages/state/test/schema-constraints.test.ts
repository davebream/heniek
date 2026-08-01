/**
 * Raw-SQL constraint suite for the migrated schema (plan Task 2.6, design
 * §8 suite 2). Journal half only in this phase — the projection half lands
 * in Phase 3 (Task 3.5), once `run_projection` exists. Every case runs raw
 * SQL through `internalHandle` — the command API does not exist yet, and
 * that is the point.
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
});

describe("state_event STRICT and CHECK constraints (design D4)", () => {
  it("STRICT rejects a value of the wrong storage class for an INTEGER column", () => {
    // `sequence` is the rowid alias (INTEGER PRIMARY KEY); a STRICT table
    // still enforces its declared type, so a text value that does not look
    // like an integer is rejected rather than silently coerced (unlike the
    // TEXT-column direction, where STRICT freely stringifies a numeric
    // input — that direction is not an error and would make a vacuous test).
    const handle = internalHandle(db);
    let caught: unknown;
    try {
      handle
        .prepare(
          "INSERT INTO state_event " +
            "(sequence, event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload) " +
            "VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)",
        )
        .run(
          "not-a-number",
          "evt-strict",
          "cor-strict",
          "run.created",
          "2026-01-01T00:00:00.000Z",
          "{}",
        );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    // The rowid alias (`INTEGER PRIMARY KEY`) validates its type through a
    // slightly different path than an ordinary STRICT column and reports
    // "datatype mismatch" rather than the "cannot store <T> value in <T>
    // column" wording an ordinary column uses — both are the same STRICT
    // type-rejection family the plan's acceptance row names, so this
    // assertion accepts either wording.
    expect((caught as Error).message).toMatch(/cannot store|datatype mismatch/i);
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
