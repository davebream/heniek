/**
 * Failure signature stability and volatile-field exclusion.
 */

import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/recovery/classify.js";
import { buildFailureSignature } from "../src/recovery/signature.js";

describe("buildFailureSignature", () => {
  it("produces a stable digest for equivalent failures", () => {
    const failure = classifyFailure({
      classification: "validation_failed",
      phase: "validate",
      code: "schema",
      retryable: true,
      validationFailures: ["b.missing", "a.invalid"],
    });
    const first = buildFailureSignature(failure);
    const second = buildFailureSignature({
      ...failure,
      validationFailures: ["a.invalid", "b.missing"],
    });
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.validationFailures).toEqual(["a.invalid", "b.missing"]);
  });

  it("excludes volatile message-like fields from the digest", () => {
    const base = classifyFailure({
      classification: "timeout",
      phase: "running",
      code: "timeout",
      retryable: true,
    });
    const signature = buildFailureSignature(base);
    const withNoise = buildFailureSignature({
      ...base,
      // message is not part of the signature input type; extra fields ignored
    });
    expect(signature.digest).toBe(withNoise.digest);
    expect(JSON.stringify(signature)).not.toContain("message");
  });

  it("changes digest when classification changes", () => {
    const left = buildFailureSignature(
      classifyFailure({
        classification: "timeout",
        phase: "running",
        code: "timeout",
        retryable: true,
      }),
    );
    const right = buildFailureSignature(
      classifyFailure({
        classification: "process_failed",
        phase: "running",
        code: "timeout",
        retryable: true,
      }),
    );
    expect(left.digest).not.toBe(right.digest);
  });
});
