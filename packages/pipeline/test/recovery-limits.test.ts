/**
 * Strictest-wins repair budget and concurrency precedence.
 */

import { describe, expect, it } from "vitest";
import { resolveEffectiveConcurrency, resolveRepairBudget } from "../src/recovery/limits.js";

describe("resolveRepairBudget", () => {
  it("returns 0 when no limits are defined", () => {
    expect(resolveRepairBudget({})).toBe(0);
  });

  it("takes the minimum of all defined limits", () => {
    const cases = [
      { effectiveMaxRepairAttempts: 3, stageMaxRepairAttempts: 5, expected: 3 },
      { pipelineMaxRepairAttempts: 4, stageMaxRepairAttempts: 2, expected: 2 },
      {
        effectiveMaxRepairAttempts: 5,
        pipelineMaxRepairAttempts: 4,
        stageMaxRepairAttempts: 3,
        validationMaxAttempts: 2,
        expected: 2,
      },
      { validationMaxAttempts: 1, expected: 1 },
      { effectiveMaxRepairAttempts: 0, stageMaxRepairAttempts: 10, expected: 0 },
    ] as const;

    for (const entry of cases) {
      const { expected, ...input } = entry;
      expect(resolveRepairBudget(input)).toBe(expected);
    }
  });

  it("prefers effective limits when they are the strictest", () => {
    expect(
      resolveRepairBudget({
        effectiveMaxRepairAttempts: 1,
        pipelineMaxRepairAttempts: 3,
        stageMaxRepairAttempts: 3,
      }),
    ).toBe(1);
  });
});

describe("resolveEffectiveConcurrency", () => {
  it("returns undefined when unset", () => {
    expect(resolveEffectiveConcurrency({})).toBeUndefined();
  });

  it("takes the minimum of defined concurrency caps", () => {
    expect(
      resolveEffectiveConcurrency({
        effectiveMaxConcurrentWorkers: 2,
        pipelineMaxConcurrentWorkers: 4,
      }),
    ).toBe(2);
  });
});
