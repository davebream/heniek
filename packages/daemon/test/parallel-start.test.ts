/**
 * The real out-of-process parallel-start tier (plan Task 6 Step 2; design's
 * real-process tier). `test/acquire.test.ts`'s driven double-race already
 * proves the decision function is correct against a fake filesystem where
 * the interleaving is dictated by the test; this file proves the same
 * invariant against a REAL filesystem and REAL `fork`/`exec`, where the
 * interleaving is whatever the kernel and the scheduler actually produce.
 *
 * Four children are spawned **concurrently, exactly once** against one
 * shared temp home. Every assertion is on the *set* of outcomes — one
 * `ready`, three conceded/refused — never on *which* child wins.
 *
 * The winner is then given a graceful `SIGTERM` as this file's own cleanup,
 * which doubles (at zero extra spawn cost) as this package's one
 * out-of-process proof of a full, real, happy-path graceful drain: exit 0,
 * and the socket, the claim file, and the persisted credential entry all
 * gone afterward (design C9's `serving -> draining -> stopped`).
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createFileSecretStore } from "@heniek/secrets";
import { afterEach, describe, expect, it } from "vitest";
import { CREDENTIAL_ENTRY_NAME } from "../src/auth/credential.js";
import { parseClaimRecord } from "../src/lifecycle/claim-record.js";
import {
  type ChildHandle,
  createTempDaemonHome,
  spawnDaemonChild,
  type TempDaemonHome,
  waitForChildClose,
  waitForLineOrClose,
} from "./helpers/spawn-daemon-child.js";

const CHILD_COUNT = 4;

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

describe("real out-of-process parallel start (plan Task 6 Step 2)", () => {
  it("exactly one of four concurrently spawned real children reaches ready — the other three concede or refuse with the mapped exit code", async () => {
    home = await createTempDaemonHome();
    const paths = home.home.paths;

    const handles: readonly ChildHandle[] = Array.from({ length: CHILD_COUNT }, () =>
      spawnDaemonChild({ mode: "start", homeDirectory: home?.directory ?? "" }),
    );
    survivors = [...handles];

    const outcomes = await Promise.all(
      handles.map(async (handle) => ({
        handle,
        outcome: await waitForLineOrClose(handle, isReadyLine),
      })),
    );

    const winners = outcomes.filter(
      (entry): entry is { handle: ChildHandle; outcome: { kind: "line"; line: unknown } } =>
        entry.outcome.kind === "line",
    );
    const losers = outcomes.filter(
      (
        entry,
      ): entry is {
        handle: ChildHandle;
        outcome: { kind: "closed"; result: { code: number | null; signal: NodeJS.Signals | null } };
      } => entry.outcome.kind === "closed",
    );

    // The core invariant this test exists for: exactly one winner, never
    // zero and never more than one.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(CHILD_COUNT - 1);

    for (const loser of losers) {
      expect(loser.outcome.result.signal).toBeNull();
      expect([10, 11]).toContain(loser.outcome.result.code);
      survivors = survivors.filter((handle) => handle !== loser.handle);
    }

    expect(statSync(paths.runtimeDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(paths.daemonSocketFile).mode & 0o777).toBe(0o600);
    expect(statSync(paths.daemonPidFile).mode & 0o777).toBe(0o600);

    const winner = winners[0];
    if (winner === undefined) {
      throw new Error("unreachable: winners.length was asserted to be 1 above");
    }
    const winnerLine = winner.outcome.line as { readonly pid: number };

    const recordText = readFileSync(paths.daemonPidFile, "utf8");
    const parsed = parseClaimRecord(recordText);
    expect(parsed.kind).toBe("well-formed");
    if (parsed.kind === "well-formed") {
      expect(parsed.record.state).toBe("serving");
      expect(parsed.record.pid).toBe(winnerLine.pid);
    }

    // Bonus, zero-extra-spawn coverage: a graceful SIGTERM against the
    // real winner proves the full happy-path drain (design C9's
    // `serving -> draining -> stopped`) — exit 0, and every artefact this
    // process published is gone afterward.
    winner.handle.child.kill("SIGTERM");
    const winnerClosed = await waitForChildClose(winner.handle);
    survivors = survivors.filter((handle) => handle !== winner.handle);
    expect(winnerClosed.signal).toBeNull();
    expect(winnerClosed.code).toBe(0);
    expect(existsSync(paths.daemonSocketFile)).toBe(false);
    expect(existsSync(paths.daemonPidFile)).toBe(false);
    expect(readdirSync(paths.runtimeDirectory)).toEqual([]);

    const secretStore = createFileSecretStore({ directory: paths.secretsDirectory });
    expect(await secretStore.read(CREDENTIAL_ENTRY_NAME)).toBeUndefined();
  }, 60_000);
});
