import type {
  CodebaseId,
  RepositoryId,
  WorkspaceConfiguration,
  WorkspaceId,
  WorkspaceProvisioningManifest,
  WorkspaceSynchronizationResult,
  WorkspaceWriterLease,
} from "@heniek/contracts";

export interface ProcessWitness {
  readonly kind: "process" | "process-group";
  readonly value: number;
}

export interface LeaseOwner {
  readonly ownerId: string;
  readonly bootWitness: string | null;
  readonly processWitnesses: readonly ProcessWitness[];
}

export interface ProvisionWorkspaceInput {
  readonly workspaceId: WorkspaceId;
  readonly codebaseId: CodebaseId;
  readonly repositoryId: RepositoryId;
  readonly integrationBranch: string;
  /** Optional immutable base for fallback attempts; legacy callers resolve the configured remote branch. */
  readonly baseSha?: string;
  readonly owner: LeaseOwner;
  readonly configuration: WorkspaceConfiguration;
}

export interface SynchronizeWorkspaceInput {
  readonly workspaceId: WorkspaceId;
  readonly owner: LeaseOwner;
  readonly configuration: WorkspaceConfiguration;
}

export interface RecoverWorkspaceInput {
  readonly workspaceId: WorkspaceId;
  readonly owner: LeaseOwner;
  readonly decision: "retry-setup" | "fail-workspace";
  readonly configuration: WorkspaceConfiguration;
}

export interface AcquireWriterLeaseInput extends LeaseOwner {
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId;
  readonly checkoutPath: string;
  readonly expectedSha: string;
  readonly ttlMilliseconds: number;
}

export interface LeaseHandle {
  readonly lease: WorkspaceWriterLease;
}

export interface OwnerLiveness {
  currentBootWitness(): string | null;
  witnessState(bootWitness: string | null, witness: ProcessWitness): "alive" | "dead" | "unknown";
}

export interface WorkspaceService {
  readonly leases: WorkspaceLeaseService;
  provision(input: ProvisionWorkspaceInput): Promise<WorkspaceProvisioningManifest>;
  synchronize(input: SynchronizeWorkspaceInput): Promise<WorkspaceSynchronizationResult>;
  recover(input: RecoverWorkspaceInput): Promise<WorkspaceProvisioningManifest>;
}

export interface WorkspaceLeaseService {
  current(checkoutPath: string): WorkspaceWriterLease | undefined;
  acquire(input: AcquireWriterLeaseInput): WorkspaceWriterLease;
  renew(
    lease: WorkspaceWriterLease,
    ttlMilliseconds: number,
    owner?: LeaseOwner,
  ): WorkspaceWriterLease;
  assertCurrent(lease: WorkspaceWriterLease, actualSha: string): void;
  advanceExpectedSha(lease: WorkspaceWriterLease, nextSha: string): WorkspaceWriterLease;
  release(lease: WorkspaceWriterLease): WorkspaceWriterLease;
  markRecoveryRequired(lease: WorkspaceWriterLease): WorkspaceWriterLease;
}
