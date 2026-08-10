import { describe, expect, it } from "vitest";
import { validateStructuredReviewReport } from "../src/index.js";

const evidence = {
  kind: "source" as const,
  path: "src/example.ts",
  startLine: 1,
};

function reviewReport() {
  return {
    schemaVersion: 1 as const,
    reportId: "review-1",
    runId: "run-1",
    stageId: "code-review",
    sourceArtifactIds: ["artifact-1"],
    markdown: "# Review\n\nOne accepted and one rejected finding.",
    createdAt: "2026-08-10T00:00:00.000Z",
    reviewKind: "code-review" as const,
    contextPolicy: "fresh" as const,
    verdict: "needs-repair" as const,
    findings: [
      {
        schemaVersion: 1 as const,
        findingId: "F_CODE_1",
        severity: "major" as const,
        title: "Accepted defect",
        detail: "The implementation violates the contract.",
        evidence: [evidence],
        disposition: { status: "accepted" as const },
        claimVerification: { state: "verified" as const, evidence: [evidence] },
      },
      {
        schemaVersion: 1 as const,
        findingId: "F_CODE_2",
        severity: "minor" as const,
        title: "False positive",
        detail: "The cited behavior is intentional.",
        evidence: [evidence],
        disposition: { status: "rejected" as const, reason: "Evidence disproves the claim." },
        claimVerification: { state: "retracted" as const, evidence: [evidence] },
      },
    ],
  };
}

describe("structured review report validation", () => {
  it("derives routing state from accepted and rejected findings", () => {
    const result = validateStructuredReviewReport(
      "review-report-v1",
      Buffer.from(JSON.stringify(reviewReport())),
    );
    expect(result.valid).toBe(true);
    expect(result.contentSchemaId).toBe("heniek://contract/ReviewReport/v1");
    expect(result.stateValue).toEqual({
      reportId: "review-1",
      verdict: "needs-repair",
      actionableFindingIds: ["F_CODE_1"],
      blockingFindingIds: ["F_CODE_1"],
      rejectedFindingIds: ["F_CODE_2"],
    });
  });

  it("rejects malformed JSON, duplicate IDs, and disposition drift", () => {
    expect(validateStructuredReviewReport("review-report-v1", Buffer.from("{"))).toMatchObject({
      valid: false,
    });

    const duplicate = reviewReport();
    const duplicateSecond = duplicate.findings[1];
    if (duplicateSecond === undefined) throw new Error("fixture must contain two findings");
    duplicate.findings[1] = { ...duplicateSecond, findingId: "F_CODE_1" };
    expect(
      validateStructuredReviewReport("review-report-v1", Buffer.from(JSON.stringify(duplicate))),
    ).toMatchObject({ valid: false, detail: "finding IDs must be unique within a report" });

    const drifted = reviewReport();
    drifted.findings[0] = {
      ...drifted.findings[0],
      claimVerification: { state: "retracted", evidence: [evidence] },
    } as (typeof drifted.findings)[number];
    expect(
      validateStructuredReviewReport("review-report-v1", Buffer.from(JSON.stringify(drifted))),
    ).toMatchObject({ valid: false });
  });
});
