import { describe, expect, it } from "vitest";
import {
  classifyCancellation,
  classifyParentIndependence,
} from "../src/smoke/claudexor/canaries.js";
import {
  createControlClient,
  isTerminalClaudexorState,
} from "../src/smoke/claudexor/control-client.js";
import { startDaemon } from "../src/smoke/claudexor/daemon-handle.js";
import { readClaudexorSmokeConfig } from "../src/smoke/claudexor/gate.js";
import { EXPECTED_ENGINE_SHA, EXPECTED_PROTOCOL_MAJOR } from "../src/smoke/claudexor/protocol.js";

/**
 * Opt-in Claudexor canaries. Disabled in CI by construction: the gate requires
 * both HENIEK_CONFORMANCE_SMOKE=1 (with its mandatory AUTH_ROUTE) and
 * HENIEK_CONFORMANCE_SMOKE_CLAUDEXOR_ROOT pointing at a built pinned checkout
 * OUTSIDE this repository.
 *
 * The skip title names the required variables so the pending state is visible
 * in CI output rather than silently absent, matching `smoke.conformance.test.ts`.
 */
const config = readClaudexorSmokeConfig();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!config.enabled)(
  "Claudexor /v2 canaries [requires HENIEK_CONFORMANCE_SMOKE=1 + HENIEK_CONFORMANCE_SMOKE_CLAUDEXOR_ROOT]",
  () => {
    it("handshakes, and the engine self-reports the pinned revision", {
      timeout: 120_000,
    }, async () => {
      if (!config.enabled) return;
      const daemon = await startDaemon({ claudexorRoot: config.claudexorRoot });
      try {
        const client = createControlClient({ baseUrl: daemon.baseUrl, token: daemon.token });
        const handshake = await client.handshake();
        expect(handshake.protocolMajor).toBe(EXPECTED_PROTOCOL_MAJOR);
        expect(handshake.sha).toBe(EXPECTED_ENGINE_SHA);
        expect(handshake.operationsPath.startsWith("/v2/")).toBe(true);
      } finally {
        daemon.stop();
      }
    });

    it("cancels a live run and settles it as cancelled", { timeout: 300_000 }, async () => {
      if (!config.enabled) return;
      const daemon = await startDaemon({ claudexorRoot: config.claudexorRoot });
      try {
        const client = createControlClient({ baseUrl: daemon.baseUrl, token: daemon.token });
        await client.handshake();
        await client.registerProject(daemon.home);
        const run = await client.startRun({
          prompt: "Write a very long, detailed analysis. Keep writing for many minutes.",
          projectRoot: daemon.home,
        });

        const deadline = Date.now() + 120_000;
        let running = false;
        while (Date.now() < deadline && !running) {
          await sleep(3_000);
          running = (await client.getRun(run.runId)).claudexorState === "running";
        }
        expect(running).toBe(true);

        const settleStart = Date.now();
        await client.cancel(run.runId);
        let final = "unknown";
        while (Date.now() < settleStart + 120_000) {
          await sleep(3_000);
          const observed = await client.getRun(run.runId);
          if (isTerminalClaudexorState(observed.claudexorState)) {
            final = observed.claudexorState;
            break;
          }
        }

        const result = classifyCancellation({
          acceptedControlCall: true,
          finalState: final,
          survivingDescendantPids: 0,
          settleMs: Date.now() - settleStart,
        });
        expect(result.outcome, JSON.stringify(result.evidence)).not.toBe("unsupported");
      } finally {
        daemon.stop();
      }
    });

    // The >=20-minute parent-kill canary is wall-clock bound and is driven from
    // its own long-lived runner rather than a test timeout; the classifier it
    // reports through is `classifyParentIndependence`, which `pnpm check`
    // covers exhaustively.
    it("exposes the parent-independence classifier the long runner reports through", () => {
      expect(
        classifyParentIndependence({
          arm: "detached",
          claudexorStateAtKill: "running",
          launcherAliveAfterKill: false,
          daemonAliveAfterKill: true,
          postKillMs: 60_000,
          minimumPostKillMs: 20 * 60_000,
          postKillEventCount: 5,
          terminalReached: true,
          killAtFractionOfBudget: 0.05,
        }).outcome,
      ).toBe("degraded");
    });
  },
);
