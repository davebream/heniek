import type {
  CodebaseId,
  RepositoryId,
  WorkspaceId,
  WorkspaceProvisioningManifest,
  WorkspaceWriterLease,
} from "@heniek/contracts";
import {
  type CodebaseRow,
  commitStateChange,
  type JsonValue,
  type RepositoryRow,
  readIdentity,
  readWorkspaceLease,
  type StateDatabase,
} from "@heniek/state";

export interface WorkspaceStateStore {
  codebase(id: CodebaseId): CodebaseRow | undefined;
  repository(id: RepositoryId): RepositoryRow | undefined;
  manifest(id: WorkspaceId): WorkspaceProvisioningManifest | undefined;
  ensureWorkspace(id: WorkspaceId, codebaseId: CodebaseId): void;
  recordManifest(manifest: WorkspaceProvisioningManifest): void;
  lease(checkoutPath: string): WorkspaceWriterLease | undefined;
  recordLease(
    eventType:
      | "workspace.lease_acquired"
      | "workspace.lease_recovered"
      | "workspace.lease_renewed"
      | "workspace.lease_expected_sha_advanced"
      | "workspace.lease_released"
      | "workspace.lease_recovery_required",
    lease: WorkspaceWriterLease,
  ): void;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function parseManifest(value: string | null): WorkspaceProvisioningManifest | undefined {
  if (value === null) return undefined;
  return JSON.parse(value) as WorkspaceProvisioningManifest;
}

function leaseFromRow(
  row: NonNullable<ReturnType<typeof readWorkspaceLease>>,
): WorkspaceWriterLease {
  return {
    schemaVersion: 1,
    workspaceId: row.workspaceId as WorkspaceId,
    repositoryId: row.repositoryId as RepositoryId,
    checkoutPath: row.checkoutPath,
    leaseId: row.leaseId,
    ownerId: row.ownerId,
    bootWitness: row.bootWitness,
    processWitnesses: JSON.parse(
      row.processWitnessesJson,
    ) as WorkspaceWriterLease["processWitnesses"],
    expectedSha: row.expectedSha,
    fencingRevision: row.fencingRevision,
    state: row.leaseState as WorkspaceWriterLease["state"],
    acquiredAt: row.acquiredAt,
    renewedAt: row.renewedAt,
    expiresAt: row.expiresAt,
    releasedAt: row.releasedAt,
  };
}

export function createWorkspaceStateStore(db: StateDatabase): WorkspaceStateStore {
  return {
    codebase(id) {
      return readIdentity(db, "codebase", id);
    },
    repository(id) {
      return readIdentity(db, "repository", id);
    },
    manifest(id) {
      return parseManifest(readIdentity(db, "workspace", id)?.manifestJson ?? null);
    },
    ensureWorkspace(id, codebaseId) {
      const existing = readIdentity(db, "workspace", id);
      if (existing !== undefined) {
        if (existing.codebaseId !== codebaseId) {
          throw new Error(`workspace ${id} belongs to a different codebase`);
        }
        return;
      }
      commitStateChange(db, {
        type: "workspace.registered",
        payload: jsonValue({ workspaceId: id, codebaseId }),
      });
    },
    recordManifest(manifest) {
      commitStateChange(db, {
        type: "workspace.provisioning_recorded",
        payload: jsonValue({
          workspaceId: manifest.workspaceId,
          codebaseId: manifest.codebaseId,
          repositoryId: manifest.repositoryId,
          lifecycleStatus: manifest.lifecycle,
          checkoutPath: manifest.checkoutPath,
          configurationSha256: manifest.configurationSha256,
          manifestJson: JSON.stringify(manifest),
        }),
      });
    },
    lease(checkoutPath) {
      const row = readWorkspaceLease(db, checkoutPath);
      return row === undefined ? undefined : leaseFromRow(row);
    },
    recordLease(eventType, lease) {
      commitStateChange(db, {
        type: eventType,
        payload: jsonValue({
          ...lease,
          processWitnessesJson: JSON.stringify(lease.processWitnesses),
          leaseState: lease.state,
        }),
      });
    },
  };
}
