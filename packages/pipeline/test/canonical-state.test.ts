/**
 * Canonical condition state materialization and path safety.
 */

import { describe, expect, it } from "vitest";
import { buildCanonicalConditionState, isSafeStatePath } from "../src/recovery/canonical-state.js";

describe("isSafeStatePath", () => {
  it("rejects unsafe segments", () => {
    expect(isSafeStatePath([])).toBe(false);
    expect(isSafeStatePath([""])).toBe(false);
    expect(isSafeStatePath(["__proto__"])).toBe(false);
    expect(isSafeStatePath(["prototype"])).toBe(false);
    expect(isSafeStatePath(["constructor"])).toBe(false);
    expect(isSafeStatePath([".."])).toBe(false);
    expect(isSafeStatePath(["a", "b"])).toBe(true);
  });
});

describe("buildCanonicalConditionState", () => {
  it("merges only validation-valid outputs", () => {
    const result = buildCanonicalConditionState({
      baseState: { task: { current: "ship" } },
      finalizedOutputs: [
        {
          stageId: "verify",
          writes: ["verify.blockingFindings"],
          outputs: [
            {
              reference: "verify.blockingFindings",
              kind: "value",
              value: [],
            },
          ],
          validationValid: true,
        },
        {
          stageId: "bad",
          writes: ["bad.value"],
          outputs: [{ reference: "bad.value", kind: "value", value: 1 }],
          validationValid: false,
        },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.state).toEqual({
      task: { current: "ship" },
      verify: { blockingFindings: [] },
    });
  });

  it("rejects prototype pollution paths", () => {
    const result = buildCanonicalConditionState({
      baseState: {},
      finalizedOutputs: [
        {
          stageId: "x",
          writes: ["__proto__.polluted"],
          outputs: [
            {
              reference: "__proto__.polluted",
              kind: "value",
              value: true,
            },
          ],
          validationValid: true,
        },
      ],
    });
    expect(result.errors.some((error) => error.code === "unsafe_path")).toBe(true);
    expect(
      typeof result.state === "object" &&
        result.state !== null &&
        !Array.isArray(result.state) &&
        Object.hasOwn(result.state, "polluted"),
    ).toBe(false);
  });

  it("rejects non-JSON values", () => {
    const result = buildCanonicalConditionState({
      baseState: {},
      finalizedOutputs: [
        {
          stageId: "x",
          writes: ["x.value"],
          outputs: [
            {
              reference: "x.value",
              kind: "value",
              value: () => 1,
            },
          ],
          validationValid: true,
        },
      ],
    });
    expect(result.errors.some((error) => error.code === "non_json_value")).toBe(true);
  });
});
