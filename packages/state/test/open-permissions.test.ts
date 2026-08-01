import { chmodSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  internalHandle,
  internalPermissionsEnforced,
  openStateDatabase,
} from "../src/database/open.js";
import {
  InsecureStateDatabaseError,
  StateDatabaseCorruptionError,
  StateStoreError,
} from "../src/errors.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "heniek-state-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Shared, deterministic `Clock`/`IdGenerator` pair — every test opens against a fresh path. */
function baseOptions(path: string) {
  return { path, clock: createFakeClock(), ids: createDeterministicIds(1) };
}

describe("openStateDatabase — file and directory permissions (design D13)", () => {
  it("creates state.sqlite, -wal and -shm at mode 0600 once a write has happened", () => {
    const path = join(directory, "state.sqlite");
    const db = openStateDatabase(baseOptions(path));
    try {
      internalHandle(db).exec("CREATE TABLE t (a INTEGER)");
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(lstatSync(`${path}-wal`).mode & 0o777).toBe(0o600);
      expect(lstatSync(`${path}-shm`).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it("repairs a pre-existing 0644 file to 0600, and the repair is re-verified by a second lstat", () => {
    const path = join(directory, "state.sqlite");
    writeFileSync(path, "");
    chmodSync(path, 0o644);

    const db = openStateDatabase(baseOptions(path));
    try {
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      // Re-check independently of the open call above: the repair actually
      // took, this isn't just the chmod call not throwing (D13/H3).
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it("refuses a symlinked path, and the link target is never opened as a database", () => {
    const target = join(directory, "real.sqlite");
    writeFileSync(target, "");
    const link = join(directory, "state.sqlite");
    symlinkSync(target, link);

    expect(() => openStateDatabase(baseOptions(link))).toThrow(InsecureStateDatabaseError);
    // Never touched as a SQLite file: still zero bytes, no header written,
    // no -wal/-shm sidecars created beside it.
    expect(lstatSync(target).size).toBe(0);
  });

  it("refuses a path that is a directory", () => {
    const path = join(directory, "state.sqlite");
    mkdirSync(path);
    expect(() => openStateDatabase(baseOptions(path))).toThrow(InsecureStateDatabaseError);
  });

  it("refuses a relative path before any filesystem write", () => {
    const before = readdirSync(directory);
    expect(() => openStateDatabase(baseOptions("relative/state.sqlite"))).toThrow(StateStoreError);
    expect(readdirSync(directory)).toEqual(before);
  });

  it('skips POSIX permission enforcement for an injected platform: "win32", without throwing or fabricating a mode', () => {
    const parent = join(directory, "parent");
    mkdirSync(parent, { mode: 0o700 });
    chmodSync(parent, 0o777); // group/world-writable — refused under POSIX enforcement (see below)
    const path = join(parent, "state.sqlite");

    const db = openStateDatabase({ ...baseOptions(path), platform: "win32" });
    try {
      expect(db.path).toBe(path);
      expect(internalPermissionsEnforced(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("refuses a foreign application_id, before writing journal_mode to the foreign file", () => {
    const path = join(directory, "state.sqlite");
    const scratch = new DatabaseSync(path);
    scratch.exec("PRAGMA application_id = 12345;");
    const journalModeBefore = scratch.prepare("PRAGMA journal_mode").get()?.journal_mode;
    scratch.close();

    expect(() => openStateDatabase(baseOptions(path))).toThrow(StateDatabaseCorruptionError);

    const after = new DatabaseSync(path);
    try {
      expect(after.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe(journalModeBefore);
    } finally {
      after.close();
    }
  });

  it("refuses a missing parent directory, naming the entry rather than the raw path, before any filesystem write", () => {
    const missingParent = join(directory, "missing", "state.sqlite");

    let caught: unknown;
    try {
      openStateDatabase(baseOptions(missingParent));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StateStoreError);
    expect((caught as Error).message).not.toContain(missingParent);
    expect(() => lstatSync(dirname(missingParent))).toThrow();
  });

  it("refuses a group- or world-writable parent directory", () => {
    const parent = join(directory, "parent");
    mkdirSync(parent, { mode: 0o700 });
    chmodSync(parent, 0o777); // 0o755 is only group/other read+execute, not writable — needs the write bit
    const path = join(parent, "state.sqlite");

    expect(() => openStateDatabase(baseOptions(path))).toThrow(InsecureStateDatabaseError);
  });
});
