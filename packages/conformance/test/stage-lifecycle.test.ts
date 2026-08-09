/**
 * Q023's stage lifecycle conformance check (ADR 0021). Two independent
 * things, matching the plan's own framing ("the RunStatus trace check + the
 * ownership invariant"):
 *
 * 1. `checkStageLifecycleTrace` — a recorded sequence of native stage
 *    lifecycle events either matches `STAGE_LIFECYCLE_TRANSITIONS` or it
 *    doesn't. The "valid" case below is the exact two-run sequence
 *    `packages/daemon/test/native-bridge-rpc.test.ts`'s real assembled-daemon
 *    canary produces over a live socket (transcribed from a real passing
 *    run, not invented) — this file re-checks it as data so a regression in
 *    the lifecycle table itself, independent of the daemon, fails here.
 * 2. `checkNoExternalMapperOwnsWaitingForParentSession` — the general form of
 *    `claudexor-state-map.test.ts`'s existing pin: no external mapper may
 *    ever produce `waiting_for_parent_session`, checked structurally rather
 *    than by re-deriving the one case that mapper happens to cover.
 */

import { RunStatus } from "@heniek/contracts";
import { describe, expect, it } from "vitest";
import { CLAUDEXOR_RUN_STATES, toHeniekRunState } from "../src/smoke/claudexor/state-map.js";
import {
  checkNoExternalMapperOwnsWaitingForParentSession,
  checkStageLifecycleTrace,
  type RunStatusMapperSample,
  STAGE_LIFECYCLE_TRANSITIONS,
  type StageLifecycleEvent,
} from "../src/stage-lifecycle/index.js";

describe("STAGE_LIFECYCLE_TRANSITIONS", () => {
  it("every declared from/to is a real RunStatus literal", () => {
    const known = new Set<string>(RunStatus.values);
    for (const entry of STAGE_LIFECYCLE_TRANSITIONS) {
      if (entry.from !== null) expect(known.has(entry.from)).toBe(true);
      expect(known.has(entry.to)).toBe(true);
    }
  });

  it("waiting_for_parent_session appears only as a target native admission, poll-claim wait, graceful-detach, or resume can produce", () => {
    const targets = STAGE_LIFECYCLE_TRANSITIONS.filter(
      (entry) => entry.to === "waiting_for_parent_session",
    ).map((entry) => entry.trigger);
    expect(new Set(targets)).toEqual(
      new Set(["stage_start_admitted_waiting", "graceful_detach_corroborated", "resume"]),
    );
  });
});

describe("checkStageLifecycleTrace", () => {
  it("accepts the real two-run sequence packages/daemon/test/native-bridge-rpc.test.ts's canary produced", () => {
    const firstRun: readonly StageLifecycleEvent[] = [
      { trigger: "stage_start_admitted_waiting", from: null, to: "waiting_for_parent_session" },
      { trigger: "poll_claim", from: "waiting_for_parent_session", to: "running" },
      { trigger: "raise_question", from: "running", to: "waiting_on_user" },
      { trigger: "answer_question", from: "waiting_on_user", to: "running" },
      { trigger: "submit_succeeded", from: "running", to: "succeeded" },
    ];
    const secondRun: readonly StageLifecycleEvent[] = [
      { trigger: "stage_start_admitted_waiting", from: null, to: "waiting_for_parent_session" },
      { trigger: "poll_claim", from: "waiting_for_parent_session", to: "running" },
      {
        trigger: "graceful_detach_corroborated",
        from: "running",
        to: "waiting_for_parent_session",
      },
      { trigger: "poll_claim", from: "waiting_for_parent_session", to: "running" },
      { trigger: "cancel", from: "running", to: "cancelled" },
    ];

    expect(checkStageLifecycleTrace(firstRun)).toEqual({ ok: true, violations: [] });
    expect(checkStageLifecycleTrace(secondRun)).toEqual({ ok: true, violations: [] });
  });

  it("accepts the recovery path: expiry, dead witness, then an operator resume", () => {
    const trace: readonly StageLifecycleEvent[] = [
      { trigger: "stage_start_admitted_waiting", from: null, to: "waiting_for_parent_session" },
      { trigger: "poll_claim", from: "waiting_for_parent_session", to: "running" },
      { trigger: "expiry_dead_or_unknown", from: "running", to: "recovery_required" },
      { trigger: "resume", from: "recovery_required", to: "waiting_for_parent_session" },
    ];
    expect(checkStageLifecycleTrace(trace)).toEqual({ ok: true, violations: [] });
  });

  it("accepts CR6's alive self-loop — an expiry sweep that finds the session merely stalled changes nothing", () => {
    const trace: readonly StageLifecycleEvent[] = [
      { trigger: "stage_start_admitted_waiting", from: null, to: "waiting_for_parent_session" },
      { trigger: "poll_claim", from: "waiting_for_parent_session", to: "running" },
      { trigger: "expiry_alive", from: "running", to: "running" },
      { trigger: "submit_succeeded", from: "running", to: "succeeded" },
    ];
    expect(checkStageLifecycleTrace(trace)).toEqual({ ok: true, violations: [] });
  });

  it("rejects a transition STAGE_LIFECYCLE_TRANSITIONS never declares", () => {
    const trace: readonly StageLifecycleEvent[] = [
      { trigger: "stage_start_admitted_waiting", from: null, to: "waiting_for_parent_session" },
      // Skips straight to succeeded — no dispatch, question, or submit ever happened.
      { trigger: "submit_succeeded", from: "waiting_for_parent_session", to: "succeeded" },
    ];
    const result = checkStageLifecycleTrace(trace);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.index).toBe(1);
  });

  it("rejects a causally-disconnected trace — two runs spliced together without a bridging event", () => {
    const trace: readonly StageLifecycleEvent[] = [
      { trigger: "stage_start_admitted_waiting", from: null, to: "waiting_for_parent_session" },
      { trigger: "poll_claim", from: "waiting_for_parent_session", to: "running" },
      // A second run's event, wrongly appended: its `from` should be null,
      // not "running" left over from the first run's last step.
      { trigger: "submit_succeeded", from: "running", to: "succeeded" },
      { trigger: "poll_claim", from: "waiting_for_parent_session", to: "running" },
    ];
    const result = checkStageLifecycleTrace(trace);
    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.index === 3)).toBe(true);
  });
});

describe("checkNoExternalMapperOwnsWaitingForParentSession", () => {
  it("the Claudexor mapper never produces waiting_for_parent_session over its full input domain", () => {
    const produced = new Set<RunStatus>();
    for (const state of CLAUDEXOR_RUN_STATES) {
      produced.add(toHeniekRunState({ state, waitingOnUser: false }));
      produced.add(toHeniekRunState({ state, waitingOnUser: true }));
    }
    const samples: readonly RunStatusMapperSample[] = [
      { mapperName: "claudexor", producedStatuses: produced },
    ];
    expect(checkNoExternalMapperOwnsWaitingForParentSession(samples)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("flags a hypothetical mapper that does emit it — the check is not vacuously true", () => {
    const samples: readonly RunStatusMapperSample[] = [
      { mapperName: "claudexor", producedStatuses: new Set<RunStatus>(["running", "succeeded"]) },
      {
        mapperName: "hypothetical-leaky-mapper",
        producedStatuses: new Set<RunStatus>(["running", "waiting_for_parent_session"]),
      },
    ];
    expect(checkNoExternalMapperOwnsWaitingForParentSession(samples)).toEqual({
      ok: false,
      violations: [{ mapperName: "hypothetical-leaky-mapper" }],
    });
  });
});
