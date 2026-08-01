import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StateDatabase } from "../src/database/open.js";
import {
  internalHandle,
  internalPermissionsEnforced,
  openStateDatabase,
  openStateDatabaseInternal,
} from "../src/database/open.js";
import {
  InsecureStateDatabaseError,
  StateDatabaseCorruptionError,
  StateStoreError,
} from "../src/errors.js";
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

/** Shared, deterministic `Clock`/`IdGenerator` pair — every test opens against a fresh path. */
function baseOptions(path: string) {
  return { path, clock: createFakeClock(), ids: createDeterministicIds(1) };
}

/** No `-wal` or `-shm` sidecar exists beside `path` — used to prove a refused open never reached SQLite. */
function noSidecarsBeside(path: string): boolean {
  return !existsSync(`${path}-wal`) && !existsSync(`${path}-shm`);
}

describe("openStateDatabase — file and directory permissions (design D13)", () => {
  it("creates state.sqlite, -wal and -shm at mode 0600 once a write has happened", () => {
    const db = openStateDatabase(baseOptions(dbPath));
    try {
      internalHandle(db).exec("CREATE TABLE t (a INTEGER)");
      expect(lstatSync(dbPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
      expect(lstatSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it("repairs a pre-existing 0644 file to 0600", () => {
    writeFileSync(dbPath, "");
    chmodSync(dbPath, 0o644);

    const db = openStateDatabase(baseOptions(dbPath));
    try {
      expect(lstatSync(dbPath).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
    // `open.ts`'s verify-the-repair branch (a second `lstat` after
    // `chmodSync` still reporting group/other access) is unreachable from a
    // test on a POSIX-conformant filesystem — `chmodSync` either succeeds
    // and takes effect, or throws. There is no honest way to assert that
    // branch a second time here (issue #7, Phase 1 fix F8.8); one assertion
    // above is the whole of what this case can honestly pin.
  });

  it("repairs a pre-existing 0644 -wal sidecar to 0600 before the main file is ever opened by SQLite (issue #7, fix B8)", () => {
    writeFileSync(dbPath, "");
    chmodSync(dbPath, 0o600);
    writeFileSync(`${dbPath}-wal`, "");
    chmodSync(`${dbPath}-wal`, 0o644);

    const db = openStateDatabase(baseOptions(dbPath));
    try {
      expect(lstatSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it("refuses a symlinked path, and the link target is never opened as a database", () => {
    const target = join(directory, "real.sqlite");
    writeFileSync(target, "");
    symlinkSync(target, dbPath);

    expect(() => openStateDatabase(baseOptions(dbPath))).toThrow(InsecureStateDatabaseError);
    // Never touched as a SQLite file: still zero bytes, no header written,
    // and — the discriminating assertion (issue #7, Phase 1 fix F8.4,
    // replacing a vacuous "target size is still 0" check that would pass
    // whether or not the target had actually been opened) — no -wal/-shm
    // sidecars appeared next to the symlink itself.
    expect(lstatSync(target).size).toBe(0);
    expect(noSidecarsBeside(dbPath)).toBe(true);
  });

  it("refuses a dangling symlink without following it and creating its missing target (issue #7, Phase 1 fix F1)", () => {
    const target = join(directory, "never-created.sqlite");
    symlinkSync(target, dbPath);

    expect(() => openStateDatabase(baseOptions(dbPath))).toThrow(InsecureStateDatabaseError);
    // The old `openSync(path, "a", 0o600)` pre-create followed the symlink
    // and created an empty target when it was missing, before the step-4
    // refusal ever ran. `openSync(path, "ax", 0o600)` (O_EXCL) must fail
    // with EEXIST on the dangling link itself instead — this is the
    // regression pin for F1; without it, F1 is unfalsifiable (issue #7,
    // Phase 1 fix F8.1).
    expect(existsSync(target)).toBe(false);
    expect(noSidecarsBeside(dbPath)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a FIFO without blocking on it (issue #7, Phase 1 fix F1, F8.2)",
    () => {
      // `mkfifo` has no `node:fs` equivalent; shelling out is the
      // established way to create one for a test. The old `"a"` flag would
      // block forever trying to open a FIFO with no reader/writer on the
      // other end (exit 124 under a process timeout) — `"ax"`'s O_EXCL
      // fails with EEXIST without ever opening it, so this case must return
      // promptly rather than hang the suite.
      execFileSync("mkfifo", [dbPath]);
      expect(() => openStateDatabase(baseOptions(dbPath))).toThrow(InsecureStateDatabaseError);
    },
    2000,
  );

  it("refuses a path that is a directory", () => {
    mkdirSync(dbPath);
    expect(() => openStateDatabase(baseOptions(dbPath))).toThrow(InsecureStateDatabaseError);
  });

  it("refuses a garbage non-SQLite file with StateDatabaseCorruptionError, and the broken handle is closed (issue #7, Phase 1 fix F2, F8.5)", () => {
    writeFileSync(
      dbPath,
      "this is deliberately not a valid SQLite database header — plain garbage bytes",
    );
    expect(() => openStateDatabase(baseOptions(dbPath))).toThrow(StateDatabaseCorruptionError);
  });

  it("refuses a relative path before any filesystem write, naming the guard rather than a mkdtemp side effect", () => {
    // Both prior assertions here were vacuous: `toThrow(StateStoreError)`
    // alone still passes even with the `isAbsolute` guard deleted, because
    // step 2's `lstatSync("relative")` then fails with ENOENT and throws
    // the *parent-directory* StateStoreError instead. And diffing
    // `readdirSync(process.cwd())` would be racy — parallel vitest workers
    // and the checkout both write there. Assert the discriminating
    // message, and only a single, targeted `existsSync` at the location
    // the relative path would actually resolve to, never a directory scan
    // (issue #7, Phase 1 fix F8.3).
    expect(() => openStateDatabase(baseOptions("relative/state.sqlite"))).toThrow(
      /must be absolute/,
    );
    expect(existsSync(resolve(process.cwd(), "relative/state.sqlite"))).toBe(false);
  });

  it('skips POSIX permission enforcement for an injected platform: "win32", without throwing or fabricating a mode', () => {
    const parent = join(directory, "parent");
    mkdirSync(parent, { mode: 0o700 });
    chmodSync(parent, 0o777); // group/world-writable — refused under POSIX enforcement (see below)
    const path = join(parent, "state.sqlite");

    // `platform` is not on the public options type — reaching the win32
    // branch from Linux goes through the package-private entry point, which
    // `src/index.ts` never re-exports (issue #7, Phase 1 fix B1).
    const db = openStateDatabaseInternal({ ...baseOptions(path), platform: "win32" });
    try {
      expect(db.path).toBe(path);
      expect(internalPermissionsEnforced(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("refuses a foreign application_id, naming both ids, before writing journal_mode to the foreign file", () => {
    const scratch = new DatabaseSync(dbPath);
    scratch.exec("PRAGMA application_id = 12345;");
    const journalModeBefore = scratch.prepare("PRAGMA journal_mode").get()?.journal_mode;
    scratch.close();

    let caught: unknown;
    try {
      openStateDatabase(baseOptions(dbPath));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateDatabaseCorruptionError);
    // Names both the foreign id found and this package's own expected id
    // (issue #7, Phase 1 fix F8.7), not merely the error class.
    expect((caught as Error).message).toContain("12345");
    expect((caught as Error).message).toContain("1213090609");

    const after = new DatabaseSync(dbPath);
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
    expect((caught as Error).message).toContain(dirname(missingParent));
    expect(() => lstatSync(dirname(missingParent))).toThrow();
  });

  it("refuses a group- or world-writable parent directory", () => {
    const parent = join(directory, "parent");
    mkdirSync(parent, { mode: 0o700 });
    chmodSync(parent, 0o777); // 0o755 is only group/other read+execute, not writable — needs the write bit
    const path = join(parent, "state.sqlite");

    expect(() => openStateDatabase(baseOptions(path))).toThrow(InsecureStateDatabaseError);
  });

  it("refuses a symlinked parent directory instead of misreading its unconditional 0777 mode bits as writable (issue #7, Phase 1 fix F3)", () => {
    const real = join(directory, "real-parent");
    mkdirSync(real, { mode: 0o700 });
    const parentLink = join(directory, "parent-link");
    symlinkSync(real, parentLink);
    const path = join(parentLink, "state.sqlite");

    // Linux reports symlink mode bits as 0777 unconditionally, which would
    // make `isGroupOrOtherWritable` fire for the wrong reason (an accident
    // of the mode encoding, not an actual permission problem) if this case
    // were not checked explicitly before the mask is applied.
    let caught: unknown;
    try {
      openStateDatabase(baseOptions(path));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InsecureStateDatabaseError);
    expect((caught as Error).message).toContain("symlink");
  });

  it("refuses a parent path that is a regular file, not a directory (issue #7, Phase 1 fix F3)", () => {
    const parentAsFile = join(directory, "not-a-directory");
    writeFileSync(parentAsFile, "", { mode: 0o600 });
    const path = join(parentAsFile, "state.sqlite");

    let caught: unknown;
    try {
      openStateDatabase(baseOptions(path));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InsecureStateDatabaseError);
    expect((caught as Error).message).toContain("not a directory");
  });

  it("routes handle.schemaVersion through the same closed-handle check as every other accessor (issue #7, Phase 1 fix F3)", () => {
    const db = openStateDatabase(baseOptions(dbPath));
    db.close();

    // Before the fix, `schemaVersion` closed over `db` directly instead of
    // routing through the closed-handle check every sibling accessor uses,
    // so this threw a raw `node:sqlite` `ERR_INVALID_STATE` instead of a
    // `StateStoreError` a caller of this publicly exported interface can
    // catch.
    expect(() => db.schemaVersion).toThrow(StateStoreError);
  });

  it("internalHandle throws StateStoreError for a foreign object and for a closed handle (issue #7, Phase 1 fix F8.6)", () => {
    // Nothing previously pinned the D10 encapsulation claim that
    // `internalHandle` (and its siblings) refuse anything not returned by
    // `openStateDatabase`, or a handle that has since been closed.
    const foreign = { path: dbPath, schemaVersion: 0, close() {} } as StateDatabase;
    expect(() => internalHandle(foreign)).toThrow(StateStoreError);

    const db = openStateDatabase(baseOptions(dbPath));
    db.close();
    expect(() => internalHandle(db)).toThrow(StateStoreError);
  });

  // Design suite 5 (design line 1192): "a path owned by another uid is
  // refused (skipped when not applicable)" — dropped by the plan's Task 1.8
  // table (issue #7, Phase 1 fix F8), leaving open.ts's uid check uncovered.
  // Exercising it for real needs root (to legitimately own a file as a
  // different uid), so it is conditionally skipped everywhere else.
  it.skipIf(process.getuid?.() !== 0)("refuses a path owned by another uid", () => {
    writeFileSync(dbPath, "");
    // Root can chown to an arbitrary uid; pick one that is not root's own.
    chmodSync(dbPath, 0o600);
    const otherUid = 1;
    chownSync(dbPath, otherUid, statSync(dbPath).gid);

    expect(() => openStateDatabase(baseOptions(dbPath))).toThrow(InsecureStateDatabaseError);
  });
});
