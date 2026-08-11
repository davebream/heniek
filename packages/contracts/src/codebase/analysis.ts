import { type Static, Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";
import { AnalysisPacketId, CodebaseId, RepositoryId, WorkspaceId } from "../run/ids.js";
import { EffectiveInstructionReportV1 } from "./schemas.js";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const GitObjectId = Type.String({ pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" });
const IsoDateTime = Type.String({ format: "date-time" });
const SafeRelativePath = Type.String({
  minLength: 1,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
});

const RepositoryIndexEntry = Type.Object(
  {
    path: SafeRelativePath,
    mode: Type.String({ pattern: "^[0-7]{6}$" }),
    type: Type.Union([Type.Literal("blob"), Type.Literal("commit")]),
    objectId: GitObjectId,
    byteLength: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);

const RepositoryIndex = Type.Object(
  {
    maxEntries: Type.Integer({ minimum: 1, maximum: 10000 }),
    maxBytes: Type.Integer({ minimum: 1, maximum: 1048576 }),
    observedEntries: Type.Integer({ minimum: 0 }),
    observedBytes: Type.Integer({ minimum: 0 }),
    emittedEntries: Type.Integer({ minimum: 0, maximum: 10000 }),
    emittedBytes: Type.Integer({ minimum: 0, maximum: 1048576 }),
    truncated: Type.Boolean(),
    entries: Type.Array(RepositoryIndexEntry, { maxItems: 10000 }),
  },
  { additionalProperties: false },
);

const AnalysisRepository = Type.Object(
  {
    repositoryId: RepositoryId,
    name: Type.String({ minLength: 1 }),
    checkoutPath: Type.String({ minLength: 1, pattern: "^/" }),
    base: Type.Object(
      {
        kind: Type.Union([Type.Literal("managed-pin"), Type.Literal("adopted-head")]),
        sha: GitObjectId,
      },
      { additionalProperties: false },
    ),
    index: RepositoryIndex,
  },
  { additionalProperties: false },
);

/** Metadata-only, whole-Codebase input for the initial analysis stage. */
export const WholeCodebaseAnalysisPacketV1 = versioned("WholeCodebaseAnalysisPacket", 1, {
  packetId: AnalysisPacketId,
  codebaseId: CodebaseId,
  workspaceId: WorkspaceId,
  sourceRepositoryId: RepositoryId,
  registrationSha256: Sha256,
  configurationSha256: Sha256,
  effectiveInstructions: Type.Ref(EffectiveInstructionReportV1),
  repositories: Type.Array(AnalysisRepository, { minItems: 1 }),
  createdAt: IsoDateTime,
});

export type WholeCodebaseAnalysisPacket = Static<typeof WholeCodebaseAnalysisPacketV1>;
