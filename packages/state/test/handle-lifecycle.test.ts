/**
 * Issue #7, fix B6: the `internals()` guard — the structural half of AC2's
 * word "every" (design D10; plan Task 1.6) — had thin test coverage. This
 * pins: a foreign object passed to `internalHandle` throws `StateStoreError`;
 * `internalHandle` after `close()` throws `StateStoreError`; double-`close()`
 * is safe; `schemaVersion` works before `close()` and throws `StateStoreError`
 * after; and a static assertion that the barrel's exported names contain
 * none of `internalHandle`, `internalClock`, `internalIds`,
 * `internalPermissionsEnforced`.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  internalClock,
  internalHandle,
  internalIds,
  internalPermissionsEnforced,
  openStateDatabase,
  type StateDatabase,
} from "../src/database/open.js";
import { StateStoreError } from "../src/errors.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

let directory: string;
let dbPath: string;

beforeEach(async () => {
  ({ directory, path: dbPath } = await makeTempDbPath());
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function baseOptions(path: string) {
  return { path, clock: createFakeClock(), ids: createDeterministicIds(1) };
}

/** A plain object shaped like `StateDatabase` but never registered in the module-level `WeakMap` — the "foreign handle" case every `internals()`-routed accessor must reject. */
function foreignHandle(): StateDatabase {
  return {
    path: "/nonexistent/state.sqlite",
    schemaVersion: 0,
    close(): void {
      // intentionally empty — never a real handle
    },
  };
}

describe("openStateDatabase — handle lifecycle guards (issue #7, fix B6)", () => {
  it("rejects a foreign object on every internals()-routed accessor", () => {
    const foreign = foreignHandle();
    expect(() => internalHandle(foreign)).toThrow(StateStoreError);
    expect(() => internalClock(foreign)).toThrow(StateStoreError);
    expect(() => internalIds(foreign)).toThrow(StateStoreError);
    expect(() => internalPermissionsEnforced(foreign)).toThrow(StateStoreError);
  });

  it("rejects internalHandle/internalClock/internalIds/internalPermissionsEnforced after close()", () => {
    const db = openStateDatabase(baseOptions(dbPath));
    db.close();

    expect(() => internalHandle(db)).toThrow(StateStoreError);
    expect(() => internalClock(db)).toThrow(StateStoreError);
    expect(() => internalIds(db)).toThrow(StateStoreError);
    expect(() => internalPermissionsEnforced(db)).toThrow(StateStoreError);
  });

  it("close() is idempotent — a second call does not throw", () => {
    const db = openStateDatabase(baseOptions(dbPath));
    db.close();
    expect(() => db.close()).not.toThrow();
  });

  it("schemaVersion reads before close() and throws StateStoreError after", () => {
    const db = openStateDatabase(baseOptions(dbPath));
    expect(db.schemaVersion).toBe(0);
    db.close();
    expect(() => db.schemaVersion).toThrow(StateStoreError);
  });

  it("the barrel (src/index.ts) does not export any internal accessor", async () => {
    const barrel: Record<string, unknown> = await import("../src/index.js");
    expect("internalHandle" in barrel).toBe(false);
    expect("internalClock" in barrel).toBe(false);
    expect("internalIds" in barrel).toBe(false);
    expect("internalPermissionsEnforced" in barrel).toBe(false);
    expect("openStateDatabaseInternal" in barrel).toBe(false);
  });
});
