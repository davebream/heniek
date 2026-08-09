/**
 * Unit tests for classified failure observation building (Q028).
 */

import { describe, expect, it } from "vitest";
import { buildClassifiedFailureObservation } from "../src/runtime/recovery-observation.js";

describe("buildClassifiedFailureObservation", () => {
  it("classifies a runner failure and builds a signature", () => {
    const result = buildClassifiedFailureObservation({
      runnerFailure: {
        schemaVersion: 2,
        classification: "timeout",
        phase: "observe",
        code: "timeout",
        message: "deadline exceeded",
        retryable: true,
        recovery: "none",
      },
    });
    expect(result.failure.category).toBe("transient");
    expect(result.failure.retryable).toBe(true);
    expect(result.failure.runnerRetryable).toBe(true);
    expect(result.retryable).toBe(true);
    expect(result.signature.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.signature.code).toBe("timeout");
  });

  it("includes validation failure codes and clears retryable for terminal classes", () => {
    const result = buildClassifiedFailureObservation({
      runnerFailure: {
        schemaVersion: 2,
        classification: "cancelled",
        phase: "cancel",
        code: "cancelled",
        message: "cancelled",
        retryable: true,
        recovery: "none",
      },
      validation: {
        schemaVersion: 1,
        attemptId: "att_1" as never,
        valid: false,
        missingWrites: ["artifacts.out"],
        missingEvidence: ["artifact:out"],
        envelopeValid: false,
        exitCodeAlone: false,
        recordedAt: "2026-08-09T23:00:00.000Z",
      },
    });
    expect(result.failure.category).toBe("terminal");
    expect(result.failure.retryable).toBe(false);
    expect(result.failure.runnerRetryable).toBe(true);
    expect(result.failure.validationFailures).toEqual([
      "envelope_invalid",
      "missing_evidence:artifact:out",
      "missing_write:artifacts.out",
    ]);
    expect(result.signature.validationFailures).toEqual(result.failure.validationFailures);
  });
});
