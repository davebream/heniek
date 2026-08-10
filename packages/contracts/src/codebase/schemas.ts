import { type Static, Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";
import { VerifyCheckV1 } from "../pipeline/operations.js";
import { CodebaseId, RepositoryId } from "../run/ids.js";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const GitCommitSha = Type.String({ pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" });
const IsoDateTime = Type.String({ format: "date-time" });
const SafeRelativePath = Type.String({
  minLength: 1,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
});

export const InstructionSourceLocation = Type.Object(
  {
    kind: Type.Union([Type.Literal("repository"), Type.Literal("application-home")]),
    repositoryId: Type.Union([RepositoryId, Type.Null()]),
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const InstructionAnchor = Type.Object(
  {
    sourceId: Type.String({ minLength: 1 }),
    startLine: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const InstructionSource = Type.Object(
  {
    sourceId: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal("shared"),
      Type.Literal("provider-native"),
      Type.Literal("orchestrator"),
      Type.Literal("profile-role"),
      Type.Literal("stage"),
    ]),
    provider: Type.Union([
      Type.Literal("claude"),
      Type.Literal("codex"),
      Type.Literal("cursor"),
      Type.Null(),
    ]),
    location: InstructionSourceLocation,
    scope: Type.String(),
    precedence: Type.Integer({ minimum: 1, maximum: 5 }),
    contentSha256: Sha256,
  },
  { additionalProperties: false },
);

const instructionDiagnosticFields = {
  code: Type.String({ minLength: 1 }),
  classification: Type.Union([
    Type.Literal("additive"),
    Type.Literal("incompatible"),
    Type.Literal("indeterminate"),
  ]),
  message: Type.String({ minLength: 1 }),
  topic: Type.String({ minLength: 1 }),
  anchors: Type.Array(InstructionAnchor, { minItems: 2 }),
} as const;

export const InstructionDiagnosticSchema = Type.Object(
  { schemaVersion: Type.Literal(1), ...instructionDiagnosticFields },
  { additionalProperties: false },
);

export const InstructionDiagnosticV1 = versioned(
  "InstructionDiagnostic",
  1,
  instructionDiagnosticFields,
);

const instructionSnapshotFields = {
  snapshotSha256: Sha256,
  capturedAt: Type.String({ format: "date-time" }),
  readiness: Type.Union([Type.Literal("ready"), Type.Literal("blocked")]),
  sources: Type.Array(InstructionSource),
  diagnostics: Type.Array(InstructionDiagnosticSchema),
} as const;

export const InstructionSnapshotSchema = Type.Object(
  { schemaVersion: Type.Literal(1), ...instructionSnapshotFields },
  { additionalProperties: false },
);

export const InstructionSnapshotV1 = versioned("InstructionSnapshot", 1, instructionSnapshotFields);

/** Provider-filtered instruction provenance used by composite workspaces. */
export const EffectiveInstructionReportV1 = versioned("EffectiveInstructionReport", 1, {
  provider: Type.Union([Type.Literal("claude"), Type.Literal("codex"), Type.Literal("cursor")]),
  generatedAt: IsoDateTime,
  readiness: Type.Union([Type.Literal("ready"), Type.Literal("blocked")]),
  reportSha256: Sha256,
  effectiveContentSha256: Sha256,
  sources: Type.Array(InstructionSource),
  unresolvedConflicts: Type.Array(InstructionDiagnosticSchema),
});

export const NormalizedRemote = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    fetchUrl: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    pushUrl: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    defaultBranch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const DetectedRepository = Type.Object(
  {
    repositoryId: Type.Union([RepositoryId, Type.Null()]),
    name: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    gitCommonDirectory: Type.String({ minLength: 1 }),
    remotes: Type.Array(NormalizedRemote),
    defaultRemote: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    defaultBranch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const CodebaseDiagnostic = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("blocker")]),
    message: Type.String({ minLength: 1 }),
    repositoryPath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const CodebaseDetectionResultV1 = versioned("CodebaseDetectionResult", 1, {
  registrationState: Type.Union([
    Type.Literal("unregistered"),
    Type.Literal("registered"),
    Type.Literal("ambiguous"),
  ]),
  codebaseId: Type.Union([CodebaseId, Type.Null()]),
  name: Type.String({ minLength: 1 }),
  rootPath: Type.String({ minLength: 1 }),
  sourceRepositoryPath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  topologySha256: Sha256,
  repositories: Type.Array(DetectedRepository, { minItems: 1 }),
  instructionSnapshot: InstructionSnapshotSchema,
  diagnostics: Type.Array(CodebaseDiagnostic),
});

export const RegisteredCodebaseV1 = versioned("RegisteredCodebase", 1, {
  codebaseId: CodebaseId,
  name: Type.String({ minLength: 1 }),
  rootPath: Type.String({ minLength: 1 }),
  sourceRepositoryPath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  topologySha256: Sha256,
  repositories: Type.Array(DetectedRepository, { minItems: 1 }),
  instructionSnapshot: InstructionSnapshotSchema,
  diagnostics: Type.Array(CodebaseDiagnostic),
  readiness: Type.Union([Type.Literal("ready"), Type.Literal("blocked")]),
  registeredAt: Type.String({ format: "date-time" }),
  configurationSha256: Sha256,
});

const SynchronizationPolicy = Type.Union([
  Type.Literal("notify"),
  Type.Literal("pinned"),
  Type.Literal("rebase-before-build"),
  Type.Literal("merge-before-build"),
  Type.Literal("custom"),
]);

/** Per-repository provisioning settings. Q034 validates every variant but only resolves managed pins. */
export const RepositoryProvisioningConfiguration = Type.Union([
  Type.Object(
    {
      strategy: Type.Literal("managed-worktree"),
      remote: Type.String({ minLength: 1 }),
      requestedRef: Type.String({ minLength: 1 }),
      synchronization: SynchronizationPolicy,
    },
    { additionalProperties: false },
  ),
  Type.Object({ strategy: Type.Literal("current-checkout") }, { additionalProperties: false }),
  Type.Object(
    {
      strategy: Type.Literal("existing-checkout"),
      checkoutPath: Type.String({ minLength: 1, pattern: "^/" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      strategy: Type.Literal("custom"),
      command: Type.String({ minLength: 1, maxLength: 65536 }),
    },
    { additionalProperties: false },
  ),
]);

/** Standalone versioned form for consumers that exchange one provisioning configuration. */
export const RepositoryProvisioningConfigurationV1 = versioned(
  "RepositoryProvisioningConfiguration",
  1,
  { configuration: RepositoryProvisioningConfiguration },
);

const RepositoryConfiguration = Type.Object(
  {
    expectedPath: Type.String({ minLength: 1 }),
    provisioning: RepositoryProvisioningConfiguration,
    setup: Type.Union([Type.String({ minLength: 1, maxLength: 65536 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const RepositorySetupPolicy = Type.Object(
  {
    command: Type.Union([Type.String({ minLength: 1, maxLength: 65536 }), Type.Null()]),
    dependsOn: Type.Array(RepositoryId, { uniqueItems: true }),
    timeoutMilliseconds: Type.Integer({ minimum: 1000, maximum: 86400000 }),
  },
  { additionalProperties: false },
);

const RepositoryConfigurationV2 = Type.Object(
  {
    expectedPath: Type.String({ minLength: 1 }),
    provisioning: RepositoryProvisioningConfiguration,
    setup: RepositorySetupPolicy,
  },
  { additionalProperties: false },
);

/** Authored multi-root configuration. Repository IDs are map keys for stable layered merging. */
export const CodebaseConfigurationV1 = versioned("CodebaseConfiguration", 1, {
  codebaseId: CodebaseId,
  repositories: Type.Record(Type.String({ minLength: 1 }), RepositoryConfiguration),
});

/** Q035 structured setup policy. V1 remains frozen and is normalized at runtime. */
export const CodebaseConfigurationV2 = versioned("CodebaseConfiguration", 2, {
  codebaseId: CodebaseId,
  repositories: Type.Record(Type.String({ minLength: 1 }), RepositoryConfigurationV2),
});

export const RepositoryBasePinV1 = versioned("RepositoryBasePin", 1, {
  repositoryId: RepositoryId,
  requestedRef: Type.String({ minLength: 1 }),
  resolvedRef: Type.String({ minLength: 1 }),
  remote: Type.String({ minLength: 1 }),
  fetchedRemoteIdentity: Type.String({ minLength: 1 }),
  commitSha: GitCommitSha,
  resolvedAt: IsoDateTime,
  synchronization: SynchronizationPolicy,
});

const ConfigurationProvenance = Type.Object(
  {
    layer: Type.String({ minLength: 1 }),
    sourcePath: Type.String({ minLength: 1 }),
    pointer: Type.String(),
  },
  { additionalProperties: false },
);

const ResolvedRepositoryConfiguration = Type.Object(
  {
    repositoryId: RepositoryId,
    name: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    provisioning: RepositoryProvisioningConfiguration,
    setup: Type.Union([Type.String({ minLength: 1, maxLength: 65536 }), Type.Null()]),
    provenance: Type.Array(ConfigurationProvenance),
  },
  { additionalProperties: false },
);

const ResolvedRepositoryConfigurationV2 = Type.Object(
  {
    repositoryId: RepositoryId,
    name: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    provisioning: RepositoryProvisioningConfiguration,
    setup: RepositorySetupPolicy,
    provenance: Type.Array(ConfigurationProvenance),
  },
  { additionalProperties: false },
);

export const ResolvedCodebaseSnapshotV1 = versioned("ResolvedCodebaseSnapshot", 1, {
  codebaseId: CodebaseId,
  registrationSha256: Sha256,
  configurationSha256: Sha256,
  resolvedAt: IsoDateTime,
  repositories: Type.Array(ResolvedRepositoryConfiguration, { minItems: 1 }),
  basePins: Type.Array(Type.Ref(RepositoryBasePinV1)),
});

export const ResolvedCodebaseSnapshotV2 = versioned("ResolvedCodebaseSnapshot", 2, {
  codebaseId: CodebaseId,
  registrationSha256: Sha256,
  configurationSha256: Sha256,
  resolvedAt: IsoDateTime,
  repositories: Type.Array(ResolvedRepositoryConfigurationV2, { minItems: 1 }),
  basePins: Type.Array(Type.Ref(RepositoryBasePinV1)),
});

export const CodebaseDetectRequestV1 = versioned("CodebaseDetectRequest", 1, {
  roots: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  sourceRepositoryPath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
});

export const CodebaseRegisterRequestV1 = versioned("CodebaseRegisterRequest", 1, {
  roots: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  sourceRepositoryPath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  expectedTopologySha256: Sha256,
  confirmed: Type.Literal(true),
});

const OnboardingEvidence = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("instruction"),
      Type.Literal("manifest"),
      Type.Literal("lockfile"),
      Type.Literal("ci"),
      Type.Literal("other"),
    ]),
    path: SafeRelativePath,
    detail: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { additionalProperties: false },
);

const RepositoryOnboardingProposal = Type.Object(
  {
    repositoryId: RepositoryId,
    files: Type.Object(
      { copy: Type.Array(SafeRelativePath, { uniqueItems: true }) },
      { additionalProperties: false },
    ),
    scripts: Type.Object(
      {
        setup: Type.Union([Type.String({ minLength: 1, maxLength: 65536 }), Type.Null()]),
        verify: Type.Array(Type.Ref(VerifyCheckV1), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    rationale: Type.String({ minLength: 1, maxLength: 8192 }),
    evidence: Type.Array(OnboardingEvidence, { minItems: 1 }),
  },
  { additionalProperties: false },
);

/** Reviewed per-repository workspace policy stored under application home. */
export const RepositoryWorkspacePolicyV1 = versioned("RepositoryWorkspacePolicy", 1, {
  codebaseId: CodebaseId,
  repositoryId: RepositoryId,
  topologySha256: Sha256,
  configurationBasisSha256: Sha256,
  files: Type.Object(
    { copy: Type.Array(SafeRelativePath, { uniqueItems: true }) },
    { additionalProperties: false },
  ),
  scripts: Type.Object(
    {
      setup: Type.Union([Type.String({ minLength: 1, maxLength: 65536 }), Type.Null()]),
      verify: Type.Array(Type.Ref(VerifyCheckV1), { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  proposalId: Type.String({ minLength: 1, maxLength: 128 }),
  proposalDigest: Sha256,
  appliedAt: IsoDateTime,
});

/** Agent-produced onboarding proposal awaiting explicit apply. */
export const CodebaseOnboardingProposalV1 = versioned("CodebaseOnboardingProposal", 1, {
  proposalId: Type.String({ minLength: 1, maxLength: 128 }),
  codebaseId: CodebaseId,
  profileId: Type.String({ minLength: 1, maxLength: 128 }),
  topologySha256: Sha256,
  configurationBasisSha256: Sha256,
  repositories: Type.Array(RepositoryOnboardingProposal, { minItems: 1 }),
  digest: Sha256,
  createdAt: IsoDateTime,
  repairAttempt: Type.Integer({ minimum: 0, maximum: 1 }),
});

export const CodebaseOnboardProposeRequestV1 = versioned("CodebaseOnboardProposeRequest", 1, {
  codebaseId: CodebaseId,
  profileId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
});

export const CodebaseOnboardProposeResultV1 = versioned("CodebaseOnboardProposeResult", 1, {
  proposal: Type.Ref(CodebaseOnboardingProposalV1),
  repaired: Type.Boolean(),
});

export const CodebaseOnboardApplyRequestV1 = versioned("CodebaseOnboardApplyRequest", 1, {
  proposalId: Type.String({ minLength: 1, maxLength: 128 }),
  expectedSha256: Sha256,
});

export const CodebaseOnboardApplyResultV1 = versioned("CodebaseOnboardApplyResult", 1, {
  proposalId: Type.String({ minLength: 1, maxLength: 128 }),
  proposalDigest: Sha256,
  codebaseId: CodebaseId,
  policies: Type.Array(Type.Ref(RepositoryWorkspacePolicyV1), { minItems: 1 }),
  appliedAt: IsoDateTime,
});

export type CodebaseDetectionResult = Static<typeof CodebaseDetectionResultV1>;
export type RegisteredCodebase = Static<typeof RegisteredCodebaseV1>;
export type CodebaseConfiguration = Static<typeof CodebaseConfigurationV1>;
export type CodebaseConfigurationV2 = Static<typeof CodebaseConfigurationV2>;
export type RepositoryProvisioningConfiguration = Static<
  typeof RepositoryProvisioningConfiguration
>;
export type RepositoryBasePin = Static<typeof RepositoryBasePinV1>;
export type ResolvedCodebaseSnapshot = Static<typeof ResolvedCodebaseSnapshotV1>;
export type ResolvedCodebaseSnapshotV2 = Static<typeof ResolvedCodebaseSnapshotV2>;
export type InstructionSnapshot = Static<typeof InstructionSnapshotV1>;
export type InstructionDiagnostic = Static<typeof InstructionDiagnosticV1>;
export type EffectiveInstructionReport = Static<typeof EffectiveInstructionReportV1>;
export type RepositoryWorkspacePolicy = Static<typeof RepositoryWorkspacePolicyV1>;
export type CodebaseOnboardingProposal = Static<typeof CodebaseOnboardingProposalV1>;
export type CodebaseOnboardProposeRequest = Static<typeof CodebaseOnboardProposeRequestV1>;
export type CodebaseOnboardProposeResult = Static<typeof CodebaseOnboardProposeResultV1>;
export type CodebaseOnboardApplyRequest = Static<typeof CodebaseOnboardApplyRequestV1>;
export type CodebaseOnboardApplyResult = Static<typeof CodebaseOnboardApplyResultV1>;
