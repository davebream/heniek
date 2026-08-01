import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle, openStateDatabase } from "../src/database/open.js";
import { readForeignKeys, readSynchronous } from "../src/database/pragma.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

let directory: string;

beforeEach(async () => {
  ({ directory } = await makeTempDbPath());
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function baseOptions(path: string) {
  return { path, clock: createFakeClock(), ids: createDeterministicIds(1) };
}

/**
 * `node:sqlite` does not type a `SqliteError` class or an `errcode` field
 * (design D17 — the API surface pinned here is deliberately conservative,
 * and error shapes are outside it), so a caught SQLite failure is narrowed
 * by hand rather than by an imported type, mirroring the `errnoCode`-style
 * helpers already established for `fs` errors in `packages/config/src/
 * home/ensure.ts` and `packages/secrets/src/file-store.ts`.
 */
function sqliteErrorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "errcode" in error) {
    const errcode = (error as { errcode?: unknown }).errcode;
    return typeof errcode === "number" ? errcode : undefined;
  }
  return undefined;
}

const SQLITE_BUSY = 5;

describe("node:sqlite PRAGMA posture pinned by openStateDatabase (design D12, D17)", () => {
  it("sets journal_mode to wal, and it persists across a raw reopen that sets nothing itself", () => {
    const path = join(directory, "state.sqlite");
    const db = openStateDatabase(baseOptions(path));
    db.close();

    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    } finally {
      raw.close();
    }
  });

  it("does not persist synchronous across connections, and openStateDatabase sets FULL (2) on every open (D12/V11, round-1 finding M4)", () => {
    const path = join(directory, "state.sqlite");

    // Connection A explicitly sets a non-default value. If `synchronous`
    // persisted the way `journal_mode` does, connection B (below) would
    // inherit NORMAL (1) instead of falling back to SQLite's own default —
    // asserting only "a fresh connection reads 2" without this step would
    // be vacuous, since 2 is also the out-of-the-box default (round-1
    // finding M4).
    const a = new DatabaseSync(path);
    a.exec("PRAGMA synchronous = NORMAL");
    a.close();

    const b = new DatabaseSync(path);
    try {
      expect(readSynchronous(b)).toBe(2);
    } finally {
      b.close();
    }

    // Separately, openStateDatabase's own open path must assert FULL on
    // every open — verified directly against the handle it returns.
    const db = openStateDatabase(baseOptions(path));
    try {
      expect(readSynchronous(internalHandle(db))).toBe(2);
    } finally {
      db.close();
    }
  });

  it("pins foreign_keys defaulting to 1 on a fresh raw connection (Node's default, not SQLite's — R1)", () => {
    const path = join(directory, "state.sqlite");
    const raw = new DatabaseSync(path);
    try {
      expect(readForeignKeys(raw)).toBe(1);
    } finally {
      raw.close();
    }
  });

  it("db.location() returns the resolved path", () => {
    const path = join(directory, "state.sqlite");
    const db = openStateDatabase(baseOptions(path));
    try {
      expect(internalHandle(db).location()).toBe(path);
    } finally {
      db.close();
    }
  });

  it("a second writer sees SQLITE_BUSY after the busy timeout, without corruption (V10, D12, R9)", () => {
    const path = join(directory, "state.sqlite");
    const db = openStateDatabase(baseOptions(path));
    const handle = internalHandle(db);
    handle.exec("CREATE TABLE t (a INTEGER) STRICT");
    handle.exec("BEGIN IMMEDIATE");

    try {
      // A short timeout keeps this case fast (R9) — the busy wait itself is
      // the thing under test, not how long it lasts.
      const second = new DatabaseSync(path, { timeout: 50 });
      try {
        let caught: unknown;
        try {
          second.exec("BEGIN IMMEDIATE");
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeDefined();
        expect(sqliteErrorCode(caught)).toBe(SQLITE_BUSY);
        expect(second.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      } finally {
        second.close();
      }
    } finally {
      handle.exec("ROLLBACK");
      db.close();
    }
  });
});
