import type { ExecutionFailureV1, ResolvedProfileV2 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  isFallbackEligibleFailure,
  resolveAttemptLimits,
  resolveAttemptPermissions,
} from "../src/scheduling/policy.js";

type FailureClass = Static<typeof ExecutionFailureV1>["classification"];
type Profile = Static<typeof ResolvedProfileV2>;

const eligible: readonly FailureClass[] = [
  "account_unavailable",
  "profile_unavailable",
  "model_unavailable",
  "engine_unavailable",
  "provider_throttled",
  "context_capacity_exhausted",
];
const ineligible: readonly FailureClass[] = [
  "authentication_failed",
  "permission_denied",
  "invalid_request",
  "workspace_failed",
  "artifact_failed",
  "hard_limit_exceeded",
  "cancelled",
  "ambiguous",
  "unknown",
];

function profile(workspace: "read-only" | "read-write", identifiers: readonly string[]) {
  return { permissions: { workspace, identifiers } } as Pick<Profile, "permissions">;
}

describe("Q021 scheduling policy", () => {
  it.each(eligible)("allows the typed %s failure class", (failureClass) => {
    expect(
      isFallbackEligibleFailure({
        schemaVersion: 1,
        classification: failureClass,
        phase: "running",
        code: "typed",
        message: "attempt unavailable",
        fallbackEligible: true,
      }),
    ).toBe(true);
  });

  it.each(ineligible)("fails closed for %s", (failureClass) => {
    expect(
      isFallbackEligibleFailure({
        schemaVersion: 1,
        classification: failureClass,
        phase: "running",
        code: "typed",
        message: "attempt failed",
        fallbackEligible: false,
      }),
    ).toBe(false);
  });

  it("does not trust an inconsistent eligible flag on an ineligible class", () => {
    expect(
      isFallbackEligibleFailure({
        schemaVersion: 1,
        classification: "authentication_failed",
        phase: "start",
        code: "auth",
        message: "authentication failed",
        fallbackEligible: true,
      }),
    ).toBe(false);
  });

  it("narrows workspace access and requires identifiers in both allowlists", () => {
    expect(
      resolveAttemptPermissions(
        profile("read-write", ["shared", "primary-only"]),
        profile("read-only", ["shared"]),
        ["shared"],
      ),
    ).toEqual({
      ok: true,
      permissions: { schemaVersion: 1, workspace: "read-only", identifiers: ["shared"] },
    });
    expect(
      resolveAttemptPermissions(
        profile("read-write", ["shared"]),
        profile("read-write", ["shared", "candidate-only"]),
        ["candidate-only"],
      ),
    ).toEqual({ ok: false, reason: "primary_denied" });
    expect(
      resolveAttemptPermissions(
        profile("read-write", ["shared", "primary-only"]),
        profile("read-write", ["shared"]),
        ["primary-only"],
      ),
    ).toEqual({ ok: false, reason: "candidate_denied" });
  });

  it("takes independent minima and never resets an absolute hard deadline", () => {
    expect(
      resolveAttemptLimits({
        stage: { maxDurationMs: 120_000, maxTurns: 20 },
        invocation: { maxDurationMs: 90_000, maxTurns: 10 },
        profileMaxDurationMs: 100_000,
        hardDeadlineAt: "2026-01-01T00:01:00.000Z",
        now: "2026-01-01T00:00:40.000Z",
      }),
    ).toEqual({ maxDurationMs: 20_000, maxTurns: 10 });
  });
});
