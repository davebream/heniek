/**
 * Failure classification → PipelineFailureCategory mapping table.
 */

import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/recovery/classify.js";

describe("classifyFailure", () => {
  it.each([
    {
      name: "security via authentication_failed",
      input: {
        classification: "backend_failed",
        phase: "start",
        code: "auth",
        retryable: true,
        backendClassification: "authentication_failed",
      },
      category: "security",
      retryable: false,
    },
    {
      name: "security via permission_denied",
      input: {
        classification: "backend_failed",
        phase: "start",
        code: "perm",
        retryable: true,
        backendClassification: "permission_denied",
      },
      category: "security",
      retryable: false,
    },
    {
      name: "conflict stale_revision",
      input: {
        classification: "stale_revision",
        phase: "finalize",
        code: "stale",
        retryable: true,
      },
      category: "conflict",
      retryable: true,
    },
    {
      name: "conflict merge_conflict",
      input: {
        classification: "merge_conflict",
        phase: "finalize",
        code: "merge",
        retryable: false,
      },
      category: "conflict",
      retryable: false,
    },
    {
      name: "validation validation_failed",
      input: {
        classification: "validation_failed",
        phase: "validate",
        code: "schema",
        retryable: true,
      },
      category: "validation",
      retryable: true,
    },
    {
      name: "malformed_contract is terminal",
      input: {
        classification: "malformed_contract",
        phase: "collect",
        code: "bad",
        retryable: true,
      },
      category: "terminal",
      retryable: false,
    },
    {
      name: "provider profile_failed",
      input: {
        classification: "profile_failed",
        phase: "prepare",
        code: "profile",
        retryable: true,
      },
      category: "provider",
      retryable: true,
    },
    {
      name: "provider backend throttled",
      input: {
        classification: "backend_failed",
        phase: "running",
        code: "throttle",
        retryable: true,
        backendClassification: "provider_throttled",
      },
      category: "provider",
      retryable: true,
    },
    {
      name: "transient timeout",
      input: {
        classification: "timeout",
        phase: "running",
        code: "timeout",
        retryable: true,
      },
      category: "transient",
      retryable: true,
    },
    {
      name: "transient backend_failed without provider class",
      input: {
        classification: "backend_failed",
        phase: "running",
        code: "backend",
        retryable: true,
      },
      category: "transient",
      retryable: true,
    },
    {
      name: "terminal cancelled",
      input: {
        classification: "cancelled",
        phase: "running",
        code: "cancel",
        retryable: false,
      },
      category: "terminal",
      retryable: false,
    },
    {
      name: "terminal hard_limit_exceeded backend",
      input: {
        classification: "backend_failed",
        phase: "running",
        code: "limit",
        retryable: true,
        backendClassification: "hard_limit_exceeded",
      },
      category: "terminal",
      retryable: false,
    },
    {
      name: "unknown maps to terminal",
      input: {
        classification: "unknown",
        phase: "running",
        code: "x",
        retryable: true,
      },
      category: "terminal",
      retryable: false,
    },
  ] as const)("$name", ({ input, category, retryable }) => {
    const failure = classifyFailure(input);
    expect(failure.schemaVersion).toBe(1);
    expect(failure.category).toBe(category);
    expect(failure.retryable).toBe(retryable);
    expect(failure.runnerRetryable).toBe(input.retryable);
  });
});
