import { internalHandle, type StateDatabase } from "../database/open.js";
import { toNullableText, toSafeInteger, toText } from "../database/pragma.js";

export interface WorkspaceLeaseRow {
  readonly checkoutPath: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly bootWitness: string | null;
  readonly processWitnessesJson: string;
  readonly expectedSha: string;
  readonly fencingRevision: number;
  readonly leaseState: string;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  readonly revision: number;
  readonly lastEventSequence: number;
  readonly updatedAt: string;
}

export const WORKSPACE_LEASE_COLUMNS =
  "checkout_path, workspace_id, repository_id, lease_id, owner_id, boot_witness," +
  " process_witnesses_json, expected_sha, fencing_revision, lease_state, acquired_at, renewed_at," +
  " expires_at, released_at, revision, last_event_sequence, updated_at";

export function toWorkspaceLeaseRow(raw: Record<string, unknown>): WorkspaceLeaseRow {
  return {
    checkoutPath: toText(raw.checkout_path, "workspace_lease.checkout_path"),
    workspaceId: toText(raw.workspace_id, "workspace_lease.workspace_id"),
    repositoryId: toText(raw.repository_id, "workspace_lease.repository_id"),
    leaseId: toText(raw.lease_id, "workspace_lease.lease_id"),
    ownerId: toText(raw.owner_id, "workspace_lease.owner_id"),
    bootWitness: toNullableText(raw.boot_witness, "workspace_lease.boot_witness"),
    processWitnessesJson: toText(
      raw.process_witnesses_json,
      "workspace_lease.process_witnesses_json",
    ),
    expectedSha: toText(raw.expected_sha, "workspace_lease.expected_sha"),
    fencingRevision: toSafeInteger(raw.fencing_revision, "workspace_lease.fencing_revision"),
    leaseState: toText(raw.lease_state, "workspace_lease.lease_state"),
    acquiredAt: toText(raw.acquired_at, "workspace_lease.acquired_at"),
    renewedAt: toText(raw.renewed_at, "workspace_lease.renewed_at"),
    expiresAt: toText(raw.expires_at, "workspace_lease.expires_at"),
    releasedAt: toNullableText(raw.released_at, "workspace_lease.released_at"),
    revision: toSafeInteger(raw.revision, "workspace_lease.revision"),
    lastEventSequence: toSafeInteger(
      raw.last_event_sequence,
      "workspace_lease.last_event_sequence",
    ),
    updatedAt: toText(raw.updated_at, "workspace_lease.updated_at"),
  };
}

export function readWorkspaceLease(
  db: StateDatabase,
  checkoutPath: string,
): WorkspaceLeaseRow | undefined {
  const raw = internalHandle(db)
    .prepare(`SELECT ${WORKSPACE_LEASE_COLUMNS} FROM workspace_lease WHERE checkout_path = ?`)
    .get(checkoutPath);
  return raw === undefined ? undefined : toWorkspaceLeaseRow(raw);
}
