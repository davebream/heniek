/**
 * Context-pressure threshold behavior (Q029 / §15.3).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_HANDOFF_HARD_THRESHOLD,
  DEFAULT_HANDOFF_SOFT_THRESHOLD,
  evaluateContextPressure,
  pressureAllowsFusion,
} from "../src/fusion/pressure.js";

describe("evaluateContextPressure", () => {
  it("uses product-default thresholds", () => {
    expect(DEFAULT_HANDOFF_SOFT_THRESHOLD).toBe(0.65);
    expect(DEFAULT_HANDOFF_HARD_THRESHOLD).toBe(0.8);
  });

  it("continues below soft threshold", () => {
    const result = evaluateContextPressure({
      state: "measured",
      ratio: 0.5,
      confidence: "exact",
    });
    expect(result.action).toBe("continue");
    expect(pressureAllowsFusion(result)).toBe(true);
  });

  it("soft-bounds at soft threshold", () => {
    const result = evaluateContextPressure({
      state: "measured",
      ratio: 0.65,
      confidence: "exact",
    });
    expect(result.action).toBe("soft_boundary");
    expect(result.splitReason).toBe("pressure_soft_threshold");
    expect(pressureAllowsFusion(result)).toBe(false);
  });

  it("hard-checkpoints at hard threshold", () => {
    const result = evaluateContextPressure({
      state: "measured",
      ratio: 0.8,
      confidence: "exact",
    });
    expect(result.action).toBe("hard_checkpoint");
    expect(result.splitReason).toBe("pressure_hard_threshold");
  });

  it("hard-checkpoints on capacity exhaustion", () => {
    const result = evaluateContextPressure({
      state: "exhausted",
      confidence: "exact",
    });
    expect(result.action).toBe("hard_checkpoint");
    expect(result.splitReason).toBe("capacity_exhausted");
  });

  it("forbids fusion when telemetry is unavailable", () => {
    const result = evaluateContextPressure({
      state: "unavailable",
      confidence: "unavailable",
    });
    expect(result.action).toBe("forbid_fusion");
    expect(result.splitReason).toBe("pressure_unavailable");
  });

  it("uses estimated ratios conservatively against thresholds", () => {
    const result = evaluateContextPressure({
      state: "measured",
      ratio: 0.7,
      confidence: "estimated",
    });
    expect(result.action).toBe("soft_boundary");
  });

  it("honors pipeline threshold overrides", () => {
    const result = evaluateContextPressure({
      state: "measured",
      ratio: 0.5,
      confidence: "exact",
      softThreshold: 0.4,
      hardThreshold: 0.6,
    });
    expect(result.action).toBe("soft_boundary");
    expect(result.softThreshold).toBe(0.4);
  });

  it("treats missing ratio as unavailable", () => {
    const result = evaluateContextPressure({
      state: "measured",
      confidence: "exact",
    });
    expect(result.action).toBe("forbid_fusion");
  });
});
