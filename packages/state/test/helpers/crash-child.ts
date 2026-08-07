/**
 * The crash child (plan Task 6.1). A real programme, spawned as a real
 * process, so the parent can `SIGKILL` it. `process.exit()` is **not**
 * equivalent: it runs exit handlers and unwinds cleanly, which is precisely
 * the behaviour a durability test must not rely on.
 *
 * Every mode prints one NDJSON readiness line and then blocks forever. The
 * parent kills it at that point and inspects the file that is left behind.
 */

import { writeSync } from "node:fs";
import { commitStateChange } from "../../src/command/commit.js";
import { internalHandle, openStateDatabase } from "../../src/database/open.js";
import type { Clock } from "../../src/determinism.js";
import { MIGRATIONS } from "../../src/migrations/list.js";
import { runMigrationList, runMigrations } from "../../src/migrations/migrate.js";
import type { Migration } from "../../src/migrations/migration.js";

interface Directive {
  readonly mode: "precommit" | "postcommit" | "midmigration";
  readonly path: string;
}

/**
 * `writeSync` on fd 1, never `console.log`/`process.stdout.write` (finding
 * MAJ-03.1). `process.stdout` is *asynchronous* when connected to a pipe on
 * macOS (synchronous on Linux and Windows), so a line issued immediately
 * before the process blocks the event loop forever may never flush there —
 * hanging the parent indefinitely. `writeSync` is a direct synchronous
 * syscall on every platform.
 */
function arm(): void {
  writeSync(1, `${JSON.stringify({ type: "armed" })}\n`);
}

/**
 * A real, synchronous, indefinite block — no timer and no polling loop (R9).
 * The process can only leave this state by being killed, which is exactly the
 * abrupt termination these tests model.
 */
function blockForever(): never {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  // Unreachable: `Atomics.wait` on a value that never changes never returns.
  throw new Error("crash-child: Atomics.wait returned unexpectedly");
}

function armAndBlock(): never {
  arm();
  return blockForever();
}

/** A clock that arms and blocks on its Nth read, letting earlier reads through. */
function createArmingClock(armOnCall: number): Clock {
  let calls = 0;
  return {
    nowIso: () => {
      calls += 1;
      if (calls === armOnCall) {
        armAndBlock();
      }
      return new Date(Date.UTC(2026, 0, 1)).toISOString();
    },
  };
}

const ids = (() => {
  let counter = 0;
  return {
    next: (prefix: string): string => {
      counter += 1;
      return `${prefix}-crash-${String(counter).padStart(4, "0")}`;
    },
  };
})();

function main(): void {
  const raw = process.argv[2];
  if (raw === undefined) {
    throw new Error("crash-child: missing directive argument");
  }
  const directive: Directive = JSON.parse(raw);

  if (directive.mode === "midmigration") {
    // Task 2.4's package-private seam (finding CRIT-03), reached by relative
    // import because this script lives under packages/state/test/helpers/.
    const db = openStateDatabase({
      path: directive.path,
      clock: createArmingClock(Number.POSITIVE_INFINITY),
      ids,
    });
    // A user-defined SQL function is the only way to suspend execution
    // *inside* a migration's transaction: `runMigrationList` executes plain
    // statement strings, and SQL has no primitive that blocks.
    internalHandle(db).function("arm_and_block", () => armAndBlock());

    const doctored: Migration[] = MIGRATIONS.map((migration) => {
      if (migration.version !== 2) {
        return migration;
      }
      const statements = [...migration.statements];
      statements[1] = "SELECT arm_and_block()";
      return { version: migration.version, name: migration.name, statements };
    });

    runMigrationList(db, doctored);
    throw new Error("crash-child: midmigration returned unexpectedly");
  }

  if (directive.mode === "postcommit") {
    const db = openStateDatabase({
      path: directive.path,
      clock: createArmingClock(Number.POSITIVE_INFINITY),
      ids,
    });
    runMigrations(db);
    commitStateChange(db, {
      runId: "run-1",
      type: "run.created",
      payload: { runId: "run-1", codebaseId: "cb-1" },
    });
    // The COMMIT has returned; everything below models a process that dies
    // after the store told it the work was durable.
    armAndBlock();
  }

  // precommit — the clock's SECOND read sits exactly at the C2 boundary: the
  // event row has been inserted, no projection row has been written yet.
  const db = openStateDatabase({
    path: directive.path,
    clock: createArmingClock(2),
    ids,
  });
  runMigrations(db);
  commitStateChange(db, {
    runId: "run-1",
    type: "run.created",
    payload: { runId: "run-1", codebaseId: "cb-1" },
  });
  throw new Error("crash-child: precommit returned unexpectedly");
}

main();
