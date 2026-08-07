import { Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const GitSha = Type.String({ pattern: "^[0-9a-f]{40}$" });
const Semver = Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" });

const RuntimeIdentityFields = {
  engine: Type.String({ minLength: 1 }),
  sourceMode: Type.Union([Type.Literal("managed"), Type.Literal("external")]),
  entryPath: Type.String({ minLength: 1 }),
  version: Semver,
  buildSha: GitSha,
  binarySha256: Sha256,
  archiveSha256: Type.Optional(Sha256),
};

const RuntimeIdentity = Type.Object(
  { schemaVersion: Type.Literal(1), ...RuntimeIdentityFields },
  { additionalProperties: false },
);

const OptionalRuntimeIdentity = Type.Union([RuntimeIdentity, Type.Null()]);

/** Provider-neutral identity for one exact runnable engine build. */
export const RuntimeIdentityV1 = versioned("RuntimeIdentity", 1, RuntimeIdentityFields);

/** The complete local runtime inventory. Paths are local-only and never daemon/domain state. */
export const RuntimeInventoryV1 = versioned("RuntimeInventory", 1, {
  active: OptionalRuntimeIdentity,
  previous: OptionalRuntimeIdentity,
  installed: Type.Array(RuntimeIdentity),
});

const CompatibilityStatus = Type.Union([
  Type.Literal("pass"),
  Type.Literal("fail"),
  Type.Literal("blocked"),
]);

/** A promotion gate result bound to an exact runtime identity and suite revision. */
export const RuntimeCompatibilityReportV1 = versioned("RuntimeCompatibilityReport", 1, {
  reportId: Type.String({ minLength: 1 }),
  runtime: RuntimeIdentity,
  suiteVersion: Type.Integer({ minimum: 1 }),
  status: CompatibilityStatus,
  checks: Type.Array(
    Type.Object(
      {
        name: Type.String({ minLength: 1 }),
        status: CompatibilityStatus,
        message: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
  completedAt: Type.String({ format: "date-time" }),
});

/** Result envelope shared by every explicit runtime mutation command. */
export const RuntimeMutationResultV1 = versioned("RuntimeMutationResult", 1, {
  action: Type.Union([
    Type.Literal("install"),
    Type.Literal("activate"),
    Type.Literal("upgrade"),
    Type.Literal("rollback"),
    Type.Literal("adopt"),
  ]),
  activeBefore: OptionalRuntimeIdentity,
  activeAfter: OptionalRuntimeIdentity,
  runtime: Type.Optional(RuntimeIdentity),
  compatibilityReportId: Type.Optional(Type.String({ minLength: 1 })),
});
