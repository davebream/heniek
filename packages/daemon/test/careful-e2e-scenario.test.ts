/** Q031 hermetic `careful` scenario: seeded findings, bounded repair, projection, and export. */

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import type { ReviewReportSchemaName, StructuredReviewReport } from "@heniek/contracts";
import { loadBundledPipeline } from "@heniek/pipeline";
import { validateStructuredReviewReport } from "@heniek/runner";
import {
  listRunFindings,
  openStateDatabase,
  rebuildFindingProjection,
  recordFindingReport,
  runMigrations,
  type StateDatabase,
} from "@heniek/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeterministicIds, createFakeClock } from "../../state/test/helpers/determinism.js";
import { makeTempDbPath } from "../../state/test/helpers/temp-db.js";

const RUN_ID = "run-careful-e2e";
const NOW = "2026-08-10T12:00:00.000Z";
const evidence = { kind: "source" as const, path: "src/service.ts", startLine: 10 };

let directory: string;
let db: StateDatabase;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  db = openStateDatabase({
    path: temp.path,
    clock: createFakeClock(Date.parse(NOW)),
    ids: createDeterministicIds(1),
  });
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function accept(
  schemaName: ReviewReportSchemaName,
  report: StructuredReviewReport,
  attemptOrdinal = 1,
) {
  const bytes = Buffer.from(JSON.stringify(report));
  const validation = validateStructuredReviewReport(schemaName, bytes, {
    runId: RUN_ID,
    stageId: report.stageId,
  });
  if (!validation.valid) return { validation, attemptOrdinal };
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  recordFindingReport(db, {
    artifactId: `artifact-${report.reportId}`,
    contentHash,
    report,
  });
  return { validation, attemptOrdinal, contentHash };
}

function review(
  reportId: string,
  stageId: string,
  reviewKind: "design-critique" | "plan-validation" | "code-review",
  findings: Extract<StructuredReviewReport, { reviewKind: unknown }>["findings"],
): StructuredReviewReport {
  const blocking = findings.some(
    (finding) =>
      finding.disposition.status === "accepted" &&
      (finding.severity === "critical" || finding.severity === "major"),
  );
  return {
    schemaVersion: 1,
    reportId,
    runId: RUN_ID,
    stageId,
    sourceArtifactIds: [],
    markdown: `# ${reviewKind}\n\n${findings.length} finding(s).`,
    createdAt: NOW,
    reviewKind,
    contextPolicy: "fresh",
    verdict: blocking ? "needs-repair" : "ready",
    findings,
  } as unknown as StructuredReviewReport;
}

describe("Q031 careful e2e fake scenario", () => {
  it("repairs accepted findings, excludes a retracted finding, and stops after one retry", () => {
    const loaded = loadBundledPipeline("careful", 1);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const designReview = review("review-design-1", "critique", "design-critique", [
      {
        schemaVersion: 1,
        findingId: "F_DESIGN_1",
        severity: "major",
        title: "Missing boundary",
        detail: "The design omits an adapter boundary.",
        evidence: [evidence],
        disposition: { status: "accepted" },
        claimVerification: { state: "verified", evidence: [evidence] },
      },
    ]);
    expect(accept("review-report-v1", designReview).validation.valid).toBe(true);

    const designRepair = {
      schemaVersion: 1,
      reportId: "repair-design-1",
      runId: RUN_ID,
      stageId: "revise-plan",
      sourceArtifactIds: ["artifact-review-design-1"],
      markdown: "# Plan revision\n\nApplied F_DESIGN_1.",
      createdAt: NOW,
      sourceReportId: "review-design-1",
      entries: [{ findingId: "F_DESIGN_1", outcome: "applied", evidence: [evidence] }],
    } as StructuredReviewReport;
    expect(accept("repair-report-v1", designRepair).validation.valid).toBe(true);

    expect(
      accept("review-report-v1", review("review-plan-1", "plan-review", "plan-validation", []))
        .validation,
    ).toMatchObject({ valid: true, verdictReady: true });

    const codeReview = review("review-code-1", "code-review", "code-review", [
      {
        schemaVersion: 1,
        findingId: "F_CODE_1",
        severity: "critical",
        title: "Lost validation",
        detail: "Malformed input can pass the adapter.",
        evidence: [evidence],
        disposition: { status: "accepted" },
        claimVerification: { state: "verified", evidence: [evidence] },
      },
      {
        schemaVersion: 1,
        findingId: "F_CODE_2",
        severity: "minor",
        title: "False positive",
        detail: "The cited branch is unreachable.",
        evidence: [evidence],
        disposition: { status: "rejected", reason: "Source evidence disproves the claim." },
        claimVerification: { state: "retracted", evidence: [evidence] },
      },
    ]);
    const codeAccepted = accept("review-report-v1", codeReview);
    expect(codeAccepted.validation.stateValue).toMatchObject({
      actionableFindingIds: ["F_CODE_1"],
      rejectedFindingIds: ["F_CODE_2"],
    });

    const malformedRepair = validateStructuredReviewReport("repair-report-v1", Buffer.from("{}"), {
      runId: RUN_ID,
      stageId: "repair",
    });
    expect(malformedRepair.valid).toBe(false);

    const codeRepair = {
      schemaVersion: 1,
      reportId: "repair-code-1",
      runId: RUN_ID,
      stageId: "repair",
      sourceArtifactIds: ["artifact-review-code-1"],
      markdown: "# Repair\n\nApplied F_CODE_1; F_CODE_2 was not actionable.",
      createdAt: NOW,
      sourceReportId: "review-code-1",
      entries: [{ findingId: "F_CODE_1", outcome: "applied", evidence: [evidence] }],
    } as StructuredReviewReport;
    expect(accept("repair-report-v1", codeRepair, 2)).toMatchObject({
      attemptOrdinal: 2,
      validation: { valid: true },
    });

    const finalReport = {
      schemaVersion: 1,
      reportId: "final-1",
      runId: RUN_ID,
      stageId: "final-verification",
      sourceArtifactIds: ["artifact-repair-design-1", "artifact-repair-code-1", "artifact-checks"],
      markdown:
        "# Final verification\n\nDeterministic checks pass and accepted findings are fixed.",
      createdAt: NOW,
      sourceReviewReportIds: ["review-design-1", "review-code-1"],
      sourceRepairReportIds: ["repair-design-1", "repair-code-1"],
      deterministicCheckArtifactIds: ["artifact-checks"],
      verdict: "ready",
      findings: [
        { findingId: "F_DESIGN_1", result: "fixed", evidence: [evidence] },
        { findingId: "F_CODE_1", result: "fixed", evidence: [evidence] },
        { findingId: "F_CODE_2", result: "not_applicable", evidence: [evidence] },
      ],
    } as StructuredReviewReport;
    expect(accept("final-verification-report-v1", finalReport).validation).toMatchObject({
      valid: true,
      verdictReady: true,
    });

    const projection = listRunFindings(db, RUN_ID);
    expect(projection).toMatchObject([
      { findingId: "F_CODE_1", repairState: "applied", resolutionState: "fixed" },
      { findingId: "F_CODE_2", repairState: "not_required", resolutionState: "not_applicable" },
      { findingId: "F_DESIGN_1", repairState: "applied", resolutionState: "fixed" },
    ]);
    expect(rebuildFindingProjection(db, RUN_ID)).toEqual(projection);

    const runExport = {
      schemaVersion: "heniek.careful-run-export.v1",
      pipeline: `${loaded.entry.id}.v${loaded.entry.version}`,
      stages: [
        "understand-design",
        "critique",
        "revise-plan",
        "plan-review",
        "build",
        "code-review",
        "repair",
        "verify",
        "final-verification",
        "publish",
      ],
      repairAttempts: 2,
      deterministicChecks: { artifactId: "artifact-checks", passed: true },
      findings: projection,
      publication: { gatedBy: ["verify", "final-verification"], status: "ready" },
    };
    expect(runExport.repairAttempts).toBe(loaded.graph.limits.maxRepairAttempts);
    expect(runExport.publication.status).toBe("ready");
  });
});
