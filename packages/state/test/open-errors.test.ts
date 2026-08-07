/**
 * Issue #7, Phase 1 fix F2: a raw `node:sqlite` error escaping the package
 * with the handle left open. This case exists in neither the plan's Task
 * 1.8 table nor `open-permissions.test.ts` — the `application_id = 12345`
 * case there uses a *valid* SQLite file and never reaches `readApplicationId`
 * throwing directly, which is what happens when the file is not a database
 * at all (`sqlite3_open_v2` does not read page 1; the header is only
 * validated once a statement runs, i.e. at `readApplicationId`).
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStateDatabase } from "../src/database/open.js";
import { StateDatabaseCorruptionError } from "../src/errors.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "heniek-state-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function baseOptions(path: string) {
  return { path, clock: createFakeClock(), ids: createDeterministicIds(1) };
}

describe("openStateDatabase — raw node:sqlite errors do not escape the package (issue #7, Phase 1 fix F2)", () => {
  it("translates a non-database file into StateDatabaseCorruptionError without echoing its content", () => {
    const path = join(directory, "state.sqlite");
    writeFileSync(path, "not a database at all");

    let caught: unknown;
    try {
      openStateDatabase(baseOptions(path));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StateDatabaseCorruptionError);
    expect((caught as Error).message).not.toContain("not a database at all");
  });

  it("does not wedge the handle — a second open on the same path throws the same, translated error", () => {
    const path = join(directory, "state.sqlite");
    writeFileSync(path, "not a database at all");

    expect(() => openStateDatabase(baseOptions(path))).toThrow(StateDatabaseCorruptionError);
    // If the first open's handle were never closed, node:sqlite would still
    // hold a lock (or the process would otherwise misbehave) — a second,
    // independent open must fail the same way, not hang or throw something
    // unrelated.
    expect(() => openStateDatabase(baseOptions(path))).toThrow(StateDatabaseCorruptionError);
  });
});
