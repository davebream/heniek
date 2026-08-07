/**
 * The out-of-process daemon child (plan Task 6 Steps 2-5, 9), mirroring
 * `packages/state/test/helpers/crash-child.ts`'s discipline: a real
 * programme, spawned as a real process via `node --import tsx`, so a parent
 * test can `SIGTERM`/`SIGKILL` it and observe genuine process-level
 * behaviour an in-process fake cannot model.
 *
 * Readiness (and every other signal this child emits) is written with
 * `writeSync(1, …)`, never `console.log` — which is *asynchronous* when
 * connected to a pipe on macOS (synchronous on Linux and Windows), so a line
 * written immediately before the process blocks or hands control back to the
 * event loop could otherwise never flush. `writeSync` is a direct
 * synchronous syscall on every platform.
 *
 * Two directive modes:
 *
 *  - `"start"`: resolves and ensures the application home, mints a
 *    `ScriptedBackend` with an empty script (no runs to reconcile — this
 *    child's job is to prove the *lifecycle*, not reconciliation content),
 *    and calls the real `startDaemon` composition root (design C10, plan
 *    Task 6 Step 8) — the full claim -> probe -> reclaim -> open DB ->
 *    migrate -> recover -> classify -> bind -> publish order, exactly the
 *    production path. Prints the literal `{"type":"ready"}` NDJSON line the
 *    moment the outcome is `"serving"`; a non-serving outcome sets
 *    `process.exitCode` to the design's exit code and returns without ever
 *    printing readiness. When `drainGate` is set, `startDaemon` is given an
 *    `onDraining` hook (plan Task 6 Step 3b) that announces
 *    `{"type":"draining"}` and then blocks — via real, async stdin
 *    line-reading, never a timer or a poll — until the parent writes back
 *    `{"type":"proceed"}\n`, giving the parent a deterministic window in
 *    which the socket is provably still bound and answering `daemon.hello`.
 *
 *  - `"hang-after-takeover-rename"`: calls `acquireClaim` directly (no
 *    `startDaemon` — recovery is irrelevant to this scenario) against a
 *    **decorated** real `LockFileSystem` whose `rename` performs the
 *    genuine `renameSync` and then arms + blocks forever via
 *    `Atomics.wait` — modelling a process `SIGKILL`ed at the exact instant
 *    design C1 step 7's rename-aside takeover has landed but has not yet
 *    unlinked its own scratch aside file, which is what leaves the inert
 *    `.daemon.pid.stale.<hex>` residue plan Task 6 Step 3 asks for.
 *    `process.exit()` would not do here either: it runs handlers and
 *    unwinds cleanly, the opposite of the abrupt kill this models.
 */

import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { ensureApplicationHomeDirectories, resolveApplicationHome } from "@heniek/config";
import type { AcquireDeps, AcquireOptions } from "../../src/lifecycle/acquire.js";
import { acquireClaim } from "../../src/lifecycle/acquire.js";
import { createSystemClock } from "../../src/runtime/clock.js";
import { startDaemon } from "../../src/runtime/compose.js";
import { createSystemHostWitness } from "../../src/runtime/host-witness.js";
import { createNodeLockFileSystem } from "../../src/runtime/lock-filesystem.js";
import { createSystemProcessLiveness } from "../../src/runtime/process-liveness.js";
import { createSystemRandomSource } from "../../src/runtime/random-source.js";
import { createNodeSocketProbe } from "../../src/runtime/socket-probe.js";
import { createNodeSocketBinder } from "../../src/runtime/socket-server.js";
import { createStderrTraceSink } from "../../src/runtime/trace-sink.js";
import { createScriptedBackend } from "./scripted-backend.js";

type Directive =
  | { readonly mode: "start"; readonly homeDirectory: string; readonly drainGate?: boolean }
  | { readonly mode: "hang-after-takeover-rename"; readonly homeDirectory: string };

function writeLine(payload: unknown): void {
  writeSync(1, `${JSON.stringify(payload)}\n`);
}

/** A real, synchronous, indefinite block — no timer and no polling loop. */
function blockForever(): never {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("daemon-child: Atomics.wait returned unexpectedly");
}

/** Resolves the moment a `{"type":"proceed"}` line arrives on stdin — genuine async I/O, not a poll. */
function waitForProceedOnStdin(): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === "proceed"
      ) {
        rl.close();
        resolve();
      }
    });
  });
}

async function runStart(directive: {
  readonly homeDirectory: string;
  readonly drainGate?: boolean;
}): Promise<void> {
  const home = resolveApplicationHome({
    platform: "linux",
    env: { HENIEK_HOME: directive.homeDirectory },
    homeDirectory: directive.homeDirectory,
  });
  await ensureApplicationHomeDirectories(home);

  const backend = createScriptedBackend({});

  const outcome = await startDaemon({
    home,
    backend,
    ...(directive.drainGate === true
      ? {
          onDraining: async (): Promise<void> => {
            writeLine({ type: "draining" });
            await waitForProceedOnStdin();
          },
        }
      : {}),
  });

  if (outcome.kind === "exited") {
    process.exitCode = outcome.exitCode;
    return;
  }

  writeLine({ type: "ready", instanceId: outcome.instanceId, pid: process.pid });
  await outcome.stopped;
  process.exitCode = 0;
}

async function runHangAfterTakeoverRename(directive: {
  readonly homeDirectory: string;
}): Promise<void> {
  const home = resolveApplicationHome({
    platform: "linux",
    env: { HENIEK_HOME: directive.homeDirectory },
    homeDirectory: directive.homeDirectory,
  });
  await ensureApplicationHomeDirectories(home);

  const real = createNodeLockFileSystem();
  const deps: AcquireDeps = {
    lockFileSystem: {
      createExclusive: (path, mode) => real.createExclusive(path, mode),
      link: (existingPath, newPath) => real.link(existingPath, newPath),
      readFile: (path, maxBytes) => real.readFile(path, maxBytes),
      lstat: (path) => real.lstat(path),
      unlink: (path) => real.unlink(path),
      chmod: (path, mode) => real.chmod(path, mode),
      // The real rename happens first — this is what actually produces the
      // `.daemon.pid.stale.<hex>` residue on disk — then this process is
      // frozen exactly there, before it can ever unlink the aside file or
      // complete its own fresh claim.
      rename: (fromPath, toPath) => {
        real.rename(fromPath, toPath);
        writeLine({ type: "ready" });
        blockForever();
      },
    },
    socketBinder: createNodeSocketBinder(),
    socketProbe: createNodeSocketProbe(),
    processLiveness: createSystemProcessLiveness(),
    hostWitness: createSystemHostWitness(),
    randomSource: createSystemRandomSource(),
    traceSink: createStderrTraceSink(),
    clock: createSystemClock(),
  };

  const options: AcquireOptions = {
    runtimeDirectory: home.paths.runtimeDirectory,
    runtimeDirectoryParent: directive.homeDirectory,
    daemonPidFile: home.paths.daemonPidFile,
    daemonSocketFile: home.paths.daemonSocketFile,
    ownPid: process.pid,
  };

  await acquireClaim(deps, options);
  throw new Error("daemon-child: hang-after-takeover-rename returned unexpectedly");
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (raw === undefined) {
    throw new Error("daemon-child: missing directive argument");
  }
  const directive: Directive = JSON.parse(raw);

  if (directive.mode === "start") {
    await runStart(directive);
    return;
  }
  await runHangAfterTakeoverRename(directive);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
