import { RunStatus } from "@heniek/contracts";
import { describe, expect, it } from "vitest";
import {
  CLAUDEXOR_RUN_STATES,
  INTERRUPTED_MAPPING_IS_PROVISIONAL,
  toHeniekRunState,
  UnknownClaudexorRunStateError,
} from "../src/smoke/claudexor/state-map.js";

describe("toHeniekRunState", () => {
  it.each<[string, boolean, RunStatus]>([
    ["queued", false, "queued"],
    ["running", false, "running"],
    ["running", true, "waiting_on_user"],
    ["queued", true, "waiting_on_user"],
    ["succeeded", false, "succeeded"],
    ["failed", false, "failed"],
    ["cancelled", false, "cancelled"],
    ["interrupted", false, "recovery_required"],
  ])("maps %s (waitingOnUser=%s) to %s", (state, waitingOnUser, expected) => {
    expect(toHeniekRunState({ state, waitingOnUser })).toBe(expected);
  });

  // The mapping must speak the canonical contract vocabulary, not a private
  // copy of it: a parallel enum typechecks fine and still fails to transfer to
  // a production adapter, and goes stale silently when the contract changes.
  it("only ever returns values that exist in the contracts RunStatus", () => {
    for (const state of CLAUDEXOR_RUN_STATES) {
      for (const waitingOnUser of [false, true]) {
        const mapped: string = toHeniekRunState({ state, waitingOnUser });
        expect(RunStatus.values as readonly string[]).toContain(mapped);
      }
    }
  });

  // Claudexor has no waiting lifecycle state; waiting is out-of-band.
  it("derives waiting_on_user from the flag, not from the lifecycle state", () => {
    expect(toHeniekRunState({ state: "running", waitingOnUser: true })).not.toBe(
      toHeniekRunState({ state: "running", waitingOnUser: false }),
    );
  });

  // Spec §17 treats questions as normal state, and the flag can lag or race a
  // question raised as the run settles, so the interactions count also counts.
  it("derives waiting_on_user from open interactions even when the flag is false", () => {
    expect(toHeniekRunState({ state: "running", waitingOnUser: false, openInteractions: 1 })).toBe(
      "waiting_on_user",
    );
    expect(toHeniekRunState({ state: "running", waitingOnUser: false, openInteractions: 0 })).toBe(
      "running",
    );
  });

  it("never reports a terminal run as waiting", () => {
    expect(toHeniekRunState({ state: "succeeded", waitingOnUser: true })).toBe("succeeded");
    expect(toHeniekRunState({ state: "failed", waitingOnUser: true, openInteractions: 3 })).toBe(
      "failed",
    );
  });

  it("never returns waiting_for_parent_session, which has no Claudexor source", () => {
    const produced = new Set<string>();
    for (const state of CLAUDEXOR_RUN_STATES) {
      produced.add(toHeniekRunState({ state, waitingOnUser: false }));
      produced.add(toHeniekRunState({ state, waitingOnUser: true }));
    }
    expect(produced.has("waiting_for_parent_session")).toBe(false);
  });

  it("throws on an unknown state and names the observed value", () => {
    expect(() => toHeniekRunState({ state: "paused", waitingOnUser: false })).toThrow(
      UnknownClaudexorRunStateError,
    );
    try {
      toHeniekRunState({ state: "paused", waitingOnUser: false });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("paused");
    }
  });

  it("bounds and sanitises an engine-controlled state in the error message", () => {
    const hostile = `${"x".repeat(200)} /home/dave/secret`;
    try {
      toHeniekRunState({ state: hostile, waitingOnUser: false });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("/home/");
      expect(message.length).toBeLessThan(200);
    }
  });
});

describe("interrupted mapping provenance", () => {
  // Nothing has yet observed what PRODUCES `interrupted` on the pinned engine.
  // Canary 4 decides it. Until then the mapping is a hypothesis and must not
  // be counted as a satisfied acceptance criterion.
  it("is still flagged provisional pending the canary-4 observation", () => {
    expect(INTERRUPTED_MAPPING_IS_PROVISIONAL).toBe(true);
  });
});
