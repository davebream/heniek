import {
  FinalVerificationReportV1,
  type FindingSnapshotV1,
  RepairReportV1,
  ReviewFindingV1,
  ReviewReportV1,
  type StructuredReviewReport,
} from "@heniek/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { internalHandle, type StateDatabase } from "../database/open.js";
import { StateStoreError } from "../errors.js";

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => !Number.isNaN(Date.parse(value)));
}

export type FindingReportKind = "review" | "repair" | "final_verification";

export interface RecordFindingReportInput {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly report: StructuredReviewReport;
}

export interface RecordFindingReportResult {
  readonly inserted: boolean;
  readonly snapshots: readonly FindingSnapshotV1[];
}

export interface ListRunFindingsFilter {
  readonly stageId?: string;
  readonly severity?: "critical" | "major" | "minor";
  readonly disposition?: "accepted" | "rejected";
  readonly resolutionState?: "pending" | "fixed" | "unresolved" | "not_applicable";
}

interface StoredReportRow {
  report_id: string;
  run_id: string;
  report_kind: FindingReportKind;
  artifact_id: string;
  content_hash: string;
  report_json: string;
}

function transaction<T>(db: StateDatabase, operation: () => T): T {
  const handle = internalHandle(db);
  if (handle.isTransaction) throw new StateStoreError("finding operations cannot be nested");
  handle.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    handle.exec("COMMIT");
    return result;
  } catch (error) {
    if (handle.isTransaction) handle.exec("ROLLBACK");
    throw error;
  }
}

function reportKind(report: StructuredReviewReport): FindingReportKind {
  if ("reviewKind" in report) return "review";
  if ("entries" in report) return "repair";
  return "final_verification";
}

function assertContract(report: StructuredReviewReport): void {
  const valid =
    ("reviewKind" in report && Value.Check(ReviewReportV1, [ReviewFindingV1], report)) ||
    ("entries" in report && Value.Check(RepairReportV1, report)) ||
    ("deterministicCheckArtifactIds" in report && Value.Check(FinalVerificationReportV1, report));
  if (!valid) throw new StateStoreError("finding report does not satisfy its public contract");
}

function readSnapshot(
  db: StateDatabase,
  runId: string,
  findingId: string,
): FindingSnapshotV1 | undefined {
  const row = internalHandle(db)
    .prepare(
      `SELECT snapshot_json FROM pipeline_finding_projection
       WHERE run_id = ? AND finding_id = ?`,
    )
    .get(runId, findingId) as { snapshot_json: string } | undefined;
  return row === undefined ? undefined : (JSON.parse(row.snapshot_json) as FindingSnapshotV1);
}

function writeSnapshot(db: StateDatabase, snapshot: FindingSnapshotV1): void {
  internalHandle(db)
    .prepare(
      `INSERT INTO pipeline_finding_projection (
        run_id, finding_id, origin_report_id, origin_stage_id, severity,
        disposition, claim_verification_state, repair_state, resolution_state,
        latest_report_id, latest_report_artifact_id, latest_report_content_hash,
        evidence_json, snapshot_json, revision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, finding_id) DO UPDATE SET
        severity = excluded.severity,
        disposition = excluded.disposition,
        claim_verification_state = excluded.claim_verification_state,
        repair_state = excluded.repair_state,
        resolution_state = excluded.resolution_state,
        latest_report_id = excluded.latest_report_id,
        latest_report_artifact_id = excluded.latest_report_artifact_id,
        latest_report_content_hash = excluded.latest_report_content_hash,
        evidence_json = excluded.evidence_json,
        snapshot_json = excluded.snapshot_json,
        revision = excluded.revision,
        updated_at = excluded.updated_at`,
    )
    .run(
      snapshot.runId,
      snapshot.findingId,
      snapshot.originReportId,
      snapshot.originStageId,
      snapshot.severity,
      snapshot.disposition,
      snapshot.claimVerificationState,
      snapshot.repairState,
      snapshot.resolutionState,
      snapshot.latestReportId,
      snapshot.latestReportArtifactId,
      snapshot.latestReportContentHash,
      JSON.stringify(snapshot.evidence),
      JSON.stringify(snapshot),
      snapshot.revision,
      snapshot.updatedAt,
    );
}

function readStoredReport(db: StateDatabase, reportId: string): StoredReportRow | undefined {
  return internalHandle(db)
    .prepare(`SELECT * FROM pipeline_finding_report WHERE report_id = ?`)
    .get(reportId) as StoredReportRow | undefined;
}

function assertReportTransition(db: StateDatabase, report: StructuredReviewReport): void {
  if ("reviewKind" in report) {
    const ids = report.findings.map((finding) => finding.findingId);
    if (new Set(ids).size !== ids.length) throw new StateStoreError("duplicate finding ID");
    for (const finding of report.findings) {
      if (readSnapshot(db, report.runId, finding.findingId) !== undefined) {
        throw new StateStoreError(`finding already exists: ${finding.findingId}`);
      }
      const accepted = finding.disposition.status === "accepted";
      if (accepted !== (finding.claimVerification.state === "verified")) {
        throw new StateStoreError(
          "accepted findings must be verified; rejected findings retracted",
        );
      }
      if (
        report.verdict === "ready" &&
        accepted &&
        (finding.severity === "critical" || finding.severity === "major")
      ) {
        throw new StateStoreError("ready review cannot contain accepted blocking findings");
      }
    }
    return;
  }

  if ("entries" in report) {
    const source = readStoredReport(db, report.sourceReportId);
    if (source?.run_id !== report.runId || source.report_kind !== "review") {
      throw new StateStoreError(`repair references an unknown report: ${report.sourceReportId}`);
    }
    const ids = report.entries.map((entry) => entry.findingId);
    if (new Set(ids).size !== ids.length) throw new StateStoreError("duplicate repair finding ID");
    for (const entry of report.entries) {
      const current = readSnapshot(db, report.runId, entry.findingId);
      if (current === undefined || current.originReportId !== report.sourceReportId) {
        throw new StateStoreError(`repair references an unknown finding: ${entry.findingId}`);
      }
      if (current.disposition !== "accepted" || current.claimVerificationState !== "verified") {
        throw new StateStoreError(`repair cannot act on rejected finding: ${entry.findingId}`);
      }
      if (entry.outcome === "skipped" && current.severity !== "minor") {
        throw new StateStoreError(`blocking finding cannot be skipped: ${entry.findingId}`);
      }
    }
    const actionable = listRunFindings(db, report.runId).filter(
      (finding) =>
        finding.originReportId === report.sourceReportId &&
        finding.disposition === "accepted" &&
        finding.claimVerificationState === "verified",
    );
    if (
      actionable.length !== ids.length ||
      actionable.some((finding) => !ids.includes(finding.findingId))
    ) {
      throw new StateStoreError("repair must report an outcome for every actionable finding");
    }
    return;
  }

  const findingIds = report.findings.map((finding) => finding.findingId);
  if (new Set(findingIds).size !== findingIds.length) {
    throw new StateStoreError("duplicate verification finding ID");
  }
  for (const reportId of report.sourceReviewReportIds) {
    const source = readStoredReport(db, reportId);
    if (source?.run_id !== report.runId || source.report_kind !== "review") {
      throw new StateStoreError(`verification references an unknown review report: ${reportId}`);
    }
  }
  for (const reportId of report.sourceRepairReportIds) {
    const source = readStoredReport(db, reportId);
    if (source?.run_id !== report.runId || source.report_kind !== "repair") {
      throw new StateStoreError(`verification references an unknown repair report: ${reportId}`);
    }
    const sourceReport = JSON.parse(source.report_json) as StructuredReviewReport;
    if (
      !("entries" in sourceReport) ||
      !report.sourceReviewReportIds.includes(sourceReport.sourceReportId)
    ) {
      throw new StateStoreError(`verification repair lineage is broken: ${reportId}`);
    }
  }
  const expected = listRunFindings(db, report.runId);
  if (
    expected.length !== findingIds.length ||
    expected.some(
      (finding) =>
        !report.sourceReviewReportIds.includes(finding.originReportId) ||
        !findingIds.includes(finding.findingId),
    )
  ) {
    throw new StateStoreError("verification must cover every finding in the run");
  }
  for (const finding of report.findings) {
    const current = readSnapshot(db, report.runId, finding.findingId);
    if (current === undefined || !report.sourceReviewReportIds.includes(current.originReportId)) {
      throw new StateStoreError(`verification references an unknown finding: ${finding.findingId}`);
    }
    if (
      (current.disposition === "rejected" && finding.result !== "not_applicable") ||
      (current.disposition === "accepted" && finding.result === "not_applicable")
    ) {
      throw new StateStoreError(`illegal verification result for ${finding.findingId}`);
    }
    if (report.verdict === "ready" && finding.result === "unresolved") {
      throw new StateStoreError("ready verification cannot contain unresolved findings");
    }
  }
}

function applyReport(
  db: StateDatabase,
  report: StructuredReviewReport,
  artifactId: string,
  contentHash: string,
): readonly FindingSnapshotV1[] {
  const snapshots: FindingSnapshotV1[] = [];
  assertReportTransition(db, report);
  if ("reviewKind" in report) {
    for (const finding of report.findings) {
      const accepted = finding.disposition.status === "accepted";
      const snapshot = {
        schemaVersion: 1,
        runId: report.runId,
        findingId: finding.findingId,
        originReportId: report.reportId,
        originStageId: report.stageId,
        severity: finding.severity,
        disposition: finding.disposition.status,
        claimVerificationState: finding.claimVerification.state,
        repairState: accepted ? "pending" : "not_required",
        resolutionState: accepted ? "pending" : "not_applicable",
        latestReportId: report.reportId,
        latestReportArtifactId: artifactId,
        latestReportContentHash: contentHash,
        evidence: [...finding.evidence, ...finding.claimVerification.evidence],
        revision: 1,
        updatedAt: report.createdAt,
      } as FindingSnapshotV1;
      writeSnapshot(db, snapshot);
      snapshots.push(snapshot);
    }
    return snapshots;
  }

  if ("entries" in report) {
    for (const entry of report.entries) {
      const current = readSnapshot(db, report.runId, entry.findingId);
      if (current === undefined) throw new StateStoreError("validated repair finding disappeared");
      const snapshot = {
        ...current,
        repairState: entry.outcome,
        latestReportId: report.reportId,
        latestReportArtifactId: artifactId,
        latestReportContentHash: contentHash,
        evidence: [...current.evidence, ...entry.evidence],
        revision: current.revision + 1,
        updatedAt: report.createdAt,
      } as FindingSnapshotV1;
      writeSnapshot(db, snapshot);
      snapshots.push(snapshot);
    }
    return snapshots;
  }

  for (const finding of report.findings) {
    const current = readSnapshot(db, report.runId, finding.findingId);
    if (current === undefined)
      throw new StateStoreError("validated verification finding disappeared");
    const snapshot = {
      ...current,
      resolutionState: finding.result,
      latestReportId: report.reportId,
      latestReportArtifactId: artifactId,
      latestReportContentHash: contentHash,
      evidence: [...current.evidence, ...finding.evidence],
      revision: current.revision + 1,
      updatedAt: report.createdAt,
    } as FindingSnapshotV1;
    writeSnapshot(db, snapshot);
    snapshots.push(snapshot);
  }
  return snapshots;
}

export function recordFindingReport(
  db: StateDatabase,
  input: RecordFindingReportInput,
): RecordFindingReportResult {
  assertContract(input.report);
  return transaction(db, () => {
    const existing = readStoredReport(db, input.report.reportId);
    if (existing !== undefined) {
      if (existing.content_hash !== input.contentHash) {
        throw new StateStoreError("report ID already exists with a different content hash");
      }
      return {
        inserted: false,
        snapshots: listRunFindings(db, input.report.runId),
      };
    }
    internalHandle(db)
      .prepare(
        `INSERT INTO pipeline_finding_report (
          report_id, run_id, stage_id, report_kind, artifact_id,
          content_hash, report_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.report.reportId,
        input.report.runId,
        input.report.stageId,
        reportKind(input.report),
        input.artifactId,
        input.contentHash,
        JSON.stringify(input.report),
        input.report.createdAt,
      );
    return {
      inserted: true,
      snapshots: applyReport(db, input.report, input.artifactId, input.contentHash),
    };
  });
}

/** Validates idempotency and lifecycle lineage without publishing or mutating state. */
export function validateFindingReportIngestion(
  db: StateDatabase,
  input: RecordFindingReportInput,
): void {
  assertContract(input.report);
  const existing = readStoredReport(db, input.report.reportId);
  if (existing !== undefined) {
    if (existing.content_hash !== input.contentHash) {
      throw new StateStoreError("report ID already exists with a different content hash");
    }
    return;
  }
  assertReportTransition(db, input.report);
}

export function listRunFindings(
  db: StateDatabase,
  runId: string,
  filter: ListRunFindingsFilter = {},
): readonly FindingSnapshotV1[] {
  const clauses = ["run_id = ?"];
  const values: string[] = [runId];
  if (filter.stageId !== undefined) {
    clauses.push("origin_stage_id = ?");
    values.push(filter.stageId);
  }
  if (filter.severity !== undefined) {
    clauses.push("severity = ?");
    values.push(filter.severity);
  }
  if (filter.disposition !== undefined) {
    clauses.push("disposition = ?");
    values.push(filter.disposition);
  }
  if (filter.resolutionState !== undefined) {
    clauses.push("resolution_state = ?");
    values.push(filter.resolutionState);
  }
  const rows = internalHandle(db)
    .prepare(
      `SELECT snapshot_json FROM pipeline_finding_projection
       WHERE ${clauses.join(" AND ")}
       ORDER BY origin_stage_id, finding_id`,
    )
    .all(...values) as { snapshot_json: string }[];
  return rows.map((row) => JSON.parse(row.snapshot_json) as FindingSnapshotV1);
}

export function rebuildFindingProjection(
  db: StateDatabase,
  runId: string,
): readonly FindingSnapshotV1[] {
  return transaction(db, () => {
    const reports = internalHandle(db)
      .prepare(
        `SELECT report_json, artifact_id, content_hash FROM pipeline_finding_report
         WHERE run_id = ? ORDER BY sequence`,
      )
      .all(runId) as { report_json: string; artifact_id: string; content_hash: string }[];
    internalHandle(db)
      .prepare(`DELETE FROM pipeline_finding_projection WHERE run_id = ?`)
      .run(runId);
    for (const row of reports) {
      applyReport(
        db,
        JSON.parse(row.report_json) as StructuredReviewReport,
        row.artifact_id,
        row.content_hash,
      );
    }
    return listRunFindings(db, runId);
  });
}
