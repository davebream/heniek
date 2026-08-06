import { type Static, Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";
import { CodebaseId, RepositoryId } from "../run/ids.js";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });

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

export type CodebaseDetectionResult = Static<typeof CodebaseDetectionResultV1>;
export type RegisteredCodebase = Static<typeof RegisteredCodebaseV1>;
export type InstructionSnapshot = Static<typeof InstructionSnapshotV1>;
export type InstructionDiagnostic = Static<typeof InstructionDiagnosticV1>;
