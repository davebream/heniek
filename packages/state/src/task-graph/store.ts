import type {
  HiddenDependencyFinding,
  RunId,
  TaskGraphRevisionDecision,
  TaskGraphRevisionProposal,
  TaskGraphRevisionRecord,
  TaskPlanningState,
} from "@heniek/contracts";
import { internalHandle, type StateDatabase } from "../database/open.js";
import { StateStoreError } from "../errors.js";
import type { JsonValue } from "../json.js";
import { stringifyCanonical } from "../json.js";

interface RecordRow {
  readonly record_json: string;
}

interface DecisionRow {
  readonly decision_json: string;
}

export interface TaskGraphRevisionValidationInput {
  readonly current: TaskGraphRevisionRecord;
  readonly taskStates: readonly TaskPlanningState[];
  readonly maxGraphRevisions: number;
  readonly decisionId: string;
  readonly decidedAt: string;
  readonly hiddenDependencyFinding?: HiddenDependencyFinding;
}

export interface TaskGraphRevisionValidationOutput {
  readonly decision: TaskGraphRevisionDecision;
  readonly record: TaskGraphRevisionRecord | null;
}

export type TaskGraphRevisionValidator = (
  context: TaskGraphRevisionValidationInput,
  proposal: TaskGraphRevisionProposal,
) => TaskGraphRevisionValidationOutput;

export interface ProposeTaskGraphRevisionInput {
  readonly proposal: TaskGraphRevisionProposal;
  readonly taskStates: readonly TaskPlanningState[];
  readonly maxGraphRevisions: number;
  readonly decisionId: string;
  readonly decidedAt: string;
  readonly hiddenDependencyFinding?: HiddenDependencyFinding;
}

export interface TaskGraphRevisionStateStore {
  initialize(record: TaskGraphRevisionRecord): TaskGraphRevisionRecord;
  active(runId: RunId): TaskGraphRevisionRecord | undefined;
  propose(input: ProposeTaskGraphRevisionInput): TaskGraphRevisionValidationOutput;
  revisions(runId: RunId): readonly TaskGraphRevisionRecord[];
  decisions(runId: RunId): readonly TaskGraphRevisionDecision[];
}

function transaction<T>(db: StateDatabase, operation: () => T): T {
  const handle = internalHandle(db);
  if (handle.isTransaction)
    throw new StateStoreError("task graph revision operations cannot be nested");
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

export function createTaskGraphRevisionStateStore(
  db: StateDatabase,
  validator: TaskGraphRevisionValidator,
): TaskGraphRevisionStateStore {
  const handle = internalHandle(db);

  function active(runId: RunId): TaskGraphRevisionRecord | undefined {
    const row = handle
      .prepare(`SELECT revision.record_json FROM task_graph_revision_projection projection
        JOIN task_graph_revision revision
          ON revision.run_id = projection.run_id
          AND revision.graph_revision = projection.active_graph_revision
        WHERE projection.run_id = ?`)
      .get(runId) as RecordRow | undefined;
    return row === undefined ? undefined : (JSON.parse(row.record_json) as TaskGraphRevisionRecord);
  }

  function insertRecord(record: TaskGraphRevisionRecord) {
    handle
      .prepare(`INSERT INTO task_graph_revision (
        run_id, graph_id, graph_revision, revision_sha256, predecessor_revision_sha256,
        decision_id, record_json, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.runId,
        record.graphId,
        record.graphRevision,
        record.revisionSha256,
        record.predecessorRevisionSha256,
        record.decisionId,
        stringifyCanonical(record as unknown as JsonValue),
        record.committedAt,
      );
  }

  return {
    active,
    initialize(record) {
      return transaction(db, () => {
        if (
          record.graphRevision !== 1 ||
          record.predecessorRevisionSha256 !== null ||
          record.decisionId !== null
        )
          throw new StateStoreError(
            "initial task graph record must be revision 1 without a predecessor or decision",
          );
        if (active(record.runId) !== undefined)
          throw new StateStoreError("task graph is already initialized for run");
        insertRecord(record);
        handle
          .prepare(`INSERT INTO task_graph_revision_projection (
            run_id, graph_id, active_graph_revision, active_revision_sha256,
            projection_revision, updated_at
          ) VALUES (?, ?, 1, ?, 1, ?)`)
          .run(record.runId, record.graphId, record.revisionSha256, record.committedAt);
        return record;
      });
    },
    propose(input) {
      return transaction(db, () => {
        const current = active(input.proposal.runId);
        if (current === undefined)
          throw new StateStoreError("task graph is not initialized for run");
        const outcome = validator(
          {
            current,
            taskStates: input.taskStates,
            maxGraphRevisions: input.maxGraphRevisions,
            decisionId: input.decisionId,
            decidedAt: input.decidedAt,
            ...(input.hiddenDependencyFinding === undefined
              ? {}
              : { hiddenDependencyFinding: input.hiddenDependencyFinding }),
          },
          input.proposal,
        );
        handle
          .prepare(`INSERT INTO task_graph_revision_decision (
            decision_id, run_id, graph_id, expected_graph_revision, proposal_sha256,
            outcome, decision_json, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            outcome.decision.decisionId,
            outcome.decision.runId,
            outcome.decision.graphId,
            outcome.decision.expectedGraphRevision,
            outcome.decision.proposalSha256,
            outcome.decision.outcome,
            stringifyCanonical(outcome.decision as unknown as JsonValue),
            outcome.decision.decidedAt,
          );
        if (outcome.record !== null) {
          insertRecord(outcome.record);
          const updated = handle
            .prepare(`UPDATE task_graph_revision_projection SET
              active_graph_revision = ?, active_revision_sha256 = ?,
              projection_revision = projection_revision + 1, updated_at = ?
              WHERE run_id = ? AND active_graph_revision = ? AND active_revision_sha256 = ?`)
            .run(
              outcome.record.graphRevision,
              outcome.record.revisionSha256,
              outcome.record.committedAt,
              outcome.record.runId,
              current.graphRevision,
              current.revisionSha256,
            );
          if (updated.changes !== 1)
            throw new StateStoreError("task graph projection compare-and-set failed");
        }
        return outcome;
      });
    },
    revisions(runId) {
      return (
        handle
          .prepare(
            "SELECT record_json FROM task_graph_revision WHERE run_id = ? ORDER BY graph_revision",
          )
          .all(runId) as unknown as RecordRow[]
      ).map((row) => JSON.parse(row.record_json) as TaskGraphRevisionRecord);
    },
    decisions(runId) {
      return (
        handle
          .prepare(`SELECT decision_json FROM task_graph_revision_decision
            WHERE run_id = ? ORDER BY recorded_at, decision_id`)
          .all(runId) as unknown as DecisionRow[]
      ).map((row) => JSON.parse(row.decision_json) as TaskGraphRevisionDecision);
    },
  };
}
