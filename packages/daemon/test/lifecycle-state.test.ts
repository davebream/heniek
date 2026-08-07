/**
 * `state.ts`/`trace.ts` against design C9 (plan Task 6 Step 1).
 *
 * Three layers:
 *  1. the pure transition function in isolation — every legal pair, and a
 *     sample of illegal ones (including every event from every terminal
 *     state);
 *  2. `LifecycleTracer` — that `record()` actually calls the pure function,
 *     emits the right shape, and that a resumed tracer picks up where an
 *     earlier one left off;
 *  3. one test per row of the C9 transition table (plan Task 2 Step 3,
 *     reused here), each asserting the *exact* emitted trace sequence
 *     against a real `acquireClaim` call — not just the terminal outcome,
 *     which `test/acquire.test.ts` already covers.
 */

import { describe, expect, it } from "vitest";
import { type AcquireDeps, type AcquireOptions, acquireClaim } from "../src/lifecycle/acquire.js";
import { serialiseClaimRecord } from "../src/lifecycle/claim-record.js";
import {
  INITIAL_LIFECYCLE_STATE,
  isTerminalLifecycleState,
  type LifecycleEventKind,
  type LifecycleState,
  transitionLifecycleState,
} from "../src/lifecycle/state.js";
import { createLifecycleTracer, serialiseLifecycleTrace } from "../src/lifecycle/trace.js";
import type { BoundSocket, LifecycleTraceEvent, SocketProbeVerdict } from "../src/ports.js";
import { FakeLockFileSystem } from "./helpers/fake-lock-filesystem.js";

describe("transitionLifecycleState — the pure C9 table", () => {
  it("starts at 'starting'", () => {
    expect(INITIAL_LIFECYCLE_STATE).toBe("starting");
  });

  const legal: ReadonlyArray<readonly [LifecycleState, LifecycleEventKind, LifecycleState]> = [
    ["starting", "claim", "acquiring"],
    ["acquiring", "claim", "acquiring"],
    ["acquiring", "probe", "acquiring"],
    ["acquiring", "reclaim", "acquiring"],
    ["acquiring", "takeover", "acquiring"],
    ["acquiring", "recover", "recovering"],
    ["recovering", "bind", "recovering"],
    ["recovering", "publish", "serving"],
    ["serving", "drain", "draining"],
    ["draining", "stop", "stopped"],
  ];

  it.each(legal)("%s + %s -> %s", (from, event, to) => {
    expect(transitionLifecycleState(from, event)).toBe(to);
  });

  const nonTerminal: readonly LifecycleState[] = [
    "starting",
    "acquiring",
    "recovering",
    "serving",
    "draining",
  ];

  it.each(nonTerminal)("'lost' is legal from every non-terminal state (%s)", (state) => {
    expect(transitionLifecycleState(state, "lost")).toBe("lost");
  });

  it.each(nonTerminal)("'refused' is legal from every non-terminal state (%s)", (state) => {
    expect(transitionLifecycleState(state, "refused")).toBe("refused");
  });

  const terminal: readonly LifecycleState[] = ["stopped", "lost", "refused"];
  const everyEvent: readonly LifecycleEventKind[] = [
    "claim",
    "probe",
    "reclaim",
    "takeover",
    "recover",
    "bind",
    "publish",
    "lost",
    "refused",
    "drain",
    "stop",
  ];

  it("no event is legal from a terminal state", () => {
    for (const state of terminal) {
      expect(isTerminalLifecycleState(state)).toBe(true);
      for (const event of everyEvent) {
        expect(() => transitionLifecycleState(state, event)).toThrow(RangeError);
      }
    }
  });

  it("rejects an event that skips a required sub-phase", () => {
    expect(() => transitionLifecycleState("starting", "bind")).toThrow(RangeError);
    expect(() => transitionLifecycleState("acquiring", "publish")).toThrow(RangeError);
    expect(() => transitionLifecycleState("recovering", "claim")).toThrow(RangeError);
    expect(() => transitionLifecycleState("serving", "recover")).toThrow(RangeError);
  });
});

describe("createLifecycleTracer", () => {
  function memorySink(): {
    events: LifecycleTraceEvent[];
    emit: (event: LifecycleTraceEvent) => void;
  } {
    const events: LifecycleTraceEvent[] = [];
    return { events, emit: (event) => events.push(event) };
  }

  it("emits one line per transition with the pure function's next state", () => {
    const sink = memorySink();
    let tick = 0;
    const clock = { nowIso: () => `2026-08-02T00:00:0${tick++}.000Z` };

    const tracer = createLifecycleTracer({ instanceId: "abc123", sink, clock });
    expect(tracer.currentState()).toBe("starting");

    expect(tracer.record("claim", "attempting the claim")).toBe("acquiring");
    expect(tracer.record("probe", "socket absent")).toBe("acquiring");
    expect(tracer.record("recover", "entering recovery")).toBe("recovering");
    expect(tracer.record("publish", "published serving")).toBe("serving");

    expect(sink.events).toEqual([
      {
        from: "starting",
        to: "acquiring",
        reason: "attempting the claim",
        instanceId: "abc123",
        at: "2026-08-02T00:00:00.000Z",
      },
      {
        from: "acquiring",
        to: "acquiring",
        reason: "socket absent",
        instanceId: "abc123",
        at: "2026-08-02T00:00:01.000Z",
      },
      {
        from: "acquiring",
        to: "recovering",
        reason: "entering recovery",
        instanceId: "abc123",
        at: "2026-08-02T00:00:02.000Z",
      },
      {
        from: "recovering",
        to: "serving",
        reason: "published serving",
        instanceId: "abc123",
        at: "2026-08-02T00:00:03.000Z",
      },
    ]);
  });

  it("a resumed tracer continues the same instance's trace from a later state", () => {
    const sink = memorySink();
    const clock = { nowIso: () => "2026-08-02T00:00:00.000Z" };

    const resumed = createLifecycleTracer({
      instanceId: "abc123",
      sink,
      clock,
      initialState: "serving",
    });
    expect(resumed.currentState()).toBe("serving");
    expect(resumed.record("drain", "SIGTERM")).toBe("draining");
    expect(resumed.record("stop", "shutdown complete")).toBe("stopped");

    expect(sink.events.map((event) => `${event.from}->${event.to}`)).toEqual([
      "serving->draining",
      "draining->stopped",
    ]);
  });

  it("propagates the pure function's throw for an illegal event without emitting", () => {
    const sink = memorySink();
    const tracer = createLifecycleTracer({
      instanceId: "x",
      sink,
      clock: { nowIso: () => "t" },
    });
    expect(() => tracer.record("bind", "nope")).toThrow(RangeError);
    expect(sink.events).toEqual([]);
  });
});

describe("serialiseLifecycleTrace", () => {
  it("renders one JSON line per event, newline-terminated, in order", () => {
    const events: LifecycleTraceEvent[] = [
      { from: "starting", to: "acquiring", reason: "a", instanceId: "i", at: "t1" },
      { from: "acquiring", to: "serving", reason: "b", instanceId: "i", at: "t2" },
    ];
    const rendered = serialiseLifecycleTrace(events);
    expect(rendered).toBe(`${JSON.stringify(events[0])}\n${JSON.stringify(events[1])}\n`);
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it("is empty for an empty trace", () => {
    expect(serialiseLifecycleTrace([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// One test per C9 row, against the real acquireClaim — exact trace sequence.
// ---------------------------------------------------------------------------

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

interface RowHarness {
  readonly fs: FakeLockFileSystem;
  readonly deps: AcquireDeps;
  readonly events: LifecycleTraceEvent[];
}

interface RowHarnessOptions {
  readonly probeVerdict?: SocketProbeVerdict;
  readonly pidAlive?: boolean;
  readonly bootWitness?: string | undefined;
  readonly bindThrows?: string;
}

function newFilesystem(): FakeLockFileSystem {
  const fs = new FakeLockFileSystem({ currentUid: OWN_UID });
  fs.seedDirectory(RUNTIME_PARENT, { uid: OWN_UID, mode: 0o700 });
  fs.seedDirectory(RUNTIME, { uid: OWN_UID, mode: 0o700 });
  return fs;
}

function makeRowHarness(options: RowHarnessOptions = {}): RowHarness {
  const fs = newFilesystem();
  const events: LifecycleTraceEvent[] = [];
  let counter = 0;
  let tick = 0;

  const deps: AcquireDeps = {
    lockFileSystem: fs,
    socketBinder: {
      listen: (path: string): Promise<BoundSocket> => {
        if (options.bindThrows !== undefined) {
          const error = new Error(`listen ${path}`) as Error & { code: string };
          error.code = options.bindThrows;
          return Promise.reject(error);
        }
        fs.seedSocket(path, { uid: OWN_UID, mode: 0o755 });
        return Promise.resolve({
          dev: 9n,
          ino: 99n,
          close: () => Promise.resolve(),
          onConnection: () => {},
          onClose: () => {},
        });
      },
    },
    socketProbe: { probe: () => Promise.resolve(options.probeVerdict ?? "absent") },
    processLiveness: { isAlive: () => options.pidAlive ?? false, uid: () => OWN_UID },
    hostWitness: { current: () => ("bootWitness" in options ? options.bootWitness : BOOT) },
    randomSource: {
      bytes: (length: number) =>
        Uint8Array.from({ length }, () => {
          counter += 1;
          return counter & 0xff;
        }),
    },
    clock: { nowIso: () => `t${tick++}` },
    traceSink: { emit: (event) => events.push(event) },
  };

  return { fs, deps, events };
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

function sequence(events: readonly LifecycleTraceEvent[]): string[] {
  return events.map((event) => `${event.from}->${event.to}`);
}

describe("acquireClaim — C9 transition table, exact trace sequence", () => {
  it("absent claim, absent socket: claim -> acquiring, probe (self), recover -> recovering, bind+publish -> serving", async () => {
    const h = makeRowHarness({ probeVerdict: "absent" });
    const outcome = await acquireClaim(h.deps, OPTIONS);
    expect(outcome.kind).toBe("acquired");
    expect(sequence(h.events)).toEqual([
      "starting->acquiring", // claim
      "acquiring->acquiring", // probe
      "acquiring->recovering", // recover
      "recovering->recovering", // bind
      "recovering->serving", // publish
    ]);
  });

  it("absent claim, no-listener socket: reclaim self-loop appears before recover", async () => {
    const h = makeRowHarness({ probeVerdict: "no-listener" });
    h.fs.seedSocket(SOCKET_FILE, { uid: OWN_UID, mode: 0o600 });
    const outcome = await acquireClaim(h.deps, OPTIONS);
    expect(outcome.kind).toBe("acquired");
    expect(sequence(h.events)).toEqual([
      "starting->acquiring",
      "acquiring->acquiring", // probe
      "acquiring->acquiring", // reclaim
      "acquiring->recovering",
      "recovering->recovering",
      "recovering->serving",
    ]);
  });

  it("absent claim, serving socket: lost, no recovering ever entered", async () => {
    const h = makeRowHarness({ probeVerdict: "serving" });
    const outcome = await acquireClaim(h.deps, OPTIONS);
    expect(outcome.kind).toBe("lost");
    expect(sequence(h.events)).toEqual([
      "starting->acquiring",
      "acquiring->acquiring",
      "acquiring->lost",
    ]);
  });

  it("absent claim, hostile socket: refused", async () => {
    const h = makeRowHarness({ probeVerdict: "hostile" });
    const outcome = await acquireClaim(h.deps, OPTIONS);
    expect(outcome.kind).toBe("refused");
    expect(sequence(h.events)).toEqual([
      "starting->acquiring",
      "acquiring->acquiring",
      "acquiring->refused",
    ]);
  });

  it("absent claim, EADDRINUSE at bind: lost, after entering recovering", async () => {
    const h = makeRowHarness({ probeVerdict: "absent", bindThrows: "EADDRINUSE" });
    const outcome = await acquireClaim(h.deps, OPTIONS);
    expect(outcome.kind).toBe("lost");
    expect(sequence(h.events)).toEqual([
      "starting->acquiring",
      "acquiring->acquiring",
      "acquiring->recovering",
      "recovering->lost",
    ]);
  });

  it("claiming record, boot matches, pid alive: concede unconditionally, never probed", async () => {
    const h = makeRowHarness({ pidAlive: true });
    seedClaim(h.fs, "claiming");
    const outcome = await acquireClaim(h.deps, OPTIONS);
    expect(outcome.kind).toBe("lost");
    // claim (attempt) -> acquiring, then straight to lost: no probe/recover ever entered.
    expect(sequence(h.events)).toEqual(["starting->acquiring", "acquiring->lost"]);
  });

  it("serving record, boot matches, pid alive, socket serving: lost", async () => {
    const h = makeRowHarness({ pidAlive: true, probeVerdict: "serving" });
    seedClaim(h.fs, "serving");
    const outcome = await acquireClaim(h.deps, OPTIONS);
    expect(outcome.kind).toBe("lost");
    expect(sequence(h.events)).toEqual([
      "starting->acquiring",
      "acquiring->acquiring", // probe against the contended serving record
      "acquiring->lost",
    ]);
  });

  it("serving record, boot matches, pid alive, socket no-listener: refused, never probed for reclaim", async () => {
    const h = makeRowHarness({ pidAlive: true, probeVerdict: "no-listener" });
    seedClaim(h.fs, "serving");
    const outcome = await acquireClaim(h.deps, OPTIONS);
    expect(outcome.kind).toBe("refused");
    expect(sequence(h.events)).toEqual([
      "starting->acquiring",
      "acquiring->acquiring", // probe
      "acquiring->refused",
    ]);
  });

  it("stale claim (dead pid, matching boot witness): takeover self-loop then a fresh claim -> serving", async () => {
    const h = makeRowHarness({ pidAlive: false, probeVerdict: "absent" });
    seedClaim(h.fs, "serving");
    const outcome = await acquireClaim(h.deps, OPTIONS);
    expect(outcome.kind).toBe("acquired");
    expect(sequence(h.events)).toEqual([
      "starting->acquiring", // first claim attempt (EEXIST)
      "acquiring->acquiring", // takeover
      "acquiring->acquiring", // second claim attempt (wins)
      "acquiring->acquiring", // probe
      "acquiring->recovering",
      "recovering->recovering",
      "recovering->serving",
    ]);
  });

  it("symlinked runtime directory: refused straight from starting, no claim attempted", async () => {
    const h = makeRowHarness();
    h.fs.seedSymlink(RUNTIME, "/somewhere-else");
    const outcome = await acquireClaim(h.deps, OPTIONS);
    expect(outcome.kind).toBe("refused");
    expect(sequence(h.events)).toEqual(["starting->refused"]);
  });

  it("symlinked claim file: refused via the contended path", async () => {
    const h = makeRowHarness();
    h.fs.seedSymlink(PID_FILE, "/somewhere-else");
    const outcome = await acquireClaim(h.deps, OPTIONS);
    expect(outcome.kind).toBe("refused");
    expect(sequence(h.events)).toEqual(["starting->acquiring", "acquiring->refused"]);
  });

  it("takeover raced (rename -> ENOENT): bounded retry, then ClaimContended refused", async () => {
    const h = makeRowHarness({ pidAlive: false });
    seedClaim(h.fs, "serving");
    h.fs.setRenameIdempotentOnMissing(false);
    // Model two racers: at this process's own takeover rename, a competitor's
    // rename is deemed to have landed first (the record vanishes, so our
    // rename raises real ENOENT); at this process's retry `link`, that same
    // competitor's own fresh claim is deemed to have already landed, so our
    // retry also contends — bounding the retry to exactly one failure.
    let raced = false;
    let relinked = false;
    h.fs.setInterleaving((step, path) => {
      if (step === "rename" && path === PID_FILE && !raced) {
        raced = true;
        h.fs.unlink(PID_FILE);
        return;
      }
      if (step === "link" && raced && !relinked) {
        relinked = true;
        h.fs.seedRegularFile(
          PID_FILE,
          serialiseClaimRecord({
            recordVersion: 1,
            state: "claiming",
            pid: 424242,
            bootWitness: BOOT,
            instanceId: "competitor0000000000000000000000",
          }),
          { uid: OWN_UID, mode: 0o600 },
        );
      }
    });
    const outcome = await acquireClaim(h.deps, OPTIONS);
    expect(outcome.kind).toBe("refused");
    // Two claim attempts (both EEXIST — the second against the competitor's
    // freshly-landed claim), one takeover attempt in between, then the
    // bounded-retry refusal — no probe/recover/bind ever reached.
    expect(sequence(h.events)).toEqual([
      "starting->acquiring",
      "acquiring->acquiring", // takeover attempt
      "acquiring->acquiring", // second (final) claim attempt, still EEXIST
      "acquiring->refused", // ClaimContended
    ]);
  });
});
