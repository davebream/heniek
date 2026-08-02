/**
 * Permission and identity coverage for the real `src/runtime/**` adapters
 * (design C1/OR-20, plan Task 5 Steps 1, 7, and 9) — everything that needs
 * a real filesystem, a real socket, or a real process to prove, as opposed
 * to the pure-core coverage `test/acquire.test.ts` already gives every row
 * of the design's C9 transition table against `FakeLockFileSystem`.
 *
 * Section A runs `acquireClaim` (design C1) over the **real** adapters —
 * `createNodeLockFileSystem`, `createNodeSocketBinder`,
 * `createNodeSocketProbe`, `createSystemProcessLiveness`,
 * `createSystemHostWitness`, `createSystemRandomSource` — against a real
 * `mkdtemp` home outside the repository, proving the real adapters satisfy
 * the same contract the fake already proved the pure core honours.
 *
 * Section B drives `createSystemProcessLiveness().isAlive` through all
 * three of its documented branches (plan-review round 1, finding m2) via a
 * stubbed `process.kill`, since reliably provoking a genuine `EPERM` from
 * `kill(pid, 0)` needs a foreign-uid process this sandbox cannot arrange.
 *
 * Section C is the close-on-exec assertion (plan Task 5 Step 9): a real
 * child process must never inherit the claim fd. Linux-only (`/proc/self/fd`
 * introspection), consistent with `src/runtime/host-witness.ts`'s own
 * Linux/Darwin/other split.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AcquireDeps, type AcquireOptions, acquireClaim } from "../src/lifecycle/acquire.js";
import type { LifecycleTraceSink } from "../src/ports.js";
import { createSystemHostWitness } from "../src/runtime/host-witness.js";
import { createNodeLockFileSystem } from "../src/runtime/lock-filesystem.js";
import { createSystemProcessLiveness } from "../src/runtime/process-liveness.js";
import { createSystemRandomSource } from "../src/runtime/random-source.js";
import { createNodeSocketProbe } from "../src/runtime/socket-probe.js";
import { createNodeSocketBinder } from "../src/runtime/socket-server.js";

function inMemoryTraceSink(): LifecycleTraceSink {
  return { emit: () => undefined };
}

interface Harness {
  readonly home: string;
  readonly runtimeDirectory: string;
  readonly pidFile: string;
  readonly socketFile: string;
  readonly deps: AcquireDeps;
  readonly options: AcquireOptions;
}

async function makeHarness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "heniek-daemon-runtime-"));
  const runtimeDirectory = join(home, "runtime");
  mkdirSync(runtimeDirectory, { mode: 0o700 });

  const deps: AcquireDeps = {
    lockFileSystem: createNodeLockFileSystem(),
    socketBinder: createNodeSocketBinder(),
    socketProbe: createNodeSocketProbe(),
    processLiveness: createSystemProcessLiveness(),
    hostWitness: createSystemHostWitness(),
    randomSource: createSystemRandomSource(),
    traceSink: inMemoryTraceSink(),
  };

  const options: AcquireOptions = {
    runtimeDirectory,
    runtimeDirectoryParent: home,
    daemonPidFile: join(runtimeDirectory, "daemon.pid"),
    daemonSocketFile: join(runtimeDirectory, "daemon.sock"),
    ownPid: process.pid,
  };

  return {
    home,
    runtimeDirectory,
    pidFile: options.daemonPidFile,
    socketFile: options.daemonSocketFile,
    deps,
    options,
  };
}

describe("acquireClaim over the real runtime adapters (design C1, OR-20)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await rm(harness.home, { recursive: true, force: true });
  });

  it("acquires cold-start and leaves the claim file at mode 0600", async () => {
    const outcome = await acquireClaim(harness.deps, harness.options);
    expect(outcome.kind).toBe("acquired");
    try {
      expect(lstatSync(harness.pidFile).mode & 0o777).toBe(0o600);
    } finally {
      if (outcome.kind === "acquired") {
        await outcome.socket.close();
        outcome.handle.release();
      }
    }
  });

  it("leaves the bound socket at mode 0600 after acquire (defence in depth over the 0700 runtime directory)", async () => {
    const outcome = await acquireClaim(harness.deps, harness.options);
    expect(outcome.kind).toBe("acquired");
    try {
      expect(lstatSync(harness.socketFile).mode & 0o777).toBe(0o600);
    } finally {
      if (outcome.kind === "acquired") {
        await outcome.socket.close();
        outcome.handle.release();
      }
    }
  });

  it("refuses a symlinked claim path with InsecureClaimFile, never following it", async () => {
    const elsewhere = join(harness.home, "elsewhere");
    symlinkSync(elsewhere, harness.pidFile);

    const outcome = await acquireClaim(harness.deps, harness.options);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.error.name).toBe("InsecureClaimFile");
    }
    // The symlink itself is untouched — proves the refusal never followed it.
    expect(lstatSync(harness.pidFile).isSymbolicLink()).toBe(true);
  });

  it("refuses a symlinked socket path with InsecureSocketPath, never following or removing it", async () => {
    // The symlink's target must itself make `connect()` fail ECONNREFUSED
    // (`no-listener`) — a dangling symlink instead yields ENOENT (`absent`),
    // which never reaches the reclaim path this refusal lives in. A plain
    // regular file behind the symlink reproduces ECONNREFUSED without the
    // complexity of standing up a real orphaned socket (verified
    // empirically: connecting through a symlink to a non-socket regular
    // file yields ECONNREFUSED on Linux).
    const target = join(harness.home, "not-a-socket.txt");
    writeFileSync(target, "not a socket");
    symlinkSync(target, harness.socketFile);

    const outcome = await acquireClaim(harness.deps, harness.options);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.error.name).toBe("InsecureSocketPath");
    }
    // The symlink itself is untouched — proves the refusal never followed
    // or removed it.
    expect(lstatSync(harness.socketFile).isSymbolicLink()).toBe(true);
  });

  it("refuses a group/world-accessible runtime directory with InsecureRuntimeDirectory", async () => {
    rmSync(harness.runtimeDirectory, { recursive: true, force: true });
    mkdirSync(harness.runtimeDirectory, { mode: 0o755 });

    const outcome = await acquireClaim(harness.deps, harness.options);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.error.name).toBe("InsecureRuntimeDirectory");
    }
    // Nothing was created inside the insecure directory.
    expect(readdirSync(harness.runtimeDirectory)).toEqual([]);
  });
});

describe("createSystemProcessLiveness().isAlive — errno branches (plan-review round 1, finding m2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when the process actually exists (self)", () => {
    const liveness = createSystemProcessLiveness();
    expect(liveness.isAlive(process.pid)).toBe(true);
  });

  it("returns false on ESRCH — the process does not exist", () => {
    const error = Object.assign(new Error("no such process"), { code: "ESRCH" });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });
    const liveness = createSystemProcessLiveness();
    expect(liveness.isAlive(999_999)).toBe(false);
  });

  it("returns true on EPERM — the process exists but is not ours (never classify as orphaned)", () => {
    const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });
    const liveness = createSystemProcessLiveness();
    expect(liveness.isAlive(1)).toBe(true);
  });

  it("rethrows every other errno", () => {
    const error = Object.assign(new Error("invalid argument"), { code: "EINVAL" });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });
    const liveness = createSystemProcessLiveness();
    expect(() => liveness.isAlive(1)).toThrow(error);
  });

  it("uid() reports this process's real uid, never process.pid or a constant", () => {
    const liveness = createSystemProcessLiveness();
    expect(liveness.uid()).toBe(process.getuid?.() ?? -1);
  });
});

describe("close-on-exec — the claim fd is never inherited by a spawned child (plan Task 5 Step 9)", () => {
  it.skipIf(process.platform !== "linux")(
    "a spawned child sees no open fd pointing at the claim file",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "heniek-daemon-cloexec-"));
      try {
        const claimPath = join(home, "daemon.pid");
        const handle = createNodeLockFileSystem().createExclusive(claimPath, 0o600);
        try {
          handle.write("heniek-daemon\t1\tclaiming\t1\t-\tabc\n");
          handle.sync();

          const child = spawnSync(
            process.execPath,
            [
              "-e",
              `
const fs = require("node:fs");
const hits = [];
try {
  for (const entry of fs.readdirSync("/proc/self/fd")) {
    try {
      const target = fs.readlinkSync("/proc/self/fd/" + entry);
      if (target.includes(${JSON.stringify(claimPath)})) hits.push(entry);
    } catch {}
  }
} catch {}
process.stdout.write(JSON.stringify(hits));
`,
            ],
            { encoding: "utf8" },
          );

          expect(child.status).toBe(0);
          const hits: string[] = JSON.parse(child.stdout);
          expect(hits).toEqual([]);
        } finally {
          handle.close();
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
