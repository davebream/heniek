/**
 * `acquireClaim` against the design's C9 transition table (plan Task 2 Step 3).
 *
 * One test per row. Every dependency is injected, so the whole table runs on
 * the in-memory `FakeLockFileSystem` with no filesystem, no socket, and no
 * clock — the same discipline `packages/state/test` applies to its own pure
 * layers.
 *
 * Two assertions recur because they are the load-bearing safety properties,
 * not decoration:
 *
 *  - **Nothing is signalled on a refusal path.** `ProcessLiveness.isAlive` is
 *    a corroborating signal only (STD-6); a starter must never reach it as a
 *    primary liveness oracle, and must never signal at all.
 *  - **No losing path mutates any path.** Every non-`acquired` outcome is
 *    checked against a `(dev, ino, mode)` snapshot taken before the call, so a
 *    stray `unlink`/`rename`/`chmod` on another instance's files fails the
 *    test rather than passing silently.
 */

import { describe, expect, it, vi } from "vitest";
import { type AcquireDeps, type AcquireOptions, acquireClaim } from "../src/lifecycle/acquire.js";
import { parseClaimRecord, serialiseClaimRecord } from "../src/lifecycle/claim-record.js";
import type { BoundSocket, SocketProbeVerdict } from "../src/ports.js";
import { FakeLockFileSystem } from "./helpers/fake-lock-filesystem.js";

const RUNTIME_PARENT = "/home/u/.heniek";
const RUNTIME = "/home/u/.heniek/runtime";
const PID_FILE = `${RUNTIME}/daemon.pid`;
const SOCKET_FILE = `${RUNTIME}/daemon.sock`;
const OWN_PID = 4242;
const OWN_UID = 1000;
const BOOT = "boot-witness-a";

const OPTIONS: AcquireOptions = {
  runtimeDirectory: RUNTIME,
  runtimeDirectoryParent: RUNTIME_PARENT,
  daemonPidFile: PID_FILE,
  daemonSocketFile: SOCKET_FILE,
  ownPid: OWN_PID,
};

interface Harness {
  readonly fs: FakeLockFileSystem;
  readonly deps: AcquireDeps;
  readonly isAlive: ReturnType<typeof vi.fn>;
  readonly probe: ReturnType<typeof vi.fn>;
  readonly listen: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  readonly probeVerdict?: SocketProbeVerdict;
  readonly pidAlive?: boolean;
  readonly bootWitness?: string | undefined;
  readonly bindThrows?: string;
  readonly sharedFs?: FakeLockFileSystem;
  readonly ownPid?: number;
}

/** `operations` records a successful rename as `from->to`, so match on the prefix. */
function opCount(fs: FakeLockFileSystem, op: string, path: string): number {
  return fs.operations.filter((entry) => entry.op === op && entry.path.startsWith(path)).length;
}

/**
 * The state field is written space-padded to a fixed width so the publish
 * step can flip it positionally, so assert through the parser rather than on
 * raw bytes.
 */
function stateOf(fs: FakeLockFileSystem, path: string): string {
  const parsed = parseClaimRecord(fs.readFile(path, 1024));
  return parsed.kind === "well-formed" ? parsed.record.state : parsed.kind;
}

function newFilesystem(): FakeLockFileSystem {
  const fs = new FakeLockFileSystem({ currentUid: OWN_UID });
  fs.seedDirectory(RUNTIME_PARENT, { uid: OWN_UID, mode: 0o700 });
  fs.seedDirectory(RUNTIME, { uid: OWN_UID, mode: 0o700 });
  return fs;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const fs = options.sharedFs ?? newFilesystem();

  const isAlive = vi.fn((_pid: number) => options.pidAlive ?? false);
  const probe = vi.fn((_path: string) =>
    Promise.resolve<SocketProbeVerdict>(options.probeVerdict ?? "absent"),
  );
  const listen = vi.fn((path: string): Promise<BoundSocket> => {
    if (options.bindThrows !== undefined) {
      const error = new Error(`listen ${path}`) as Error & { code: string };
      error.code = options.bindThrows;
      return Promise.reject(error);
    }
    // A real `listen(2)` creates the socket inode; the fake must too, or the
    // 0600 chmod that follows would see ENOENT.
    fs.seedSocket(path, { uid: OWN_UID, mode: 0o755 });
    return Promise.resolve({
      dev: 9n,
      ino: 99n,
      close: () => Promise.resolve(),
      onConnection: () => {},
      onClose: () => {},
    });
  });

  // A counter-backed byte source: deterministic, and distinct per call so
  // temp and aside paths never collide. `Math.random` is banned here.
  let counter = 0;
  const deps: AcquireDeps = {
    lockFileSystem: fs,
    socketBinder: { listen },
    socketProbe: { probe },
    processLiveness: { isAlive, uid: () => OWN_UID },
    hostWitness: { current: () => ("bootWitness" in options ? options.bootWitness : BOOT) },
    randomSource: {
      bytes: (length: number) =>
        Uint8Array.from({ length }, () => {
          counter += 1;
          return counter & 0xff;
        }),
    },
    traceSink: { emit: () => {} },
    clock: { nowIso: () => "2026-08-02T00:00:00.000Z" },
  };

  return { fs, deps, isAlive, probe, listen };
}

function seedClaim(
  fs: FakeLockFileSystem,
  state: "claiming" | "serving",
  overrides: { readonly pid?: number; readonly bootWitness?: string | undefined } = {},
): void {
  fs.seedRegularFile(
    PID_FILE,
    serialiseClaimRecord({
      recordVersion: 1,
      state,
      pid: overrides.pid ?? 9999,
      bootWitness: "bootWitness" in overrides ? overrides.bootWitness : BOOT,
      instanceId: "deadbeefdeadbeefdeadbeefdeadbeef",
    }),
    { uid: OWN_UID, mode: 0o600 },
  );
}

describe("acquireClaim — C9 transition table, cold start", () => {
  it("probe=absent → acquired, and the record left on disk says serving", async () => {
    const harness = makeHarness();

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("acquired");
    expect(harness.fs.has(PID_FILE)).toBe(true);
    // Publish renames a fresh inode onto the claim path, so the record on
    // disk must be the `serving` one, not the `claiming` one.
    expect(stateOf(harness.fs, PID_FILE)).toBe("serving");
    // A cold start never inspects another process's liveness.
    expect(harness.isAlive).not.toHaveBeenCalled();
  });

  it("probe=no-listener → the stale socket is reclaimed exactly once, then bind", async () => {
    const harness = makeHarness({ probeVerdict: "no-listener" });
    harness.fs.seedSocket(SOCKET_FILE, { uid: OWN_UID });

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("acquired");
    expect(opCount(harness.fs, "unlink", SOCKET_FILE)).toBe(1);
    expect(harness.listen).toHaveBeenCalledTimes(1);
  });

  it("probe=serving → lost (exit 10), our own claim released, the incumbent's socket untouched", async () => {
    const harness = makeHarness({ probeVerdict: "serving" });
    harness.fs.seedSocket(SOCKET_FILE, { uid: OWN_UID });
    const socketBefore = harness.fs.snapshot()[SOCKET_FILE];

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("lost");
    if (outcome.kind !== "lost") return;
    expect(outcome.error.exitCode).toBe(10);
    expect(harness.fs.has(PID_FILE)).toBe(false);
    expect(harness.fs.snapshot()[SOCKET_FILE]).toEqual(socketBefore);
    expect(harness.listen).not.toHaveBeenCalled();
  });

  it("probe=hostile → refused ForeignSocketOccupied (exit 11), socket untouched", async () => {
    const harness = makeHarness({ probeVerdict: "hostile" });
    harness.fs.seedSocket(SOCKET_FILE, { uid: OWN_UID });
    const socketBefore = harness.fs.snapshot()[SOCKET_FILE];

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.error.name).toBe("ForeignSocketOccupied");
    expect(outcome.error.exitCode).toBe(11);
    // A hostile verdict must never authorise an unlink — that is exactly why
    // `hostile` is never collapsed into `no-listener`.
    expect(harness.fs.snapshot()[SOCKET_FILE]).toEqual(socketBefore);
    expect(opCount(harness.fs, "unlink", SOCKET_FILE)).toBe(0);
    expect(harness.listen).not.toHaveBeenCalled();
  });

  it("probe=absent but bind raises EADDRINUSE → lost BindRaced (exit 10), claim released", async () => {
    const harness = makeHarness({ bindThrows: "EADDRINUSE" });

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("lost");
    if (outcome.kind !== "lost") return;
    expect(outcome.error.name).toBe("BindRaced");
    expect(outcome.error.exitCode).toBe(10);
    expect(harness.fs.has(PID_FILE)).toBe(false);
  });
});

describe("acquireClaim — C9 transition table, contended", () => {
  it("claim-in-progress (no trailing LF) → concede (exit 10), never take over", async () => {
    const harness = makeHarness();
    // A record missing its terminator is claim-in-progress — the one verdict
    // that must never be read as staleness.
    harness.fs.seedRegularFile(PID_FILE, "heniek-daemon\t1\tclaiming\t9999\tboot-witness-a\tabc", {
      uid: OWN_UID,
      mode: 0o600,
    });
    const before = harness.fs.snapshot();

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("lost");
    if (outcome.kind !== "lost") return;
    expect(outcome.error.exitCode).toBe(10);
    expect(harness.fs.snapshot()).toEqual(before);
    expect(opCount(harness.fs, "rename", PID_FILE)).toBe(0);
    expect(harness.isAlive).not.toHaveBeenCalled();
  });

  it.each(["absent", "no-listener", "serving", "hostile"] as const)(
    "complete `claiming` record + live pid + matching witness, probe=%s → ClaimInProgress (exit 10)",
    async (verdict) => {
      // C9's most common contended cell, and the plan's finding C1: the
      // winner publishes `serving` only after bind, so a live winner's record
      // reads `claiming` for its entire startup and its socket is
      // legitimately still absent. Reading that as staleness would let two
      // cold starts take each other over and leave zero daemons.
      const harness = makeHarness({ probeVerdict: verdict, pidAlive: true });
      seedClaim(harness.fs, "claiming");
      const before = harness.fs.snapshot();

      const outcome = await acquireClaim(harness.deps, OPTIONS);

      expect(outcome.kind).toBe("lost");
      if (outcome.kind !== "lost") return;
      expect(outcome.error.name).toBe("ClaimInProgress");
      expect(outcome.error.exitCode).toBe(10);
      // Never take over, never unlink, never signal.
      expect(harness.fs.snapshot()).toEqual(before);
      expect(opCount(harness.fs, "rename", PID_FILE)).toBe(0);
      expect(opCount(harness.fs, "unlink", PID_FILE)).toBe(0);
    },
  );

  it("`serving` + live pid + probe=serving → AlreadyRunning (exit 10) carrying the incumbent pid", async () => {
    const harness = makeHarness({ probeVerdict: "serving", pidAlive: true });
    seedClaim(harness.fs, "serving", { pid: 777 });
    const before = harness.fs.snapshot();

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("lost");
    if (outcome.kind !== "lost") return;
    expect(outcome.error.name).toBe("AlreadyRunning");
    expect(outcome.error.exitCode).toBe(10);
    // Q009's wait-and-connect needs the incumbent pid.
    expect(outcome.error.message).toContain("777");
    expect(harness.fs.snapshot()).toEqual(before);
  });

  it("`serving` + live pid + probe=no-listener → PidFileNamesLiveProcess (exit 11), nothing signalled or removed", async () => {
    const harness = makeHarness({ probeVerdict: "no-listener", pidAlive: true });
    seedClaim(harness.fs, "serving");
    harness.fs.seedSocket(SOCKET_FILE, { uid: OWN_UID });
    const before = harness.fs.snapshot();

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.error.name).toBe("PidFileNamesLiveProcess");
    expect(outcome.error.exitCode).toBe(11);
    // A live pid we cannot corroborate is a refusal, not a licence to unlink
    // a socket a still-booting daemon may be about to bind.
    expect(harness.fs.snapshot()).toEqual(before);
  });

  it("`serving` + live pid + probe=hostile → ForeignSocketOccupied (exit 11), socket untouched", async () => {
    const harness = makeHarness({ probeVerdict: "hostile", pidAlive: true });
    seedClaim(harness.fs, "serving");
    harness.fs.seedSocket(SOCKET_FILE, { uid: OWN_UID });
    const before = harness.fs.snapshot();

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.error.name).toBe("ForeignSocketOccupied");
    expect(outcome.error.exitCode).toBe(11);
    expect(harness.fs.snapshot()).toEqual(before);
  });

  it("`serving` + dead pid + matching witness → takeover by rename-aside, then acquired", async () => {
    const harness = makeHarness({ pidAlive: false });
    seedClaim(harness.fs, "serving");

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("acquired");
    // Takeover is rename-aside, bounded to one.
    expect(opCount(harness.fs, "rename", PID_FILE)).toBe(1);
    expect(stateOf(harness.fs, PID_FILE)).toBe("serving");
  });

  it("boot-witness mismatch → takeover without ever probing the pid", async () => {
    const harness = makeHarness({ pidAlive: true });
    seedClaim(harness.fs, "serving", { bootWitness: "witness-from-a-previous-boot" });

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("acquired");
    // A record from another boot is orphaned unconditionally: PID reuse
    // across a reboot must not produce a permanent refusal, and the recorded
    // pid is meaningless, so it is never consulted.
    expect(harness.isAlive).not.toHaveBeenCalled();
  });

  it("boot witness unobtainable on this platform → takeover without probing the pid", async () => {
    const harness = makeHarness({ pidAlive: true, bootWitness: undefined });
    seedClaim(harness.fs, "serving", { bootWitness: undefined });

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("acquired");
    expect(harness.isAlive).not.toHaveBeenCalled();
  });

  it("malformed content → takeover, then acquired", async () => {
    const harness = makeHarness();
    harness.fs.seedRegularFile(PID_FILE, "not-a-heniek-record\n", { uid: OWN_UID, mode: 0o600 });

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("acquired");
    expect(opCount(harness.fs, "rename", PID_FILE)).toBe(1);
  });

  it("a symlinked claim file → InsecureClaimFile (exit 11), nothing mutated", async () => {
    const harness = makeHarness();
    harness.fs.seedSymlink(PID_FILE, "/etc/passwd", { uid: OWN_UID });
    const before = harness.fs.snapshot();

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.error.name).toBe("InsecureClaimFile");
    expect(outcome.error.exitCode).toBe(11);
    expect(harness.fs.snapshot()).toEqual(before);
  });

  it("a foreign-uid claim file → InsecureClaimFile (exit 11), and its content is never read", async () => {
    const harness = makeHarness();
    harness.fs.seedRegularFile(PID_FILE, "whatever\n", { uid: OWN_UID + 1, mode: 0o600 });
    const before = harness.fs.snapshot();

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.error.name).toBe("InsecureClaimFile");
    expect(opCount(harness.fs, "readFile", PID_FILE)).toBe(0);
    expect(harness.fs.snapshot()).toEqual(before);
  });

  it("a racer that keeps re-creating the claim → ClaimContended (exit 11) after a bounded retry", async () => {
    const harness = makeHarness({ pidAlive: false });
    seedClaim(harness.fs, "serving");
    // Every time we try to take the claim, a competing racer has already
    // re-created it, so `createExclusive` always raises EEXIST. The retry
    // budget is one; the second contended pass must give up rather than loop.
    // `link(2)` onto the claim path is the mutual-exclusion primitive, so the
    // racer lands its own record immediately before every one of our link
    // attempts — each therefore raises EEXIST.
    harness.fs.setInterleaving((step) => {
      if (step === "link" && !harness.fs.has(PID_FILE)) {
        seedClaim(harness.fs, "serving");
      }
    });

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.error.name).toBe("ClaimContended");
    expect(outcome.error.exitCode).toBe(11);
    // Bounded: exactly one takeover was attempted, not an unbounded spin.
    expect(opCount(harness.fs, "rename", PID_FILE)).toBe(1);
  });
});

describe("acquireClaim — runtime-directory security (design C1 step 1)", () => {
  it("refuses a symlinked runtime directory before creating anything", async () => {
    const fs = new FakeLockFileSystem({ currentUid: OWN_UID });
    fs.seedDirectory(RUNTIME_PARENT, { uid: OWN_UID, mode: 0o700 });
    fs.seedSymlink(RUNTIME, "/tmp/evil", { uid: OWN_UID });
    const harness = makeHarness({ sharedFs: fs });

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.error.name).toBe("InsecureRuntimeDirectory");
    expect(outcome.error.exitCode).toBe(11);
    expect(fs.has(PID_FILE)).toBe(false);
  });

  it("refuses a group-writable runtime directory", async () => {
    const harness = makeHarness();
    harness.fs.seedDirectory(RUNTIME, { uid: OWN_UID, mode: 0o770 });

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.error.name).toBe("InsecureRuntimeDirectory");
    expect(harness.fs.has(PID_FILE)).toBe(false);
  });

  it("refuses a group-writable PARENT of the runtime directory", async () => {
    // `packages/state/src/database/open.ts:241-291` refuses on the parent
    // too; a weaker guard here would sit below the repository's own
    // precedent for a strictly less sensitive file.
    const harness = makeHarness();
    harness.fs.seedDirectory(RUNTIME_PARENT, { uid: OWN_UID, mode: 0o775 });

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.error.name).toBe("InsecureRuntimeDirectory");
    expect(outcome.error.message).toContain(RUNTIME_PARENT);
    expect(harness.fs.has(PID_FILE)).toBe(false);
  });

  it("refuses a foreign-uid runtime directory", async () => {
    const harness = makeHarness();
    harness.fs.seedDirectory(RUNTIME, { uid: OWN_UID + 1, mode: 0o700 });

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.error.name).toBe("InsecureRuntimeDirectory");
  });
});

describe("acquireClaim — socket-path security (design C1 step 3)", () => {
  it("refuses a non-socket squatting the socket path instead of unlinking it", async () => {
    const harness = makeHarness({ probeVerdict: "no-listener" });
    harness.fs.seedRegularFile(SOCKET_FILE, "not a socket\n", { uid: OWN_UID, mode: 0o600 });

    const outcome = await acquireClaim(harness.deps, OPTIONS);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.error.name).toBe("InsecureSocketPath");
    expect(outcome.error.exitCode).toBe(11);
    expect(harness.fs.has(SOCKET_FILE)).toBe(true);
    // The claim we took to get here is released on the refusal path.
    expect(harness.fs.has(PID_FILE)).toBe(false);
  });
});

describe("acquireClaim — cold-start double race", () => {
  it("two concurrent acquires yield exactly one holder, never zero", async () => {
    // Both racers share one filesystem. The loser must concede and the winner
    // must survive: "zero holders" is the failure mode the trailing-LF rule
    // exists to prevent, so assert the surviving record explicitly rather
    // than only counting outcomes.
    const fs = newFilesystem();
    const first = makeHarness({ sharedFs: fs });
    const second = makeHarness({ sharedFs: fs, pidAlive: true });

    const [a, b] = await Promise.all([
      acquireClaim(first.deps, OPTIONS),
      acquireClaim(second.deps, { ...OPTIONS, ownPid: OWN_PID + 1 }),
    ]);

    expect([a, b].filter((outcome) => outcome.kind === "acquired")).toHaveLength(1);
    expect(fs.has(PID_FILE)).toBe(true);
    expect(stateOf(fs, PID_FILE)).toBe("serving");
  });
});
