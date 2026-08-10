import {
  FinalVerificationReportV1,
  REVIEW_REPORT_SCHEMA_NAMES,
  RepairReportV1,
  ReviewFindingV1,
  type ReviewReportSchemaName,
  ReviewReportV1,
  type StructuredReviewReport,
} from "@heniek/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => !Number.isNaN(Date.parse(value)));
}

export interface StructuredReportValidation {
  readonly valid: boolean;
  readonly schemaName: ReviewReportSchemaName;
  readonly contentSchemaId: string;
  readonly mediaType: "application/json";
  readonly report?: StructuredReviewReport;
  readonly stateValue?: Readonly<Record<string, unknown>>;
  readonly verdictReady?: boolean;
  readonly detail?: string;
}

export function isReviewReportSchemaName(value: string): value is ReviewReportSchemaName {
  return Object.hasOwn(REVIEW_REPORT_SCHEMA_NAMES, value);
}

export function contentSchemaIdForReviewReport(name: ReviewReportSchemaName): string {
  const contract =
    name === "review-report-v1"
      ? "ReviewReport"
      : name === "repair-report-v1"
        ? "RepairReport"
        : "FinalVerificationReport";
  return `heniek://contract/${contract}/v1`;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validateLineRanges(report: StructuredReviewReport): boolean {
  const evidence =
    "reviewKind" in report
      ? report.findings.flatMap((finding) => [
          ...finding.evidence,
          ...finding.claimVerification.evidence,
        ])
      : "entries" in report
        ? report.entries.flatMap((entry) => entry.evidence)
        : report.findings.flatMap((finding) => finding.evidence);
  return evidence.every(
    (item) =>
      item.kind !== "source" || item.endLine === undefined || item.endLine >= item.startLine,
  );
}

function invalid(schemaName: ReviewReportSchemaName, detail: string): StructuredReportValidation {
  return {
    valid: false,
    schemaName,
    contentSchemaId: contentSchemaIdForReviewReport(schemaName),
    mediaType: "application/json",
    detail,
  };
}

export function validateStructuredReviewReport(
  schemaName: ReviewReportSchemaName,
  bytes: Uint8Array,
  expected?: { readonly runId: string; readonly stageId: string },
): StructuredReportValidation {
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return invalid(schemaName, "structured report is not valid JSON");
  }

  const schema = REVIEW_REPORT_SCHEMA_NAMES[schemaName];
  const contractValid =
    schemaName === "review-report-v1"
      ? Value.Check(ReviewReportV1, [ReviewFindingV1], candidate)
      : Value.Check(schema, candidate);
  if (!contractValid) {
    const firstError =
      schemaName === "review-report-v1"
        ? Value.Errors(ReviewReportV1, [ReviewFindingV1], candidate).First()
        : Value.Errors(schema, candidate).First();
    return invalid(
      schemaName,
      `structured report does not satisfy ${schemaName}${
        firstError === undefined ? "" : ` at ${firstError.path}: ${firstError.message}`
      }`,
    );
  }

  const report = candidate as StructuredReviewReport;
  if (
    expected !== undefined &&
    (report.runId !== expected.runId || report.stageId !== expected.stageId)
  ) {
    return invalid(
      schemaName,
      "structured report runId/stageId lineage does not match the attempt",
    );
  }
  if (!validateLineRanges(report)) {
    return invalid(schemaName, "source evidence endLine precedes startLine");
  }

  if (schemaName === "review-report-v1" && Value.Check(ReviewReportV1, [ReviewFindingV1], report)) {
    const ids = report.findings.map((finding) => finding.findingId);
    if (!unique(ids)) return invalid(schemaName, "finding IDs must be unique within a report");
    const invalidDisposition = report.findings.some(
      (finding) =>
        (finding.disposition.status === "accepted" &&
          finding.claimVerification.state !== "verified") ||
        (finding.disposition.status === "rejected" &&
          finding.claimVerification.state !== "retracted"),
    );
    if (invalidDisposition) {
      return invalid(
        schemaName,
        "accepted findings must be verified and rejected findings must be retracted",
      );
    }
    const actionable = report.findings.filter(
      (finding) =>
        finding.disposition.status === "accepted" && finding.claimVerification.state === "verified",
    );
    const blocking = actionable.filter(
      (finding) => finding.severity === "critical" || finding.severity === "major",
    );
    if (report.verdict === "ready" && blocking.length > 0) {
      return invalid(schemaName, "ready verdict cannot contain accepted blocking findings");
    }
    return {
      valid: true,
      schemaName,
      contentSchemaId: contentSchemaIdForReviewReport(schemaName),
      mediaType: "application/json",
      report,
      verdictReady: report.verdict === "ready",
      stateValue: {
        reportId: report.reportId,
        verdict: report.verdict,
        actionableFindingIds: actionable.map((finding) => finding.findingId),
        blockingFindingIds: blocking.map((finding) => finding.findingId),
        rejectedFindingIds: report.findings
          .filter((finding) => finding.disposition.status === "rejected")
          .map((finding) => finding.findingId),
      },
    };
  }

  if (schemaName === "repair-report-v1" && Value.Check(RepairReportV1, report)) {
    const ids = report.entries.map((entry) => entry.findingId);
    if (!unique(ids))
      return invalid(schemaName, "repair entries must reference unique finding IDs");
    return {
      valid: true,
      schemaName,
      contentSchemaId: contentSchemaIdForReviewReport(schemaName),
      mediaType: "application/json",
      report,
      stateValue: {
        reportId: report.reportId,
        sourceReportId: report.sourceReportId,
        appliedFindingIds: report.entries
          .filter((entry) => entry.outcome === "applied")
          .map((entry) => entry.findingId),
        skippedFindingIds: report.entries
          .filter((entry) => entry.outcome === "skipped")
          .map((entry) => entry.findingId),
        failedFindingIds: report.entries
          .filter((entry) => entry.outcome === "failed")
          .map((entry) => entry.findingId),
      },
    };
  }

  if (
    schemaName === "final-verification-report-v1" &&
    Value.Check(FinalVerificationReportV1, report)
  ) {
    const ids = report.findings.map((finding) => finding.findingId);
    const unresolved = report.findings.filter((finding) => finding.result === "unresolved");
    if (!unique(ids)) return invalid(schemaName, "verification finding IDs must be unique");
    if (report.verdict === "ready" && unresolved.length > 0) {
      return invalid(schemaName, "ready verdict cannot contain unresolved findings");
    }
    return {
      valid: true,
      schemaName,
      contentSchemaId: contentSchemaIdForReviewReport(schemaName),
      mediaType: "application/json",
      report,
      verdictReady: report.verdict === "ready",
      stateValue: {
        reportId: report.reportId,
        verdict: report.verdict,
        fixedFindingIds: report.findings
          .filter((finding) => finding.result === "fixed")
          .map((finding) => finding.findingId),
        unresolvedFindingIds: unresolved.map((finding) => finding.findingId),
      },
    };
  }

  return invalid(schemaName, "structured report schema selector did not match its payload");
}
