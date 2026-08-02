/**
 * The signal-handling tier (plan Task 6 Steps 3b, 4, 5) — two real spawns:
 *
 *  1. A drain-gated child proves both the Step 3b drain race (a concurrent
 *     starter's probe genuinely reads `serving`, not `hostile`, while the
 *     first instance is draining, and concedes exit 10 `AlreadyRunning`
 *     rather than refusing exit 11 `ForeignSocketOccupied`) and the second
 *     signal's immediate force-exit (design C9) — from one spawn, using the
 *     `onDraining` coordination hook (`src/runtime/compose.ts`) to hold the
 *     "draining but still bound" window open deterministically instead of
 *     racing real elapsed time (verified empirically: `server.close()` on a
 *     Unix domain socket stops accepting and unlinks the path before any
 *     other code can run, so an unassisted race is not reliably winnable —
 *     see `StartDaemonDeps.onDraining`'s docblock).
 *  2. A plain child proves "connectable implies fully recovered": a real
 *     authenticated `daemon.status` call the instant `{"type":"ready"}`
 *     lands observes `lifecycleState: "serving"` and a populated
 *     `reconciliation` block.
 */

import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createFileSecretStore } from "@heniek/secrets";
import { afterEach, describe, expect, it } from "vitest";
import { CREDENTIAL_ENTRY_NAME } from "../src/auth/credential.js";
import type { AcquireDeps, AcquireOptions } from "../src/lifecycle/acquire.js";
import { acquireClaim } from "../src/lifecycle/acquire.js";
import { AlreadyRunning } from "../src/lifecycle/errors.js";
import type { LifecycleTraceSink } from "../src/ports.js";
import { createSystemClock } from "../src/runtime/clock.js";
import { createSystemHostWitness } from "../src/runtime/host-witness.js";
import { createNodeLockFileSystem } from "../src/runtime/lock-filesystem.js";
import { createSystemProcessLiveness } from "../src/runtime/process-liveness.js";
import { createSystemRandomSource } from "../src/runtime/random-source.js";
import { createNodeSocketProbe } from "../src/runtime/socket-probe.js";
import { createNodeSocketBinder } from "../src/runtime/socket-server.js";
import { fetchDaemonStatusOverSocket } from "./helpers/rpc-client.js";
import {
  type ChildHandle,
  createTempDaemonHome,
  spawnDaemonChild,
  type TempDaemonHome,
  waitForChildClose,
  waitForLine,
} from "./helpers/spawn-daemon-child.js";

function inMemoryTraceSink(): LifecycleTraceSink {
  return { emit: () => undefined };
}

let home: TempDaemonHome | undefined;
let survivors: ChildHandle[] = [];

afterEach(async () => {
  for (const handle of survivors) {
    handle.child.kill("SIGKILL");
  }
  survivors = [];
  if (home !== undefined) {
    await rm(home.directory, { recursive: true, force: true });
    home = undefined;
  }
});

function isReadyLine(line: unknown): boolean {
  return typeof line === "object" && line !== null && (line as { type?: unknown }).type === "ready";
}
function isDrainingLine(line: unknown): boolean {
  return (
    typeof line === "object" && line !== null && (line as { type?: unknown }).type === "draining"
  );
}

describe("real out-of-process signal handling (plan Task 6 Steps 3b, 4)", () => {
  it("drain race (Step 3b): a concurrent in-process second start reads a live `serving` probe and concedes exit 10, " +
    "touching neither file; a second SIGTERM then forces immediate exit without completing the graceful drain", async () => {
    home = await createTempDaemonHome();
    const paths = home.home.paths;

    const child = spawnDaemonChild({
      mode: "start",
      homeDirectory: home.directory,
      drainGate: true,
    });
    survivors.push(child);
    await waitForLine(child, isReadyLine);

    const pidBefore = readFileText(paths.daemonPidFile);
    const socketExistedBefore = existsSync(paths.daemonSocketFile);
    expect(socketExistedBefore).toBe(true);

    child.child.kill("SIGTERM");
    // The `onDraining` hook holds the child here, socket still bound and
    // still answering `daemon.hello` — a deterministic window, not a race.
    await waitForLine(child, isDrainingLine);

    // The second start runs in-process against the real adapters — a
    // second real `fork`/`exec` would face exactly the same window, but
    // the pure decision function is what this assertion actually cares
    // about proving.
    const secondOutcome = await acquireClaim(
      realAcquireDeps(),
      realAcquireOptions(paths.runtimeDirectory, paths.daemonPidFile, paths.daemonSocketFile),
    );
    expect(secondOutcome.kind).toBe("lost");
    if (secondOutcome.kind === "lost") {
      expect(secondOutcome.error).toBeInstanceOf(AlreadyRunning);
    }
    // Touched neither the socket nor the claim file.
    expect(readFileText(paths.daemonPidFile)).toBe(pidBefore);
    expect(existsSync(paths.daemonSocketFile)).toBe(true);

    // A second SIGTERM while still draining escalates to an immediate
    // force-exit (design C9) — never completes the graceful unlink/
    // secret-removal sequence this same file's happy-path is proven
    // elsewhere (`parallel-start.test.ts`'s winner teardown).
    child.child.kill("SIGTERM");
    const closed = await waitForChildClose(child);
    survivors = survivors.filter((handle) => handle !== child);
    expect(closed.signal).toBeNull();
    expect(closed.code).toBe(1);
    // Escalation skips cleanup — the claim and socket are left behind.
    expect(existsSync(paths.daemonPidFile)).toBe(true);
    expect(existsSync(paths.daemonSocketFile)).toBe(true);
  }, 60_000);

  it("connectable implies fully recovered: a real authenticated daemon.status call the instant readiness lands observes " +
    "lifecycleState 'serving' and a populated reconciliation block", async () => {
    home = await createTempDaemonHome();
    const paths = home.home.paths;

    const child = spawnDaemonChild({ mode: "start", homeDirectory: home.directory });
    survivors.push(child);
    await waitForLine(child, isReadyLine);

    const status = await fetchDaemonStatusOverSocket(
      paths.daemonSocketFile,
      paths.secretsDirectory,
    );
    expect(status.lifecycleState).toBe("serving");
    expect(status.reconciliation).toEqual({
      probed: 0,
      resumable: 0,
      failed: 0,
      cancelled: 0,
      unknown: 0,
    });
    expect(status.artifactRecovery).toEqual({
      removedIncoming: 0,
      skippedIncoming: 0,
      unreferencedBlobs: 0,
    });

    child.child.kill("SIGTERM");
    const closed = await waitForChildClose(child);
    survivors = survivors.filter((handle) => handle !== child);
    expect(closed.code).toBe(0);
    const secretStore = createFileSecretStore({ directory: paths.secretsDirectory });
    expect(await secretStore.read(CREDENTIAL_ENTRY_NAME)).toBeUndefined();
  }, 60_000);
});

function readFileText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function realAcquireDeps(): AcquireDeps {
  return {
    lockFileSystem: createNodeLockFileSystem(),
    socketBinder: createNodeSocketBinder(),
    socketProbe: createNodeSocketProbe(),
    processLiveness: createSystemProcessLiveness(),
    hostWitness: createSystemHostWitness(),
    randomSource: createSystemRandomSource(),
    traceSink: inMemoryTraceSink(),
    clock: createSystemClock(),
  };
}

function realAcquireOptions(
  runtimeDirectory: string,
  daemonPidFile: string,
  daemonSocketFile: string,
): AcquireOptions {
  return {
    runtimeDirectory,
    runtimeDirectoryParent: dirname(runtimeDirectory),
    daemonPidFile,
    daemonSocketFile,
    ownPid: process.pid,
  };
}
