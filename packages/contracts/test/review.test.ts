import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ReviewFindingV1, ReviewReportV1 } from "../src/index.js";

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => !Number.isNaN(Date.parse(value)));
}

function report() {
  const evidence = { kind: "source" as const, path: "src/example.ts", startLine: 3 };
  return {
    schemaVersion: 1 as const,
    reportId: "review-1",
    runId: "run-1",
    stageId: "critique",
    sourceArtifactIds: ["artifact-design"],
    markdown: "# Critique\n\nEvidence-backed finding.",
    createdAt: "2026-08-10T00:00:00.000Z",
    reviewKind: "design-critique" as const,
    contextPolicy: "fresh" as const,
    verdict: "needs-repair" as const,
    findings: [
      {
        schemaVersion: 1 as const,
        findingId: "F_DESIGN_1",
        severity: "critical" as const,
        title: "Missing invariant",
        detail: "The plan omits a required invariant.",
        evidence: [evidence],
        disposition: { status: "accepted" as const },
        claimVerification: { state: "verified" as const, evidence: [evidence] },
      },
    ],
  };
}

describe("review contracts", () => {
  it("accepts a complete report", () => {
    expect(Value.Check(ReviewReportV1, [ReviewFindingV1], report())).toBe(true);
  });

  it.each([
    [
      "missing evidence",
      () => ({ ...report(), findings: [{ ...report().findings[0], evidence: [] }] }),
    ],
    ["unsupported version", () => ({ ...report(), schemaVersion: 2 })],
    ["unknown field", () => ({ ...report(), providerPayload: "forbidden" })],
  ])("rejects %s", (_name, mutate) => {
    expect(Value.Check(ReviewReportV1, [ReviewFindingV1], mutate())).toBe(false);
  });
});
