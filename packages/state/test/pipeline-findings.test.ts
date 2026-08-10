import { rm } from "node:fs/promises";
import type { StructuredReviewReport } from "@heniek/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listRunFindings,
  openStateDatabase,
  rebuildFindingProjection,
  recordFindingReport,
  runMigrations,
  type StateDatabase,
  StateStoreError,
  validateFindingReportIngestion,
} from "../src/index.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const RUN_ID = "run-careful-1";
const NOW = "2026-08-10T00:00:00.000Z";
const sourceEvidence = { kind: "source" as const, path: "src/example.ts", startLine: 1 };

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

function review(): StructuredReviewReport {
  return {
    schemaVersion: 1,
    reportId: "review-code-1",
    runId: RUN_ID,
    stageId: "code-review",
    sourceArtifactIds: ["artifact-implementation"],
    markdown: "# Code review\n\nAccepted F_CODE_1; rejected F_CODE_2.",
    createdAt: NOW,
    reviewKind: "code-review",
    contextPolicy: "fresh",
    verdict: "needs-repair",
    findings: [
      {
        schemaVersion: 1,
        findingId: "F_CODE_1",
        severity: "major",
        title: "Accepted defect",
        detail: "A contract is violated.",
        evidence: [sourceEvidence],
        disposition: { status: "accepted" },
        claimVerification: { state: "verified", evidence: [sourceEvidence] },
      },
      {
        schemaVersion: 1,
        findingId: "F_CODE_2",
        severity: "minor",
        title: "Retracted claim",
        detail: "The implementation is already correct.",
        evidence: [sourceEvidence],
        disposition: { status: "rejected", reason: "The cited source disproves it." },
        claimVerification: { state: "retracted", evidence: [sourceEvidence] },
      },
    ],
  } as StructuredReviewReport;
}

function repair(): StructuredReviewReport {
  return {
    schemaVersion: 1,
    reportId: "repair-code-1",
    runId: RUN_ID,
    stageId: "repair",
    sourceArtifactIds: ["artifact-review"],
    markdown: "# Repair\n\nApplied F_CODE_1.",
    createdAt: "2026-08-10T00:01:00.000Z",
    sourceReportId: "review-code-1",
    entries: [
      {
        findingId: "F_CODE_1",
        outcome: "applied",
        evidence: [sourceEvidence],
      },
    ],
  } as StructuredReviewReport;
}

function verification(): StructuredReviewReport {
  return {
    schemaVersion: 1,
    reportId: "verify-final-1",
    runId: RUN_ID,
    stageId: "final-verification",
    sourceArtifactIds: ["artifact-review", "artifact-repair", "artifact-checks"],
    markdown: "# Final verification\n\nF_CODE_1 fixed; F_CODE_2 not applicable.",
    createdAt: "2026-08-10T00:02:00.000Z",
    sourceReviewReportIds: ["review-code-1"],
    sourceRepairReportIds: ["repair-code-1"],
    deterministicCheckArtifactIds: ["artifact-checks"],
    verdict: "ready",
    findings: [
      { findingId: "F_CODE_1", result: "fixed", evidence: [sourceEvidence] },
      { findingId: "F_CODE_2", result: "not_applicable", evidence: [sourceEvidence] },
    ],
  } as StructuredReviewReport;
}

function record(report: StructuredReviewReport, artifactId: string, digestCharacter: string) {
  return recordFindingReport(db, {
    report,
    artifactId,
    contentHash: digestCharacter.repeat(64),
  });
}

describe("pipeline finding reports and projection", () => {
  it("tracks accepted and rejected findings through repair and final verification", () => {
    record(review(), "artifact-review", "a");
    expect(listRunFindings(db, RUN_ID)).toMatchObject([
      { findingId: "F_CODE_1", repairState: "pending", resolutionState: "pending" },
      {
        findingId: "F_CODE_2",
        repairState: "not_required",
        resolutionState: "not_applicable",
      },
    ]);

    record(repair(), "artifact-repair", "b");
    record(verification(), "artifact-final", "c");
    const completed = listRunFindings(db, RUN_ID);
    expect(completed).toMatchObject([
      { findingId: "F_CODE_1", repairState: "applied", resolutionState: "fixed", revision: 3 },
      {
        findingId: "F_CODE_2",
        repairState: "not_required",
        resolutionState: "not_applicable",
        revision: 2,
      },
    ]);
    expect(listRunFindings(db, RUN_ID, { disposition: "rejected" })).toHaveLength(1);

    const beforeRebuild = JSON.stringify(completed);
    expect(JSON.stringify(rebuildFindingProjection(db, RUN_ID))).toBe(beforeRebuild);
  });

  it("is idempotent by report digest and rejects conflicts and rejected repairs", () => {
    expect(record(review(), "artifact-review", "a").inserted).toBe(true);
    expect(record(review(), "artifact-review", "a").inserted).toBe(false);
    expect(() => record(review(), "artifact-review-2", "f")).toThrow(StateStoreError);

    const invalidRepair = repair();
    if (!("entries" in invalidRepair)) throw new Error("fixture must be a repair report");
    invalidRepair.entries[0] = {
      findingId: "F_CODE_2",
      outcome: "applied",
      evidence: [sourceEvidence],
    };
    expect(() => record(invalidRepair, "artifact-invalid", "d")).toThrow(
      /cannot act on rejected finding/,
    );
  });

  it("preflights broken lineage and incomplete final verification without mutation", () => {
    record(review(), "artifact-review", "a");

    const orphanRepair = repair();
    if (!("entries" in orphanRepair)) throw new Error("fixture must be a repair report");
    orphanRepair.sourceReportId = "missing-review";
    expect(() =>
      validateFindingReportIngestion(db, {
        report: orphanRepair,
        artifactId: "pending:repair",
        contentHash: "b".repeat(64),
      }),
    ).toThrow(/unknown report/);
    expect(listRunFindings(db, RUN_ID).every((finding) => finding.revision === 1)).toBe(true);

    record(repair(), "artifact-repair", "b");
    const incomplete = verification();
    if (!("deterministicCheckArtifactIds" in incomplete)) {
      throw new Error("fixture must be a final verification report");
    }
    incomplete.findings = incomplete.findings.filter((finding) => finding.findingId !== "F_CODE_2");
    expect(() =>
      validateFindingReportIngestion(db, {
        report: incomplete,
        artifactId: "pending:final",
        contentHash: "c".repeat(64),
      }),
    ).toThrow(/cover every finding/);
    expect(
      listRunFindings(db, RUN_ID).every((finding) => finding.resolutionState !== "fixed"),
    ).toBe(true);
  });
});
