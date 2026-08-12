import type {
  SourceWorkItemId,
  TaskContext,
  TaskHierarchy,
  TaskRevision,
  TaskRevisionId,
  TaskSourceSnapshot,
  TaskSourceSynchronizationAudit,
  TaskSourceUpdateProposal,
} from "@heniek/contracts";
import { internalHandle, type StateDatabase } from "../database/open.js";
import { StateStoreError } from "../errors.js";
import type { JsonValue } from "../json.js";
import { stringifyCanonical } from "../json.js";

interface SnapshotRow {
  readonly content_sha256: string;
  readonly raw_relative_path: string;
  readonly snapshot_json: string;
}

interface RevisionRow {
  readonly revision_json: string;
  readonly superseded_by: string | null;
}

function transaction<T>(db: StateDatabase, operation: () => T): T {
  const handle = internalHandle(db);
  if (handle.isTransaction) throw new StateStoreError("task-source operations cannot be nested");
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

function renderRevision(row: RevisionRow): TaskRevision {
  const revision = JSON.parse(row.revision_json) as TaskRevision;
  return {
    ...revision,
    supersessionState: row.superseded_by === null ? "active" : "superseded",
    supersededByRevisionId: row.superseded_by as TaskRevisionId | null,
  };
}

export interface RecordTaskContextInput {
  readonly snapshot: TaskSourceSnapshot;
  readonly rawRelativePath: string;
  readonly attachmentRelativePaths: Readonly<Record<string, string>>;
  readonly revision: TaskRevision;
  readonly hierarchy: TaskHierarchy;
}

export interface RecordPendingTaskSourceUpdateInput {
  readonly snapshot: Extract<TaskSourceSnapshot, { schemaVersion: 2 }>;
  readonly rawRelativePath: string;
  readonly attachmentRelativePaths: Readonly<Record<string, string>>;
  readonly proposal: TaskSourceUpdateProposal;
}

export interface ClaimTaskSourceSynchronizationInput {
  readonly synchronizationId: string;
  readonly sourceWorkItemId: SourceWorkItemId;
  readonly sourceUri: string;
  readonly idempotencyKey: string;
  readonly proposalSha256: string;
  readonly expectedObservedVersion: string;
  readonly actor: string;
  readonly claimedAt: string;
}

export interface TaskSourceStateStore {
  findObservation(
    sourceUri: string,
    observedVersion: string,
  ):
    | {
        readonly snapshot: TaskSourceSnapshot;
        readonly rawRelativePath: string;
      }
    | undefined;
  snapshot(snapshotId: string): TaskSourceSnapshot | undefined;
  load(sourceWorkItemId: SourceWorkItemId): TaskContext | undefined;
  record(input: RecordTaskContextInput): TaskContext;
  recordPendingUpdate(input: RecordPendingTaskSourceUpdateInput): TaskContext;
  pendingUpdates(sourceWorkItemId: SourceWorkItemId): readonly TaskSourceUpdateProposal[];
  claimSynchronization(input: ClaimTaskSourceSynchronizationInput): {
    readonly claim: ClaimTaskSourceSynchronizationInput;
    readonly audit: TaskSourceSynchronizationAudit | undefined;
  };
  completeSynchronization(audit: TaskSourceSynchronizationAudit): TaskSourceSynchronizationAudit;
  synchronization(idempotencyKey: string): TaskSourceSynchronizationAudit | undefined;
  revisions(sourceWorkItemId: SourceWorkItemId): readonly TaskRevision[];
}

export function createTaskSourceStateStore(db: StateDatabase): TaskSourceStateStore {
  const handle = internalHandle(db);

  function findObservation(sourceUri: string, observedVersion: string) {
    const row = handle
      .prepare(`SELECT content_sha256, raw_relative_path, snapshot_json
        FROM task_source_snapshot WHERE source_uri = ? AND observed_version = ?`)
      .get(sourceUri, observedVersion) as SnapshotRow | undefined;
    return row === undefined
      ? undefined
      : {
          snapshot: JSON.parse(row.snapshot_json) as TaskSourceSnapshot,
          rawRelativePath: row.raw_relative_path,
        };
  }

  function hierarchy(root: SourceWorkItemId, recordedAt: string): TaskHierarchy {
    const trackerEdges = (
      handle
        .prepare(`SELECT parent_source_work_item_id, child_source_work_item_id
          FROM task_tracker_edge WHERE root_source_work_item_id = ?
          ORDER BY parent_source_work_item_id, child_source_work_item_id`)
        .all(root) as {
        parent_source_work_item_id: SourceWorkItemId;
        child_source_work_item_id: SourceWorkItemId;
      }[]
    ).map((row) => ({
      parentSourceWorkItemId: row.parent_source_work_item_id,
      childSourceWorkItemId: row.child_source_work_item_id,
    }));
    const flatMappings = handle
      .prepare(`SELECT source_work_item_id, execution_task_id
        FROM task_execution_mapping WHERE root_source_work_item_id = ?
        ORDER BY source_work_item_id, execution_task_id`)
      .all(root) as { source_work_item_id: SourceWorkItemId; execution_task_id: string }[];
    const grouped = new Map<SourceWorkItemId, string[]>();
    for (const row of flatMappings) {
      const entries = grouped.get(row.source_work_item_id) ?? [];
      entries.push(row.execution_task_id);
      grouped.set(row.source_work_item_id, entries);
    }
    return {
      schemaVersion: 1,
      rootSourceWorkItemId: root,
      trackerEdges,
      executionMappings: [...grouped.entries()].map(([sourceWorkItemId, executionTaskIds]) => ({
        sourceWorkItemId,
        executionTaskIds:
          executionTaskIds as TaskHierarchy["executionMappings"][number]["executionTaskIds"],
      })),
      recordedAt,
    };
  }

  function pendingUpdates(sourceWorkItemId: SourceWorkItemId): readonly TaskSourceUpdateProposal[] {
    return (
      handle
        .prepare(`SELECT proposal_json FROM task_source_update_proposal
          WHERE source_work_item_id = ? AND status = 'pending'
          ORDER BY created_at, proposal_id`)
        .all(sourceWorkItemId) as { proposal_json: string }[]
    ).map((row) => JSON.parse(row.proposal_json) as TaskSourceUpdateProposal);
  }

  function load(sourceWorkItemId: SourceWorkItemId): TaskContext | undefined {
    const row = handle
      .prepare(`SELECT s.snapshot_json, r.revision_json,
          successor.revision_id AS superseded_by, p.updated_at
        FROM task_revision_projection p
        JOIN task_revision r ON r.revision_id = p.active_revision_id
        JOIN task_source_snapshot s ON s.snapshot_id = r.snapshot_id
        LEFT JOIN task_revision successor ON successor.predecessor_id = r.revision_id
        WHERE p.source_work_item_id = ?`)
      .get(sourceWorkItemId) as
      | (RevisionRow & { snapshot_json: string; updated_at: string })
      | undefined;
    if (row === undefined) return undefined;
    const activeSnapshot = JSON.parse(row.snapshot_json) as TaskSourceSnapshot;
    const latestRow = handle
      .prepare(`SELECT snapshot_json FROM task_source_snapshot
        WHERE source_work_item_id = ? ORDER BY observed_at DESC, snapshot_id DESC LIMIT 1`)
      .get(sourceWorkItemId) as { snapshot_json: string } | undefined;
    const snapshot =
      latestRow === undefined
        ? activeSnapshot
        : (JSON.parse(latestRow.snapshot_json) as TaskSourceSnapshot);
    const common = {
      snapshot,
      activeRevision: renderRevision({ ...row, superseded_by: null }),
      hierarchy: hierarchy(sourceWorkItemId, row.updated_at),
    };
    return snapshot.schemaVersion === 2
      ? ({
          schemaVersion: 2,
          ...common,
          pendingUpdates: pendingUpdates(sourceWorkItemId),
        } as TaskContext)
      : ({ schemaVersion: 1, ...common } as TaskContext);
  }

  function synchronization(idempotencyKey: string): TaskSourceSynchronizationAudit | undefined {
    const row = handle
      .prepare("SELECT audit_json FROM task_source_synchronization_audit WHERE idempotency_key = ?")
      .get(idempotencyKey) as { audit_json: string } | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(row.audit_json) as TaskSourceSynchronizationAudit);
  }

  return {
    findObservation,
    snapshot(snapshotId) {
      const row = handle
        .prepare("SELECT snapshot_json FROM task_source_snapshot WHERE snapshot_id = ?")
        .get(snapshotId) as { snapshot_json: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.snapshot_json) as TaskSourceSnapshot);
    },
    load,
    pendingUpdates,
    recordPendingUpdate(input) {
      return transaction(db, () => {
        const existing = findObservation(input.snapshot.sourceUri, input.snapshot.observedVersion);
        if (existing !== undefined) {
          const context = load(input.snapshot.sourceWorkItemId);
          if (context === undefined)
            throw new StateStoreError("pending observation has no task context");
          return context;
        }
        const active = load(input.snapshot.sourceWorkItemId);
        if (active === undefined)
          throw new StateStoreError("pending update requires an active revision");
        if (input.proposal.baseSnapshotId !== active.activeRevision.sourceSnapshotId) {
          throw new StateStoreError("pending update must reference the active source snapshot");
        }
        handle
          .prepare(`INSERT INTO task_source_snapshot (
            snapshot_id, source_work_item_id, source_uri, observed_version, content_sha256,
            raw_artifact_id, raw_relative_path, snapshot_json, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            input.snapshot.snapshotId,
            input.snapshot.sourceWorkItemId,
            input.snapshot.sourceUri,
            input.snapshot.observedVersion,
            input.snapshot.contentSha256,
            input.snapshot.rawContentRef,
            input.rawRelativePath,
            stringifyCanonical(input.snapshot as unknown as JsonValue),
            input.snapshot.observedAt,
          );
        handle
          .prepare(`INSERT INTO task_source_artifact
            (snapshot_id, artifact_id, role, content_hash, relative_path)
            VALUES (?, ?, 'source', ?, ?) `)
          .run(
            input.snapshot.snapshotId,
            input.snapshot.rawContentRef,
            input.snapshot.contentSha256,
            input.rawRelativePath,
          );
        for (const attachment of input.snapshot.attachments) {
          const relativePath = input.attachmentRelativePaths[attachment.artifactId];
          if (relativePath === undefined)
            throw new StateStoreError(`missing published attachment ${attachment.artifactId}`);
          handle
            .prepare(`INSERT INTO task_source_artifact
              (snapshot_id, artifact_id, role, content_hash, relative_path)
              VALUES (?, ?, 'attachment', ?, ?) `)
            .run(
              input.snapshot.snapshotId,
              attachment.artifactId,
              attachment.contentSha256,
              relativePath,
            );
        }
        for (const component of input.snapshot.components) {
          handle
            .prepare(`INSERT INTO task_source_component_observation
              (snapshot_id, component_id, uri, observed_version, content_sha256)
              VALUES (?, ?, ?, ?, ?)`)
            .run(
              input.snapshot.snapshotId,
              component.componentId,
              component.uri,
              component.observedVersion,
              component.contentSha256,
            );
        }
        handle
          .prepare(`INSERT INTO task_source_update_proposal
            (proposal_id, source_work_item_id, base_snapshot_id, observed_snapshot_id,
             status, proposal_json, created_at, decided_at)
            VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)`)
          .run(
            input.proposal.proposalId,
            input.proposal.sourceWorkItemId,
            input.proposal.baseSnapshotId,
            input.proposal.observedSnapshotId,
            stringifyCanonical(input.proposal as unknown as JsonValue),
            input.proposal.createdAt,
          );
        const context = load(input.snapshot.sourceWorkItemId);
        if (context === undefined)
          throw new StateStoreError("pending task context could not be loaded");
        return context;
      });
    },
    claimSynchronization(input) {
      return transaction(db, () => {
        const row = handle
          .prepare(`SELECT synchronization_id, source_work_item_id, source_uri,
              idempotency_key, proposal_sha256, expected_observed_version, actor, claimed_at
            FROM task_source_synchronization_claim WHERE idempotency_key = ?`)
          .get(input.idempotencyKey) as
          | {
              synchronization_id: string;
              source_work_item_id: SourceWorkItemId;
              source_uri: string;
              idempotency_key: string;
              proposal_sha256: string;
              expected_observed_version: string;
              actor: string;
              claimed_at: string;
            }
          | undefined;
        if (row === undefined) {
          handle
            .prepare(`INSERT INTO task_source_synchronization_claim
              (synchronization_id, source_work_item_id, source_uri, idempotency_key,
               proposal_sha256, expected_observed_version, actor, claimed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
              input.synchronizationId,
              input.sourceWorkItemId,
              input.sourceUri,
              input.idempotencyKey,
              input.proposalSha256,
              input.expectedObservedVersion,
              input.actor,
              input.claimedAt,
            );
          return { claim: input, audit: undefined };
        }
        const claim: ClaimTaskSourceSynchronizationInput = {
          synchronizationId: row.synchronization_id,
          sourceWorkItemId: row.source_work_item_id,
          sourceUri: row.source_uri,
          idempotencyKey: row.idempotency_key,
          proposalSha256: row.proposal_sha256,
          expectedObservedVersion: row.expected_observed_version,
          actor: row.actor,
          claimedAt: row.claimed_at,
        };
        if (
          claim.sourceWorkItemId !== input.sourceWorkItemId ||
          claim.sourceUri !== input.sourceUri ||
          claim.proposalSha256 !== input.proposalSha256 ||
          claim.expectedObservedVersion !== input.expectedObservedVersion
        ) {
          throw new StateStoreError("idempotency key was reused for a different synchronization");
        }
        return { claim, audit: synchronization(input.idempotencyKey) };
      });
    },
    completeSynchronization(audit) {
      return transaction(db, () => {
        const existing = synchronization(audit.idempotencyKey);
        if (existing !== undefined) {
          if (
            stringifyCanonical(existing as unknown as JsonValue) !==
            stringifyCanonical(audit as unknown as JsonValue)
          )
            throw new StateStoreError("synchronization already completed with a different audit");
          return existing;
        }
        handle
          .prepare(`INSERT INTO task_source_synchronization_audit
            (synchronization_id, idempotency_key, outcome, audit_json, completed_at)
            VALUES (?, ?, ?, ?, ?)`)
          .run(
            audit.synchronizationId,
            audit.idempotencyKey,
            audit.outcome,
            stringifyCanonical(audit as unknown as JsonValue),
            audit.completedAt,
          );
        return audit;
      });
    },
    synchronization,
    record(input) {
      return transaction(db, () => {
        const previous = handle
          .prepare(`SELECT r.revision_id, r.ordinal
            FROM task_revision_projection p JOIN task_revision r
              ON r.revision_id = p.active_revision_id
            WHERE p.source_work_item_id = ?`)
          .get(input.snapshot.sourceWorkItemId) as
          | { revision_id: TaskRevisionId; ordinal: number }
          | undefined;
        if (
          (previous === undefined &&
            (input.revision.ordinal !== 1 || input.revision.predecessorRevisionId !== null)) ||
          (previous !== undefined &&
            (input.revision.ordinal !== previous.ordinal + 1 ||
              input.revision.predecessorRevisionId !== previous.revision_id))
        ) {
          throw new StateStoreError("task revision must continue the exact active predecessor");
        }

        handle
          .prepare(`INSERT INTO task_source_snapshot (
            snapshot_id, source_work_item_id, source_uri, observed_version, content_sha256,
            raw_artifact_id, raw_relative_path, snapshot_json, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            input.snapshot.snapshotId,
            input.snapshot.sourceWorkItemId,
            input.snapshot.sourceUri,
            input.snapshot.observedVersion,
            input.snapshot.contentSha256,
            input.snapshot.rawContentRef,
            input.rawRelativePath,
            stringifyCanonical(input.snapshot as unknown as JsonValue),
            input.snapshot.observedAt,
          );
        handle
          .prepare(`INSERT INTO task_revision (
            revision_id, source_work_item_id, ordinal, revision_sha256, predecessor_id,
            snapshot_id, revision_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            input.revision.revisionId,
            input.revision.sourceWorkItemId,
            input.revision.ordinal,
            input.revision.revisionSha256,
            input.revision.predecessorRevisionId,
            input.revision.sourceSnapshotId,
            stringifyCanonical(input.revision as unknown as JsonValue),
            input.revision.createdAt,
          );
        handle
          .prepare(`INSERT INTO task_source_artifact
            (snapshot_id, artifact_id, role, content_hash, relative_path)
            VALUES (?, ?, 'source', ?, ?)`)
          .run(
            input.snapshot.snapshotId,
            input.snapshot.rawContentRef,
            input.snapshot.contentSha256,
            input.rawRelativePath,
          );
        for (const attachment of input.snapshot.attachments) {
          const relativePath = input.attachmentRelativePaths[attachment.artifactId];
          if (relativePath === undefined) {
            throw new StateStoreError(`missing published attachment ${attachment.artifactId}`);
          }
          handle
            .prepare(`INSERT INTO task_source_artifact
              (snapshot_id, artifact_id, role, content_hash, relative_path)
              VALUES (?, ?, 'attachment', ?, ?)`)
            .run(
              input.snapshot.snapshotId,
              attachment.artifactId,
              attachment.contentSha256,
              relativePath,
            );
        }
        if (input.snapshot.schemaVersion === 2) {
          for (const component of input.snapshot.components) {
            handle
              .prepare(`INSERT INTO task_source_component_observation
                (snapshot_id, component_id, uri, observed_version, content_sha256)
                VALUES (?, ?, ?, ?, ?)`)
              .run(
                input.snapshot.snapshotId,
                component.componentId,
                component.uri,
                component.observedVersion,
                component.contentSha256,
              );
          }
        }
        if (previous === undefined) {
          handle
            .prepare(`INSERT INTO task_revision_projection
              (source_work_item_id, active_revision_id, revision, updated_at) VALUES (?, ?, 1, ?)`)
            .run(
              input.snapshot.sourceWorkItemId,
              input.revision.revisionId,
              input.revision.createdAt,
            );
        } else {
          handle
            .prepare(`UPDATE task_revision_projection SET
              active_revision_id = ?, revision = revision + 1, updated_at = ?
              WHERE source_work_item_id = ?`)
            .run(
              input.revision.revisionId,
              input.revision.createdAt,
              input.snapshot.sourceWorkItemId,
            );
        }
        for (const edge of input.hierarchy.trackerEdges) {
          handle
            .prepare(`INSERT OR IGNORE INTO task_tracker_edge
              (root_source_work_item_id, parent_source_work_item_id,
               child_source_work_item_id, recorded_at) VALUES (?, ?, ?, ?)`)
            .run(
              input.hierarchy.rootSourceWorkItemId,
              edge.parentSourceWorkItemId,
              edge.childSourceWorkItemId,
              input.hierarchy.recordedAt,
            );
        }
        for (const mapping of input.hierarchy.executionMappings) {
          for (const executionTaskId of mapping.executionTaskIds) {
            handle
              .prepare(`INSERT OR IGNORE INTO task_execution_mapping
                (root_source_work_item_id, source_work_item_id,
                 execution_task_id, recorded_at) VALUES (?, ?, ?, ?)`)
              .run(
                input.hierarchy.rootSourceWorkItemId,
                mapping.sourceWorkItemId,
                executionTaskId,
                input.hierarchy.recordedAt,
              );
          }
        }
        const context = load(input.snapshot.sourceWorkItemId);
        if (context === undefined)
          throw new StateStoreError("recorded task context could not be loaded");
        return context;
      });
    },
    revisions(sourceWorkItemId) {
      return (
        handle
          .prepare(`SELECT current.revision_json,
              successor.revision_id AS superseded_by
            FROM task_revision current
            LEFT JOIN task_revision successor ON successor.predecessor_id = current.revision_id
            WHERE current.source_work_item_id = ? ORDER BY current.ordinal`)
          .all(sourceWorkItemId) as unknown as RevisionRow[]
      ).map(renderRevision);
    },
  };
}
