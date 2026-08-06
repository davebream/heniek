/**
 * The out-of-process crash matrix (design §8 suite 4; plan Task 6.1).
 *
 * Each case spawns a real child, waits for it to announce that it has reached
 * a chosen point, `SIGKILL`s it, and then inspects the file it left behind.
 * `process.exit()` would not do: it runs handlers and unwinds cleanly, which
 * is the opposite of what an abrupt kill models.
 *
 * **What these tests prove, precisely:** that *this code* never places a
 * projection write outside the transaction carrying its event. They do **not**
 * prove SQLite is atomic — that is SQLite's claim, relied upon here.
 *
 * **Explicitly out of scope, stated rather than faked:** power loss and lying
 * `fsync`, filesystem corruption, and concurrent writers from a second
 * process. `@heniek/daemon`'s `acquire.ts` now delivers cross-process
 * single-instance enforcement for callers running under the daemon, but
 * this package still takes no filesystem-level lock itself — a caller
 * outside the daemon's held claim still has to arrange its own exclusion,
 * and that residual obligation is exactly why a second-process writer race
 * remains out of scope for this suite. None of these is simulated anywhere
 * in this file.
 *
 * Budget (R9): three children, one spawn each, no sleeps and no polling. The
 * parent asserts on files, never on timing.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schemaFingerprint } from "../src/database/fingerprint.js";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { readUserVersion } from "../src/database/pragma.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const childPath = resolve(packageRoot, "test/helpers/crash-child.ts");

const SCHEMA_FINGERPRINTS: Record<
  string,
  { readonly structural: string; readonly declared: string }
> = JSON.parse(
  await readFile(resolve(packageRoot, "test/fixtures/schema-fingerprints.json"), "utf8"),
);

/**
 * Every spawned child blocks forever by construction (finding MAJ-03.2). If a
 * parent assertion throws before its own `kill` runs, or the readiness line
 * never arrives, the child would survive the whole vitest run. This set plus
 * the unconditional `afterEach` below is the backstop, independent of any
 * individual case's own kill.
 */
const children = new Set<ChildProcess>();

interface CrashResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Spawns the child in `mode` against `path`, waits for `armed`, SIGKILLs it, resolves on close. */
async function runToArmedThenKill(
  mode: "precommit" | "postcommit" | "midmigration",
  path: string,
): Promise<CrashResult> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", childPath, JSON.stringify({ mode, path })],
    {
      // So `--import tsx` resolves from packages/state/node_modules.
      cwd: packageRoot,
      // stderr is PIPED, not ignored (finding MAJ-03.3): unlike the house
      // precedent this shape follows, this child runs migrations and can
      // throw during open/migrate before ever printing `armed`. An
      // unexplained absence of the readiness line with stderr discarded is
      // not diagnosable.
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );
  children.add(child);

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const closed = new Promise<CrashResult>((resolveClose) => {
    child.on("close", (code, signal) => {
      children.delete(child);
      resolveClose({ code, signal });
    });
  });

  // A bounded, named failure rather than a whole-suite timeout. `test/` is
  // exempt from the determinism scan by that scan's own rule, so a real timer
  // is legitimate here.
  await new Promise<void>((resolveArmed, rejectArmed) => {
    const signal = AbortSignal.timeout(30_000);
    const check = (): void => {
      if (stdout.includes('{"type":"armed"}')) {
        signal.removeEventListener("abort", onAbort);
        resolveArmed();
      }
    };
    const onAbort = (): void => {
      rejectArmed(
        new Error(
          `crash child (${mode}) never printed its readiness line.\n` +
            `--- child stderr ---\n${stderr}\n--- child stdout ---\n${stdout}`,
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", check);
    child.on("close", () => {
      signal.removeEventListener("abort", onAbort);
      rejectArmed(
        new Error(`crash child (${mode}) exited before arming.\n--- child stderr ---\n${stderr}`),
      );
    });
    check();
  });

  child.kill("SIGKILL");
  return closed;
}

function countRows(db: StateDatabase, table: string): number {
  const row = internalHandle(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.n ?? -1);
}

function tableExists(db: StateDatabase, table: string): boolean {
  const row = internalHandle(db)
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

/** `state.sqlite` and whichever sidecars exist must all be private (D13, V6). */
function expectPrivateModes(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) {
      expect(statSync(candidate).mode & 0o777).toBe(0o600);
    }
  }
}

let directory: string;
let path: string;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  path = temp.path;
});

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  children.clear();
  await rm(directory, { recursive: true, force: true });
});

function reopen(): StateDatabase {
  return openStateDatabase({ path, clock: createFakeClock(), ids: createDeterministicIds(1) });
}

describe("crash matrix — SIGKILL at three points (T2, C2, AC1)", () => {
  it("precommit: killed between the event insert and the projection write leaves NEITHER row", async () => {
    const result = await runToArmedThenKill("precommit", path);
    expect(result.signal).toBe("SIGKILL");
    expect(result.code).toBeNull();

    const db = reopen();
    try {
      // The C2 pair vanishes together. A store that wrote the event outside
      // the projection's transaction would leave exactly one orphan row here.
      expect(countRows(db, "state_event")).toBe(0);
      expect(countRows(db, "run_projection")).toBe(0);

      const handle = internalHandle(db);
      expect(handle.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      expect(handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expectPrivateModes(path);
    } finally {
      db.close();
    }
  });

  it("postcommit: killed after COMMIT returned leaves BOTH rows durable", async () => {
    const result = await runToArmedThenKill("postcommit", path);
    expect(result.signal).toBe("SIGKILL");

    const db = reopen();
    try {
      // §16.6's mirror image: once the commit returned, the work is done, and
      // an abrupt kill afterwards cannot un-do it. Reopening also recovers
      // the WAL sidecars.
      expect(countRows(db, "state_event")).toBe(1);
      expect(countRows(db, "run_projection")).toBe(1);
      expect(internalHandle(db).prepare("PRAGMA integrity_check").get()?.integrity_check).toBe(
        "ok",
      );
      expectPrivateModes(path);
    } finally {
      db.close();
    }
  });

  it("midmigration: killed inside migration 2 leaves the last fully-applied version, and rolling forward reaches the terminal fingerprint", async () => {
    const result = await runToArmedThenKill("midmigration", path);
    expect(result.signal).toBe("SIGKILL");

    const db = reopen();
    try {
      const handle = internalHandle(db);
      // Migration 1 committed; migration 2 was interrupted inside its own
      // transaction, so neither its version bump nor its objects survive.
      expect(readUserVersion(handle)).toBe(1);
      expect(tableExists(db, "state_event")).toBe(true);
      expect(tableExists(db, "run_projection")).toBe(false);
      expect(handle.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");

      // AC1's "interrupted → rolled forward" as a REAL crash rather than a
      // simulated throw: the same file, migrated the rest of the way, must
      // land on the committed terminal fingerprint.
      runMigrations(db);
      const fingerprint = schemaFingerprint(db);
      const terminal = SCHEMA_FINGERPRINTS["7"];
      expect(terminal).toBeDefined();
      expect(fingerprint.structural).toBe(terminal?.structural);
      expect(fingerprint.declared).toBe(terminal?.declared);
      expectPrivateModes(path);
    } finally {
      db.close();
    }
  });
});
