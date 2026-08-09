import { type Static, Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";
import { VerifyCheckV1 } from "../pipeline/operations.js";
import { CodebaseId, RepositoryId, WorkspaceId } from "../run/index.js";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const IsoDateTime = Type.String({ format: "date-time" });

export const WorkspaceSynchronizationStrategy = Type.Union([
  Type.Literal("notify"),
  Type.Literal("rebase-before-build"),
  Type.Literal("recreate-before-build"),
]);

const WorkspaceBase = Type.Object(
  {
    remote: Type.String({ minLength: 1 }),
    branch: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const WorkspaceSynchronization = Type.Object(
  { strategy: WorkspaceSynchronizationStrategy },
  { additionalProperties: false },
);

const WorkspaceFiles = Type.Object(
  { copy: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }) },
  { additionalProperties: false },
);

const WorkspaceLease = Type.Object(
  {
    ttlMilliseconds: Type.Integer({ minimum: 1 }),
    renewEveryMilliseconds: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const WorkspaceConfigurationV1 = versioned("WorkspaceConfiguration", 1, {
  strategy: Type.Literal("managed-worktree"),
  base: WorkspaceBase,
  synchronization: WorkspaceSynchronization,
  files: WorkspaceFiles,
  scripts: Type.Object(
    { setup: Type.Union([Type.String({ minLength: 1 }), Type.Null()]) },
    { additionalProperties: false },
  ),
  lease: WorkspaceLease,
});

/**
 * Q030 adds ordered argv verification checks. V1 stays frozen for existing
 * consumers; V2 is the deliberate addition with `scripts.verify`.
 */
export const WorkspaceConfigurationV2 = versioned("WorkspaceConfiguration", 2, {
  strategy: Type.Literal("managed-worktree"),
  base: WorkspaceBase,
  synchronization: WorkspaceSynchronization,
  files: WorkspaceFiles,
  scripts: Type.Object(
    {
      setup: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      verify: Type.Array(Type.Ref(VerifyCheckV1), { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  lease: WorkspaceLease,
});

const CleanlinessEntry = Type.Object(
  {
    status: Type.String({ minLength: 2, maxLength: 2 }),
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const Cleanliness = Type.Object(
  {
    state: Type.Union([Type.Literal("clean"), Type.Literal("dirty")]),
    entries: Type.Array(CleanlinessEntry),
    sha256: Sha256,
  },
  { additionalProperties: false },
);

const CopiedFile = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    sha256: Sha256,
    byteLength: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const SetupResult = Type.Object(
  {
    state: Type.Union([
      Type.Literal("skipped"),
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("recovery-required"),
    ]),
    commandSha256: Type.Union([Sha256, Type.Null()]),
    startedAt: Type.Union([IsoDateTime, Type.Null()]),
    finishedAt: Type.Union([IsoDateTime, Type.Null()]),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    logPath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    logSha256: Type.Union([Sha256, Type.Null()]),
  },
  { additionalProperties: false },
);

export const WorkspaceProvisioningManifestV1 = versioned("WorkspaceProvisioningManifest", 1, {
  workspaceId: WorkspaceId,
  codebaseId: CodebaseId,
  repositoryId: RepositoryId,
  configurationSha256: Sha256,
  strategy: Type.Literal("managed-worktree"),
  lifecycle: Type.Union([
    Type.Literal("provisioning"),
    Type.Literal("ready"),
    Type.Literal("failed"),
    Type.Literal("recovery-required"),
  ]),
  phase: Type.Union([
    Type.Literal("base-resolved"),
    Type.Literal("checkout-creating"),
    Type.Literal("checkout-created"),
    Type.Literal("files-copying"),
    Type.Literal("files-copied"),
    Type.Literal("setup-started"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("recovery-required"),
  ]),
  workspaceRoot: Type.String({ minLength: 1 }),
  checkoutPath: Type.String({ minLength: 1 }),
  integrationBranch: Type.String({ minLength: 1 }),
  remoteBase: Type.Object(
    {
      remote: Type.String({ minLength: 1 }),
      branch: Type.String({ minLength: 1 }),
      sha: Sha256,
      observedSha: Sha256,
      fetchedAt: IsoDateTime,
    },
    { additionalProperties: false },
  ),
  checkoutHeadSha: Type.Union([Sha256, Type.Null()]),
  cleanliness: Type.Union([Cleanliness, Type.Null()]),
  copiedFiles: Type.Array(CopiedFile),
  setup: SetupResult,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const WriterProcessWitness = Type.Object(
  {
    kind: Type.Union([Type.Literal("process"), Type.Literal("process-group")]),
    value: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const WorkspaceWriterLeaseV1 = versioned("WorkspaceWriterLease", 1, {
  workspaceId: WorkspaceId,
  repositoryId: RepositoryId,
  checkoutPath: Type.String({ minLength: 1 }),
  leaseId: Type.String({ minLength: 1 }),
  ownerId: Type.String({ minLength: 1 }),
  bootWitness: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  processWitnesses: Type.Array(WriterProcessWitness, { minItems: 1 }),
  expectedSha: Sha256,
  fencingRevision: Type.Integer({ minimum: 1 }),
  state: Type.Union([
    Type.Literal("active"),
    Type.Literal("released"),
    Type.Literal("recovery-required"),
  ]),
  acquiredAt: IsoDateTime,
  renewedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  releasedAt: Type.Union([IsoDateTime, Type.Null()]),
});

export const WorkspaceSynchronizationResultV1 = versioned("WorkspaceSynchronizationResult", 1, {
  workspaceId: WorkspaceId,
  strategy: WorkspaceSynchronizationStrategy,
  outcome: Type.Union([
    Type.Literal("up-to-date"),
    Type.Literal("notified"),
    Type.Literal("rebased"),
    Type.Literal("recreated"),
    Type.Literal("blocked"),
    Type.Literal("recovery-required"),
  ]),
  previousBaseSha: Sha256,
  observedBaseSha: Sha256,
  previousHeadSha: Sha256,
  checkoutHeadSha: Sha256,
  cleanliness: Cleanliness,
  reason: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  recordedAt: IsoDateTime,
});

export type WorkspaceConfigurationV1 = Static<typeof WorkspaceConfigurationV1>;
export type WorkspaceConfigurationV2 = Static<typeof WorkspaceConfigurationV2>;
/** @deprecated Prefer an explicit V1/V2 alias; retained as V1 for existing call sites. */
export type WorkspaceConfiguration = WorkspaceConfigurationV1;
export type WorkspaceProvisioningManifest = Static<typeof WorkspaceProvisioningManifestV1>;
export type WorkspaceWriterLease = Static<typeof WorkspaceWriterLeaseV1>;
export type WorkspaceSynchronizationResult = Static<typeof WorkspaceSynchronizationResultV1>;
