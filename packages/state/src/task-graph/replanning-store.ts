import type {
  HiddenDependencyFinding,
  HiddenDependencyReplan,
  HiddenDependencyReplanBlocker,
  HiddenDependencyReplanLifecycle,
  RunId,
  TaskGraphRevisionProposal,
} from "@heniek/contracts";
import { internalClock, internalHandle, type StateDatabase } from "../database/open.js";
import { StateStoreError } from "../errors.js";
import type { JsonValue } from "../json.js";
import { stringifyCanonical } from "../json.js";

type HiddenDependencyProposal = Extract<TaskGraphRevisionProposal, { schemaVersion: 2 }>;

interface JsonRow {
  readonly json: string;
}

interface ReplanRow {
  readonly proposal_json: string;
  readonly replan_json: string;
}

export interface RecordHiddenDependencyReplanInput {
  readonly replanId: string;
  readonly finding: HiddenDependencyFinding;
  readonly proposal: HiddenDependencyProposal;
  readonly replacementTaskIds: readonly string[];
}

export interface AdvanceHiddenDependencyReplanInput {
  readonly replanId: string;
  readonly expectedLifecycle: HiddenDependencyReplanLifecycle;
  readonly lifecycle: HiddenDependencyReplanLifecycle;
  readonly decisionId?: string | null;
  readonly resultingGraphRevision?: number | null;
  readonly blocker?: HiddenDependencyReplanBlocker | null;
}

export interface HiddenDependencyReplanStateStore {
  record(input: RecordHiddenDependencyReplanInput): HiddenDependencyReplan;
  advance(input: AdvanceHiddenDependencyReplanInput): HiddenDependencyReplan;
  active(runId: RunId): HiddenDependencyReplan | undefined;
  replans(runId: RunId): readonly HiddenDependencyReplan[];
  findings(runId: RunId): readonly HiddenDependencyFinding[];
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function transaction<T>(db: StateDatabase, operation: () => T): T {
  const handle = internalHandle(db);
  if (handle.isTransaction)
    throw new StateStoreError("hidden dependency operations cannot be nested");
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

function canAdvance(
  from: HiddenDependencyReplanLifecycle,
  to: HiddenDependencyReplanLifecycle,
): boolean {
  return (
    (from === "quiescing" && (to === "revising" || to === "blocked")) ||
    (from === "revising" && (to === "resumed" || to === "blocked"))
  );
}

export function createHiddenDependencyReplanStateStore(
  db: StateDatabase,
): HiddenDependencyReplanStateStore {
  const handle = internalHandle(db);
  const read = (replanId: string): HiddenDependencyReplan => {
    const row = handle
      .prepare("SELECT replan_json AS json FROM hidden_dependency_replan WHERE replan_id = ?")
      .get(replanId) as JsonRow | undefined;
    if (row === undefined)
      throw new StateStoreError(`unknown hidden dependency replan ${replanId}`);
    return parse<HiddenDependencyReplan>(row.json);
  };

  return {
    record(input) {
      return transaction(db, () => {
        if (input.proposal.trigger.findingId !== input.finding.findingId)
          throw new StateStoreError("hidden dependency proposal cites a different finding");
        if (
          input.proposal.runId !== input.finding.runId ||
          input.proposal.graphId !== input.finding.graphId ||
          input.proposal.expectedGraphRevision !== input.finding.graphRevision ||
          input.proposal.expectedRevisionSha256 !== input.finding.revisionSha256
        )
          throw new StateStoreError(
            "hidden dependency proposal does not cite the finding baseline",
          );
        const findingJson = stringifyCanonical(input.finding as unknown as JsonValue);
        const existingFinding = handle
          .prepare(
            "SELECT finding_json AS json FROM hidden_dependency_finding WHERE finding_id = ?",
          )
          .get(input.finding.findingId) as JsonRow | undefined;
        if (existingFinding !== undefined && existingFinding.json !== findingJson)
          throw new StateStoreError(
            "hidden dependency finding replay does not match persisted evidence",
          );
        if (existingFinding === undefined) {
          handle
            .prepare(`INSERT INTO hidden_dependency_finding
              (finding_id, run_id, graph_id, graph_revision, revision_sha256,
               reporter_task_id, finding_json, discovered_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
              input.finding.findingId,
              input.finding.runId,
              input.finding.graphId,
              input.finding.graphRevision,
              input.finding.revisionSha256,
              input.finding.reporterTaskId,
              findingJson,
              input.finding.discoveredAt,
            );
        }
        const existing = handle
          .prepare(`SELECT proposal_json, replan_json FROM hidden_dependency_replan
            WHERE finding_id = ?`)
          .get(input.finding.findingId) as ReplanRow | undefined;
        const replan = {
          schemaVersion: 1,
          replanId: input.replanId,
          finding: input.finding,
          proposal: input.proposal,
          lifecycle: "quiescing",
          interruptedTaskIds: [...input.proposal.trigger.interruptedTaskIds].sort(),
          replacementTaskIds: [...input.replacementTaskIds].sort(),
          decisionId: null,
          resultingGraphRevision: null,
          blocker: null,
          revision: 1,
          createdAt: input.finding.discoveredAt,
          updatedAt: input.finding.discoveredAt,
        } as HiddenDependencyReplan;
        const proposalJson = stringifyCanonical(input.proposal as unknown as JsonValue);
        const replanJson = stringifyCanonical(replan as unknown as JsonValue);
        if (existing !== undefined) {
          const persisted = parse<HiddenDependencyReplan>(existing.replan_json);
          if (
            existing.proposal_json !== proposalJson ||
            persisted.replanId !== input.replanId ||
            JSON.stringify(persisted.replacementTaskIds) !==
              JSON.stringify(replan.replacementTaskIds) ||
            JSON.stringify(persisted.interruptedTaskIds) !==
              JSON.stringify(replan.interruptedTaskIds)
          )
            throw new StateStoreError(
              "hidden dependency replan replay does not match persisted state",
            );
          return persisted;
        }
        handle
          .prepare(`INSERT INTO hidden_dependency_replan
            (replan_id, finding_id, run_id, lifecycle, proposal_json, replan_json,
             revision, created_at, updated_at) VALUES (?, ?, ?, 'quiescing', ?, ?, 1, ?, ?)`)
          .run(
            replan.replanId,
            replan.finding.findingId,
            replan.finding.runId,
            proposalJson,
            replanJson,
            replan.createdAt,
            replan.updatedAt,
          );
        return replan;
      });
    },

    advance(input) {
      return transaction(db, () => {
        const current = read(input.replanId);
        if (current.lifecycle !== input.expectedLifecycle) {
          if (current.lifecycle === input.lifecycle) return current;
          throw new StateStoreError(
            `invalid hidden dependency transition ${current.lifecycle} -> ${input.lifecycle}`,
          );
        }
        if (!canAdvance(current.lifecycle, input.lifecycle))
          throw new StateStoreError(
            `invalid hidden dependency transition ${current.lifecycle} -> ${input.lifecycle}`,
          );
        const next = {
          ...current,
          lifecycle: input.lifecycle,
          decisionId: input.decisionId === undefined ? current.decisionId : input.decisionId,
          resultingGraphRevision:
            input.resultingGraphRevision === undefined
              ? current.resultingGraphRevision
              : input.resultingGraphRevision,
          blocker: input.blocker === undefined ? current.blocker : input.blocker,
          revision: current.revision + 1,
          updatedAt: internalClock(db).nowIso(),
        } as HiddenDependencyReplan;
        const updated = handle
          .prepare(`UPDATE hidden_dependency_replan SET lifecycle = ?, replan_json = ?,
            revision = ?, updated_at = ? WHERE replan_id = ? AND lifecycle = ?`)
          .run(
            next.lifecycle,
            stringifyCanonical(next as unknown as JsonValue),
            next.revision,
            next.updatedAt,
            next.replanId,
            input.expectedLifecycle,
          );
        if (updated.changes !== 1)
          throw new StateStoreError("hidden dependency compare-and-set failed");
        return next;
      });
    },

    active(runId) {
      const row = handle
        .prepare(`SELECT replan_json AS json FROM hidden_dependency_replan
          WHERE run_id = ? AND lifecycle IN ('quiescing','revising')`)
        .get(runId) as JsonRow | undefined;
      return row === undefined ? undefined : parse<HiddenDependencyReplan>(row.json);
    },

    replans(runId) {
      return (
        handle
          .prepare(`SELECT replan_json AS json FROM hidden_dependency_replan
            WHERE run_id = ? ORDER BY created_at, replan_id`)
          .all(runId) as unknown as JsonRow[]
      ).map((row) => parse<HiddenDependencyReplan>(row.json));
    },

    findings(runId) {
      return (
        handle
          .prepare(`SELECT finding_json AS json FROM hidden_dependency_finding
            WHERE run_id = ? ORDER BY discovered_at, finding_id`)
          .all(runId) as unknown as JsonRow[]
      ).map((row) => parse<HiddenDependencyFinding>(row.json));
    },
  };
}
