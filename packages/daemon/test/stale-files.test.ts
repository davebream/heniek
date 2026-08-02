/**
 * The stale-file / crash-residue tier (plan Task 6 Step 3). Six scenarios,
 * tiered exactly per the plan's Step 3 table — four refusal/concede rows
 * carry no signal semantics and no crash semantics, so they run **in-process**
 * against the real `src/runtime/**` adapters (zero spawns); the two that
 * genuinely need a real `SIGKILL` run **out-of-process** (four spawns
 * total, two children each).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcquireDeps, AcquireOptions } from "../src/lifecycle/acquire.js";
import { acquireClaim } from "../src/lifecycle/acquire.js";
import { serialiseClaimRecord } from "../src/lifecycle/claim-record.js";
import { ClaimInProgress, PidFileNamesLiveProcess } from "../src/lifecycle/errors.js";
import type { LifecycleTraceSink } from "../src/ports.js";
import { createSystemClock } from "../src/runtime/clock.js";
import { createSystemHostWitness } from "../src/runtime/host-witness.js";
import { createNodeLockFileSystem } from "../src/runtime/lock-filesystem.js";
import { createSystemProcessLiveness } from "../src/runtime/process-liveness.js";
import { createSystemRandomSource } from "../src/runtime/random-source.js";
import { createNodeSocketProbe } from "../src/runtime/socket-probe.js";
import { createNodeSocketBinder } from "../src/runtime/socket-server.js";
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

// A pid comfortably beyond any real system's `pid_max` (2^31 is this
// package's own grammar ceiling; real kernels cap far lower) — always dead,
// with no throwaway spawn needed to manufacture one.
const DEFINITELY_DEAD_PID = 2_000_000_000;

// ---------------------------------------------------------------------------
// In-process tier (plan Task 6 Step 3's table) — real filesystem adapters,
// zero process spawns.
// ---------------------------------------------------------------------------

interface InProcessHarness {
  readonly directory: string;
  readonly deps: AcquireDeps;
  readonly options: AcquireOptions;
}

async function makeInProcessHarness(): Promise<InProcessHarness> {
  const directory = await mkdtemp(join(tmpdir(), "heniek-daemon-stale-"));
  const runtimeDirectory = join(directory, "runtime");
  mkdirSync(runtimeDirectory, { mode: 0o700 });

  const deps: AcquireDeps = {
    lockFileSystem: createNodeLockFileSystem(),
    socketBinder: createNodeSocketBinder(),
    socketProbe: createNodeSocketProbe(),
    processLiveness: createSystemProcessLiveness(),
    hostWitness: createSystemHostWitness(),
    randomSource: createSystemRandomSource(),
    traceSink: inMemoryTraceSink(),
    clock: createSystemClock(),
  };
  const options: AcquireOptions = {
    runtimeDirectory,
    runtimeDirectoryParent: directory,
    daemonPidFile: join(runtimeDirectory, "daemon.pid"),
    daemonSocketFile: join(runtimeDirectory, "daemon.sock"),
    ownPid: process.pid,
  };
  return { directory, deps, options };
}

describe("stale-file scenarios — in-process tier over the real runtime adapters (plan Task 6 Step 3)", () => {
  let harness: InProcessHarness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await rm(harness.directory, { recursive: true, force: true });
      harness = undefined;
    }
  });

  it("dead-PID takeover: a serving record naming a reaped pid, matching boot witness, is taken over and the fresh claim reaches acquired", async () => {
    harness = await makeInProcessHarness();
    const bootWitness = createSystemHostWitness().current();
    writeFileSync(
      harness.options.daemonPidFile,
      serialiseClaimRecord({
        recordVersion: 1,
        state: "serving",
        pid: DEFINITELY_DEAD_PID,
        bootWitness,
        instanceId: "deadbeefdeadbeefdeadbeefdeadbeef",
      }),
      { mode: 0o600 },
    );

    const outcome = await acquireClaim(harness.deps, harness.options);
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind === "acquired") {
      await outcome.socket.close();
      outcome.handle.release();
    }
  });

  it("live-foreign-PID refusal: a serving record naming this test's own (guaranteed-alive) pid is refused, never signalled, both files intact", async () => {
    harness = await makeInProcessHarness();
    const bootWitness = createSystemHostWitness().current();
    writeFileSync(
      harness.options.daemonPidFile,
      serialiseClaimRecord({
        recordVersion: 1,
        state: "serving",
        pid: process.pid,
        bootWitness,
        instanceId: "deadbeefdeadbeefdeadbeefdeadbeef",
      }),
      { mode: 0o600 },
    );
    const before = readFileSync(harness.options.daemonPidFile, "utf8");

    const outcome = await acquireClaim(harness.deps, harness.options);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.error).toBeInstanceOf(PidFileNamesLiveProcess);
    }
    expect(existsSync(harness.options.daemonSocketFile)).toBe(false);
    expect(readFileSync(harness.options.daemonPidFile, "utf8")).toBe(before);
  });

  it("symlinked claim file: refused with InsecureClaimFile, never followed", async () => {
    harness = await makeInProcessHarness();
    symlinkSync(join(harness.directory, "elsewhere"), harness.options.daemonPidFile);

    const outcome = await acquireClaim(harness.deps, harness.options);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.error.name).toBe("InsecureClaimFile");
    }
  });

  it("symlinked socket file: refused with InsecureSocketPath, never followed or removed", async () => {
    harness = await makeInProcessHarness();
    const target = join(harness.directory, "not-a-socket.txt");
    writeFileSync(target, "not a socket");
    symlinkSync(target, harness.options.daemonSocketFile);

    const outcome = await acquireClaim(harness.deps, harness.options);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.error.name).toBe("InsecureSocketPath");
    }
  });

  it("claim-in-progress concede: an unterminated record (a torn write held open by this test) is conceded, never taken over", async () => {
    harness = await makeInProcessHarness();
    // Simulates another process mid-write: a complete, LF-*less* record —
    // the closed grammar's own rule (design C3) is that this is never
    // "stale", regardless of content.
    const handle = createNodeLockFileSystem().createExclusive(harness.options.daemonPidFile, 0o600);
    try {
      handle.write("heniek-daemon\t1\tclaiming\t1\t-\tabc");
      handle.sync();

      const outcome = await acquireClaim(harness.deps, harness.options);
      expect(outcome.kind).toBe("lost");
      if (outcome.kind === "lost") {
        expect(outcome.error).toBeInstanceOf(ClaimInProgress);
      }
      expect(existsSync(harness.options.daemonSocketFile)).toBe(false);
    } finally {
      handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Out-of-process tier — real SIGKILL, real residue (plan Task 6 Step 3).
// ---------------------------------------------------------------------------

let home: TempDaemonHome | undefined;
let survivors: ChildHandle[] = [];

afterEach(() => {
  for (const handle of survivors) {
    handle.child.kill("SIGKILL");
  }
  survivors = [];
  if (home !== undefined) {
    rmSync(home.directory, { recursive: true, force: true });
    home = undefined;
  }
});

function isReadyLine(line: unknown): boolean {
  return typeof line === "object" && line !== null && (line as { type?: unknown }).type === "ready";
}

describe("real out-of-process SIGKILL residue (plan Task 6 Step 3)", () => {
  it("a SIGKILLed daemon's leftover socket inode is reclaimed and rebound by the very next start", async () => {
    home = await createTempDaemonHome();
    const paths = home.home.paths;

    const first = spawnDaemonChild({ mode: "start", homeDirectory: home.directory });
    survivors.push(first);
    await waitForLine(first, isReadyLine);

    first.child.kill("SIGKILL");
    const firstClosed = await waitForChildClose(first);
    survivors = survivors.filter((handle) => handle !== first);
    expect(firstClosed.signal).toBe("SIGKILL");
    expect(firstClosed.code).toBeNull();

    // The residue is real: the claim record and the socket inode both
    // survive a SIGKILL, still naming the now-dead first child.
    expect(existsSync(paths.daemonPidFile)).toBe(true);
    expect(existsSync(paths.daemonSocketFile)).toBe(true);

    const second = spawnDaemonChild({ mode: "start", homeDirectory: home.directory });
    survivors.push(second);
    const secondLine = (await waitForLine(second, isReadyLine)) as { readonly pid: number };

    // Reclaimed and rebound — a *fresh* socket at the same path, owned by
    // the new holder, not the SIGKILLed orphan.
    expect(existsSync(paths.daemonSocketFile)).toBe(true);
    const record = readFileSync(paths.daemonPidFile, "utf8");
    expect(record).toContain(`\t${secondLine.pid}\t`);

    second.child.kill("SIGTERM");
    const secondClosed = await waitForChildClose(second);
    survivors = survivors.filter((handle) => handle !== second);
    expect(secondClosed.code).toBe(0);
  }, 60_000);

  it("SIGKILL mid-takeover leaves an inert .daemon.pid.stale.<hex> residue that does not block the next startup", async () => {
    home = await createTempDaemonHome();
    const paths = home.home.paths;
    const bootWitness = createSystemHostWitness().current();

    // Seeds an orphaned claim (dead pid, matching boot witness) so the
    // next contender's own claim attempt collides (EEXIST) and is
    // classified "orphaned" -> takeover.
    writeFileSync(
      paths.daemonPidFile,
      serialiseClaimRecord({
        recordVersion: 1,
        state: "serving",
        pid: DEFINITELY_DEAD_PID,
        bootWitness,
        instanceId: "deadbeefdeadbeefdeadbeefdeadbeef",
      }),
      { mode: 0o600 },
    );

    const contender = spawnDaemonChild({
      mode: "hang-after-takeover-rename",
      homeDirectory: home.directory,
    });
    survivors.push(contender);
    // Readiness here means: the real `renameSync` aside has already
    // landed on disk, and this process is now frozen before it can ever
    // unlink the aside file or complete its own fresh claim.
    await waitForLine(contender, isReadyLine);

    contender.child.kill("SIGKILL");
    const contenderClosed = await waitForChildClose(contender);
    survivors = survivors.filter((handle) => handle !== contender);
    expect(contenderClosed.signal).toBe("SIGKILL");

    // The original claim path is gone (renamed aside); exactly one inert
    // `.daemon.pid.stale.<hex>` residue is left behind, never cleaned.
    expect(existsSync(paths.daemonPidFile)).toBe(false);
    const staleEntries = readdirSync(dirname(paths.daemonPidFile)).filter((name) =>
      name.startsWith(".daemon.pid.stale."),
    );
    expect(staleEntries).toHaveLength(1);

    // The next ordinary start must succeed regardless — the residue is
    // inert by construction, never a poison pill.
    const restarted = spawnDaemonChild({ mode: "start", homeDirectory: home.directory });
    survivors.push(restarted);
    await waitForLine(restarted, isReadyLine);
    expect(existsSync(paths.daemonPidFile)).toBe(true);

    // Untouched — acquireClaim never references a scratch name it does
    // not itself recognise.
    const staleEntriesAfter = readdirSync(dirname(paths.daemonPidFile)).filter((name) =>
      name.startsWith(".daemon.pid.stale."),
    );
    expect(staleEntriesAfter).toEqual(staleEntries);

    restarted.child.kill("SIGTERM");
    const restartedClosed = await waitForChildClose(restarted);
    survivors = survivors.filter((handle) => handle !== restarted);
    expect(restartedClosed.code).toBe(0);
  }, 60_000);
});
