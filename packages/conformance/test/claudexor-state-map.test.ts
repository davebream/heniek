import { describe, expect, it } from "vitest";
import {
  CLAUDEXOR_RUN_STATES,
  type HeniekRunState,
  toHeniekRunState,
  UnknownClaudexorRunStateError,
} from "../src/smoke/claudexor/state-map.js";

describe("toHeniekRunState", () => {
  it.each<[string, boolean, HeniekRunState]>([
    ["queued", false, "QUEUED"],
    ["running", false, "RUNNING"],
    ["running", true, "WAITING_ON_USER"],
    ["succeeded", false, "SUCCEEDED"],
    ["failed", false, "FAILED"],
    ["cancelled", false, "CANCELLED"],
    ["interrupted", false, "RECOVERY_REQUIRED"],
  ])("maps %s (waitingOnUser=%s) to %s", (state, waitingOnUser, expected) => {
    expect(toHeniekRunState({ state, waitingOnUser })).toBe(expected);
  });

  // Claudexor has no waiting lifecycle state; Heniek's WAITING_ON_USER must be
  // derived from the out-of-band flag, so the same lifecycle state maps two
  // different ways depending on it.
  it("derives WAITING_ON_USER from the flag, not from the lifecycle state", () => {
    expect(toHeniekRunState({ state: "running", waitingOnUser: true })).not.toBe(
      toHeniekRunState({ state: "running", waitingOnUser: false }),
    );
  });

  // An uncertain attempt must reach an explicit operator decision (spec §18.2)
  // rather than being reported as a plain failure that invites a silent retry.
  it("maps interrupted to RECOVERY_REQUIRED, distinct from FAILED", () => {
    expect(toHeniekRunState({ state: "interrupted", waitingOnUser: false })).toBe(
      "RECOVERY_REQUIRED",
    );
    expect(toHeniekRunState({ state: "failed", waitingOnUser: false })).toBe("FAILED");
  });

  it("covers every known Claudexor run state", () => {
    for (const state of CLAUDEXOR_RUN_STATES) {
      expect(() => toHeniekRunState({ state, waitingOnUser: false })).not.toThrow();
    }
  });

  it("never returns WAITING_FOR_PARENT_SESSION, which has no Claudexor source", () => {
    const produced = new Set<HeniekRunState>();
    for (const state of CLAUDEXOR_RUN_STATES) {
      produced.add(toHeniekRunState({ state, waitingOnUser: false }));
      produced.add(toHeniekRunState({ state, waitingOnUser: true }));
    }
    expect(produced.has("WAITING_FOR_PARENT_SESSION")).toBe(false);
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
});
