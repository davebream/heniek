/**
 * `reconcile` — the restart-reconciliation pass (design C12, plan Task 4
 * Step 2).
 *
 * The ordered pass is tested through its observable effects, not by
 * instrumenting each internal call: `openOwnedStateDatabase` and
 * `runMigrations` are `@heniek/state`'s own real functions run against a
 * real, on-disk `state.sqlite` (`seedState`), and `recoverArtifacts` runs
 * for real against a real temp directory. Only the two ports this package
 * owns — the `LockHandle` and the `ExecutionBackend` — are test doubles.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock, IdGenerator } from "@heniek/state";
import {
  commitStateChange,
  openStateDatabase,
  readAllRunProjections,
  readRunProjection,
  runMigrations,
} from "@heniek/state";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimLostError } from "../src/lifecycle/errors.js";
import { createClaimGuard, type LockHandle } from "../src/lifecycle/guard.js";
import { RecoveryFailedError } from "../src/recovery/errors.js";
import { reconcile } from "../src/recovery/reconcile.js";
import { FakeLockFileSystem } from "./helpers/fake-lock-filesystem.js";
import { createScriptedBackend } from "./helpers/scripted-backend.js";
import { type SeededState, seedState } from "./helpers/seed-state.js";

const FORBIDDEN_BACKEND_METHODS = ["start", "answer", "resume", "cancel"] as const;

function fakeClock(startMs: number = Date.UTC(2026, 0, 1)): Clock {
  return { nowIso: () => new Date(startMs).toISOString() };
}

// Module-level, not per-call: `seedState()` and `reconcile()` each mint their
// own `IdGenerator` against the *same* database, and a counter that reset on
// every call would hand out colliding event ids (both starting at 1) the
// moment reconcile committed anything.
let sharedIdCounter = 0;

function fakeIds(): IdGenerator {
  return {
    next(prefix: string): string {
      sharedIdCounter += 1;
      return `${prefix}-test-${sharedIdCounter}`;
    },
  };
}

/** A `LockHandle` with no real filesystem behind it — sufficient for every test that does not exercise identity loss. */
function trivialLock(): LockHandle {
  let held = true;
  return {
    instanceId: "test-instance",
    isHeld: () => held,
    assertStillHeld: () => {
      if (!held) {
        throw new ClaimLostError("the claim has already been released");
      }
    },
    onLost: () => {
      // Not exercised by these tests.
    },
    release: () => {
      held = false;
    },
    publishState: () => {
      // Not exercised by these tests — reconcile() runs entirely in
      // `recovering`, before `serving` is ever published.
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

async function seeded(): Promise<SeededState> {
  const state = await seedState({ clock: fakeClock(), ids: fakeIds() });
  cleanups.push(state.cleanup);
  return state;
}

describe("reconcile — the ordered pass over seeded non-terminal runs", () => {
  it("probes every non-terminal run exactly once, classifies per the C12 table, and commits only where the projected status differs", async () => {
    const state = await seeded();
    const backend = createScriptedBackend({
      [state.runIds.queued]: [{ kind: "status", status: "queued" }],
      [state.runIds.running]: [{ kind: "status", status: "failed" }],
      [state.runIds.waiting_on_user]: [{ kind: "status", status: "succeeded" }],
      [state.runIds.waiting_for_parent_session]: [{ kind: "status", status: "cancelled" }],
      [state.runIds.recovery_required]: [{ kind: "unknown-run" }],
    });

    const result = await reconcile(
      { lock: trivialLock(), backend },
      {
        database: { path: state.databasePath, clock: fakeClock(), ids: fakeIds() },
        artifactStore: { root: state.artifactStoreRoot, clock: fakeClock(), ids: fakeIds() },
      },
    );

    // status() called exactly once per non-terminal run — no more, no fewer.
    for (const runId of Object.values(state.runIds)) {
      expect(backend.statusCallsFor(runId)).toBe(1);
    }

    // IR-16, made a direct assertion rather than resting solely on the
    // scripted backend's own throw (plan Task 4 Step 10's second positive
    // control needs an assertion that stays load-bearing even if that
    // throw is neutered).
    const forbiddenCalls = backend.calls.filter((call) =>
      (FORBIDDEN_BACKEND_METHODS as readonly string[]).includes(call.method),
    );
    expect(forbiddenCalls).toEqual([]);

    expect(result.reconciliation).toEqual({
      probed: 5,
      // `queued` (unchanged) and `succeeded` both classify `resumable`.
      resumable: 2,
      failed: 1,
      cancelled: 1,
      unknown: 1,
    });

    expect(result.artifactRecovery).toEqual({
      removedIncoming: [],
      skippedIncoming: [],
      unreferencedBlobs: [],
    });

    const projections = readAllRunProjections(result.db);
    const byId = new Map(projections.map((row) => [row.runId, row]));

    // `seedState()` seeds every non-`queued` status via its own
    // `run.created` + `run.status_changed` pair, so those runs start this
    // pass at revision 2 already — only a *further* commit from reconcile()
    // itself would move a revision past that baseline.
    expect(byId.get(state.runIds.queued)?.status).toBe("queued");
    expect(byId.get(state.runIds.queued)?.revision).toBe(1); // no commit — unchanged
    expect(byId.get(state.runIds.running)?.status).toBe("failed");
    expect(byId.get(state.runIds.running)?.revision).toBe(3);
    expect(byId.get(state.runIds.waiting_on_user)?.status).toBe("succeeded");
    expect(byId.get(state.runIds.waiting_on_user)?.revision).toBe(3);
    expect(byId.get(state.runIds.waiting_for_parent_session)?.status).toBe("cancelled");
    expect(byId.get(state.runIds.waiting_for_parent_session)?.revision).toBe(3);
    // The probe could not resolve this run at all — unknown / recovery_required,
    // which is exactly what it was already seeded as, so no commit.
    expect(byId.get(state.runIds.recovery_required)?.status).toBe("recovery_required");
    expect(byId.get(state.runIds.recovery_required)?.revision).toBe(2);

    result.db.close();
  });

  it("excludes terminal runs from the probe entirely", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heniek-daemon-recovery-terminal-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "state.sqlite");
    const artifactStoreRoot = join(directory, "artifacts");

    const seedDb = openStateDatabase({ path: databasePath, clock: fakeClock(), ids: fakeIds() });
    runMigrations(seedDb);
    commitStateChange(seedDb, { type: "codebase.registered", payload: { codebaseId: "cb-1" } });
    commitStateChange(seedDb, {
      runId: "run-live",
      type: "run.created",
      payload: { runId: "run-live", codebaseId: "cb-1" },
    });
    commitStateChange(seedDb, {
      runId: "run-done",
      type: "run.created",
      payload: { runId: "run-done", codebaseId: "cb-1" },
    });
    commitStateChange(seedDb, {
      runId: "run-done",
      type: "run.status_changed",
      payload: { runId: "run-done", status: "succeeded" },
    });
    seedDb.close();

    const backend = createScriptedBackend({
      "run-live": [{ kind: "status", status: "running" }],
    });

    const result = await reconcile(
      { lock: trivialLock(), backend },
      {
        database: { path: databasePath, clock: fakeClock(), ids: fakeIds() },
        artifactStore: { root: artifactStoreRoot, clock: fakeClock(), ids: fakeIds() },
      },
    );

    expect(backend.statusCallsFor("run-live")).toBe(1);
    expect(backend.statusCallsFor("run-done")).toBe(0);
    expect(result.reconciliation.probed).toBe(1);

    result.db.close();
  });

  it("a status() throw classifies that one run unknown/recovery_required, and the pass continues probing the rest", async () => {
    const state = await seeded();
    const backend = createScriptedBackend({
      [state.runIds.queued]: [{ kind: "status", status: "queued" }],
      [state.runIds.running]: [{ kind: "throws", message: "backend unavailable" }],
      [state.runIds.waiting_on_user]: [{ kind: "status", status: "waiting_on_user" }],
      [state.runIds.waiting_for_parent_session]: [{ kind: "status", status: "running" }],
      [state.runIds.recovery_required]: [{ kind: "status", status: "recovery_required" }],
    });

    const result = await reconcile(
      { lock: trivialLock(), backend },
      {
        database: { path: state.databasePath, clock: fakeClock(), ids: fakeIds() },
        artifactStore: { root: state.artifactStoreRoot, clock: fakeClock(), ids: fakeIds() },
      },
    );

    // Every run was still probed — the throw on one run did not abort the pass.
    for (const runId of Object.values(state.runIds)) {
      expect(backend.statusCallsFor(runId)).toBe(1);
    }

    const failedRun = result.classifications.find((entry) => entry.runId === state.runIds.running);
    expect(failedRun).toEqual({
      runId: state.runIds.running,
      classification: "unknown",
      runStatus: "recovery_required",
      probeOutcome: "error",
    });

    const projection = readRunProjection(result.db, state.runIds.running);
    expect(projection?.status).toBe("recovery_required");

    result.db.close();
  });

  it("double-boot idempotence: a second identical pass commits zero times and leaves revision unchanged", async () => {
    const state = await seeded();
    // Every answer is chosen to keep the projected status **non-terminal**
    // — a terminal projection would (correctly) drop that run out of the
    // next pass's `readAllRunProjections` filter entirely, which would
    // prove nothing about idempotence over a *stable* non-terminal run.
    // `waiting_for_parent_session -> running` is the one run whose first
    // boot actually commits (the backend has no analog for a
    // pipeline-only status), reaching a fixpoint the second, identical
    // answer then finds already applied.
    const backend = createScriptedBackend({
      [state.runIds.queued]: [
        { kind: "status", status: "queued" },
        { kind: "status", status: "queued" },
      ],
      [state.runIds.running]: [
        { kind: "status", status: "running" },
        { kind: "status", status: "running" },
      ],
      [state.runIds.waiting_on_user]: [
        { kind: "status", status: "waiting_on_user" },
        { kind: "status", status: "waiting_on_user" },
      ],
      [state.runIds.waiting_for_parent_session]: [
        { kind: "status", status: "running" },
        { kind: "status", status: "running" },
      ],
      [state.runIds.recovery_required]: [{ kind: "unknown-run" }, { kind: "unknown-run" }],
    });

    const databaseOptions = { path: state.databasePath, clock: fakeClock(), ids: fakeIds() };
    const artifactOptions = { root: state.artifactStoreRoot, clock: fakeClock(), ids: fakeIds() };

    const firstBoot = await reconcile(
      { lock: trivialLock(), backend },
      {
        database: databaseOptions,
        artifactStore: artifactOptions,
      },
    );
    const revisionsAfterFirstBoot = readAllRunProjections(firstBoot.db);
    firstBoot.db.close();

    const secondBoot = await reconcile(
      { lock: trivialLock(), backend },
      {
        database: databaseOptions,
        artifactStore: artifactOptions,
      },
    );
    const revisionsAfterSecondBoot = readAllRunProjections(secondBoot.db);
    secondBoot.db.close();

    // Both passes probed every one of the same five non-terminal runs —
    // the first boot's one commit did not remove anything from scope.
    expect(revisionsAfterSecondBoot).toEqual(revisionsAfterFirstBoot);
    expect(secondBoot.reconciliation).toEqual({
      probed: 5,
      resumable: 4,
      failed: 0,
      cancelled: 0,
      unknown: 1,
    });
  });

  it("assertStillHeld catching a claim replaced mid-recovery aborts before the next commit", async () => {
    const state = await seeded();
    const fs = new FakeLockFileSystem({ currentUid: 1000 });
    const CLAIM_PATH = "/rt/daemon.pid";
    fs.seedDirectory("/rt", { uid: 1000, mode: 0o700 });
    const claimHandle = fs.createExclusive(CLAIM_PATH, 0o600);
    claimHandle.write("heniek-daemon\t1\tserving \t123\tboot-1\tinstance-1\n");
    const claimStat = claimHandle.stat();
    const lock = createClaimGuard({
      instanceId: "instance-1",
      claimPath: CLAIM_PATH,
      claimHandle,
      claimIdentity: { dev: claimStat.dev, ino: claimStat.ino },
      lockFileSystem: fs,
    });

    const scripted = createScriptedBackend({
      [state.runIds.queued]: [{ kind: "status", status: "queued" }],
      [state.runIds.recovery_required]: [{ kind: "status", status: "recovery_required" }],
      [state.runIds.running]: [{ kind: "status", status: "failed" }],
      [state.runIds.waiting_for_parent_session]: [{ kind: "status", status: "cancelled" }],
      [state.runIds.waiting_on_user]: [{ kind: "status", status: "succeeded" }],
    });
    // A successor's claim lands the instant the probe for `running` answers
    // — simulating a replacement mid-pass, at the exact point a real
    // takeover could land between two probes.
    const backend = {
      ...scripted,
      async status(runId: string) {
        const answer = await scripted.status(runId);
        if (runId === state.runIds.running) {
          fs.unlink(CLAIM_PATH);
          fs.seedRegularFile(CLAIM_PATH, "a successor's own claim");
        }
        return answer;
      },
    };

    await expect(
      reconcile(
        { lock, backend },
        {
          database: { path: state.databasePath, clock: fakeClock(), ids: fakeIds() },
          artifactStore: { root: state.artifactStoreRoot, clock: fakeClock(), ids: fakeIds() },
        },
      ),
    ).rejects.toThrow(ClaimLostError);

    // The commit `running -> failed` would have followed immediately —
    // it must never have happened. `running` was seeded via `run.created` +
    // `run.status_changed` (design `seedState()`), so its baseline revision
    // is 2; a further commit from reconcile() would move it to 3.
    const directDb = openStateDatabase({
      path: state.databasePath,
      clock: fakeClock(),
      ids: fakeIds(),
    });
    const runningProjection = readRunProjection(directDb, state.runIds.running);
    expect(runningProjection?.status).toBe("running");
    expect(runningProjection?.revision).toBe(2);
    directDb.close();

    // Runs ordered after `running` (readAllRunProjections sorts by run_id)
    // were never even probed — the pass aborted, it did not merely skip one commit.
    expect(scripted.statusCallsFor(state.runIds.waiting_for_parent_session)).toBe(0);
    expect(scripted.statusCallsFor(state.runIds.waiting_on_user)).toBe(0);
  });
});

describe("reconcile — fatal recovery failures (design's Error Handling section, exit 12)", () => {
  it("releases the claim and throws RecoveryFailedError when the owned state database fails to open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heniek-daemon-recovery-fatal-open-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const lock = trivialLock();
    const backend = createScriptedBackend({});

    await expect(
      reconcile(
        { lock, backend },
        {
          // The parent directory does not exist — openStateDatabase refuses.
          database: {
            path: join(directory, "does-not-exist", "state.sqlite"),
            clock: fakeClock(),
            ids: fakeIds(),
          },
          artifactStore: { root: join(directory, "artifacts"), clock: fakeClock(), ids: fakeIds() },
        },
      ),
    ).rejects.toThrow(RecoveryFailedError);

    expect(lock.isHeld()).toBe(false);
  });

  it("releases the claim and throws RecoveryFailedError with exitCode 12 when artifact recovery fails", async () => {
    const state = await seeded();
    // A regular file occupies the intended store root, so `createArtifactStore`
    // cannot create `incoming/`/`blobs/sha256/` under it.
    await writeFile(state.artifactStoreRoot, "not a directory");

    const lock = trivialLock();
    const backend = createScriptedBackend({});

    let caught: unknown;
    try {
      await reconcile(
        { lock, backend },
        {
          database: { path: state.databasePath, clock: fakeClock(), ids: fakeIds() },
          artifactStore: { root: state.artifactStoreRoot, clock: fakeClock(), ids: fakeIds() },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RecoveryFailedError);
    expect((caught as RecoveryFailedError).exitCode).toBe(12);
    expect(lock.isHeld()).toBe(false);
  });
});
