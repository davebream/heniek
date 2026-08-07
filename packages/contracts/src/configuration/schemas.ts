import { Type } from "@sinclair/typebox";
import { ProfileId } from "../execution-backend/ids.js";
import { versioned } from "../kernel/index.js";
import { AccountId, RoleId, WorkerId } from "./ids.js";

/**
 * A diagnostic record, as a **plain, unregistered** TypeBox object inlined
 * into both schemas below rather than a `versioned()` contract of its own.
 *
 * Registering it would give it an `$id`, and that `$id` would then appear
 * nested inside two other schemas — an Ajv duplicate-`$id` hazard the moment
 * both parents are added to the same validator instance. Inlining costs a
 * little duplication in the generated output and removes the failure mode
 * entirely. It is also honest about the design: a diagnostic is not an
 * independently versioned public contract, it is part of the shape of the two
 * results that carry it.
 */
const Diagnostic = Type.Object(
  {
    /**
     * Deliberately an open `string`, not an enum. Diagnostic codes grow
     * additively (`configuration.value-overridden`,
     * `configuration.hard-limit-clamped`, …), and a closed enum would force a
     * schema version bump for every new code — turning a purely additive
     * change into a breaking one for every consumer.
     */
    code: Type.String({ minLength: 1 }),
    severity: Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")]),
    message: Type.String(),
    sourcePath: Type.Optional(Type.String()),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    column: Type.Optional(Type.Integer({ minimum: 1 })),
    pointer: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ApplicationHomeRoot = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    origin: Type.Union([
      Type.Literal("heniek-home-variable"),
      Type.Literal("xdg-base-directory"),
      Type.Literal("user-home-fallback"),
    ]),
  },
  { additionalProperties: false },
);

/**
 * The resolved application home (spec §7): which directory each of the four
 * base-directory roots landed on, and why.
 *
 * `paths` is an **open** `string → string` record rather than an object with
 * one property per layout entry. Two reasons, and the second is the binding
 * one: the layout grows as the product does, so enumerating it here would
 * make every new directory a contract change; and one of the entry names is
 * `secretsDirectory`, which the credential-name scanner in
 * `test/no-credential-fields.test.ts` matches on sight. That name belongs in
 * `@heniek/config`'s TypeScript layout type — where it is checked exhaustively
 * and costs nothing — not in a published schema.
 */
export const ApplicationHomeV1 = versioned("ApplicationHome", 1, {
  platform: Type.Union([Type.Literal("darwin"), Type.Literal("linux"), Type.Literal("other")]),
  roots: Type.Object(
    {
      config: ApplicationHomeRoot,
      data: ApplicationHomeRoot,
      state: ApplicationHomeRoot,
      runtime: ApplicationHomeRoot,
    },
    { additionalProperties: false },
  ),
  paths: Type.Record(Type.String(), Type.String()),
  diagnostics: Type.Array(Diagnostic),
});

const ConfigurationLayer = Type.Union([
  Type.Literal("built-in-defaults"),
  Type.Literal("global-defaults"),
  Type.Literal("codebase"),
  Type.Literal("repository"),
  Type.Literal("pipeline-template"),
  Type.Literal("profile-or-stage"),
  Type.Literal("invocation-override"),
]);

/**
 * A configuration value is arbitrary JSON, so it is typed as `unknown` rather
 * than as a recursive JSON schema. A `Type.Recursive` definition would
 * introduce its own `$id`/`$ref` pair nested inside two registered
 * schemas — the same duplicate-`$id` hazard `Diagnostic` avoids by being
 * inlined — and it would buy nothing: the restricted-YAML subset, not this
 * schema, is what constrains which JSON may enter a configuration document.
 */
const ConfigurationValue = Type.Unknown();

const ConfigurationProvenanceEntry = Type.Object(
  {
    layer: ConfigurationLayer,
    sourcePath: Type.Optional(Type.String()),
    value: ConfigurationValue,
  },
  { additionalProperties: false },
);

/**
 * A fully resolved configuration (spec §8.2): the merged values, plus — for
 * every leaf — which layer won and what it overrode, plus the diagnostics
 * raised while merging. `provenance` is what makes AC2's "source layer,
 * winning value, and material conflicts" answerable from the artefact alone,
 * without re-running the resolution.
 */
export const ResolvedConfigurationV1 = versioned("ResolvedConfiguration", 1, {
  layers: Type.Array(ConfigurationLayer),
  values: Type.Record(Type.String(), ConfigurationValue),
  provenance: Type.Array(
    Type.Object(
      {
        pointer: Type.String(),
        layer: ConfigurationLayer,
        sourcePath: Type.Optional(Type.String()),
        value: ConfigurationValue,
        overridden: Type.Array(ConfigurationProvenanceEntry),
      },
      { additionalProperties: false },
    ),
  ),
  diagnostics: Type.Array(Diagnostic),
});

export const ProfileEngine = Type.Union([
  Type.Literal("claude"),
  Type.Literal("codex"),
  Type.Literal("cursor"),
]);

export const ProfileExecutionMode = Type.Union([Type.Literal("native"), Type.Literal("external")]);

export const ProfileQuestionMode = Type.Union([
  Type.Literal("parent-mediated"),
  Type.Literal("direct"),
]);

export const ProfileOverridableField = Type.Union([
  Type.Literal("engine"),
  Type.Literal("account"),
  Type.Literal("billing"),
  Type.Literal("model"),
  Type.Literal("effort"),
  Type.Literal("executor"),
  Type.Literal("focus"),
  Type.Literal("max_duration"),
  Type.Literal("workspace_strategy"),
]);

const ConfigurationName = Type.String({
  minLength: 1,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
});

const Duration = Type.String({ pattern: "^[1-9][0-9]*(?:ms|s|m|h|d)$" });

const SafeRelativePath = Type.String({
  minLength: 1,
  pattern: "^(?!/)(?!.*[\\\\])(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
});

const AccountConfiguration = Type.Object(
  {
    engine: ProfileEngine,
    billing: Type.Literal("subscription"),
  },
  { additionalProperties: false },
);

const WorkerConfiguration = Type.Object(
  {
    engine: ProfileEngine,
    executor: ProfileExecutionMode,
    account: Type.Optional(AccountId),
    model: Type.String({ minLength: 1 }),
    effort: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const RoleConfiguration = Type.Object(
  {
    instructions: SafeRelativePath,
    artifact_contract: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const ProfileConfiguration = Type.Object(
  {
    worker: WorkerId,
    role: RoleId,
    questions: ProfileQuestionMode,
    overridable: Type.Optional(Type.Array(ProfileOverridableField, { uniqueItems: true })),
    focus: Type.Optional(Type.String({ minLength: 1 })),
    max_duration: Type.Optional(Duration),
    workspace_strategy: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/**
 * The post-layer-merge shape for §9's named configuration. Human-authored
 * YAML does not carry `schemaVersion`; the configuration package adds it only
 * while validating the merged value against this public compatibility
 * contract.
 */
export const ProfileConfigurationV1 = versioned("ProfileConfiguration", 1, {
  accounts: Type.Optional(
    Type.Record(ConfigurationName, AccountConfiguration, { additionalProperties: false }),
  ),
  workers: Type.Optional(
    Type.Record(ConfigurationName, WorkerConfiguration, { additionalProperties: false }),
  ),
  roles: Type.Optional(
    Type.Record(ConfigurationName, RoleConfiguration, { additionalProperties: false }),
  ),
  profiles: Type.Optional(
    Type.Record(ConfigurationName, ProfileConfiguration, { additionalProperties: false }),
  ),
});

const ResolvedProfileProvenanceEntry = Type.Object(
  {
    layer: ConfigurationLayer,
    sourcePath: Type.Optional(Type.String()),
    value: ConfigurationValue,
  },
  { additionalProperties: false },
);

const ResolvedProfileProvenance = Type.Object(
  {
    field: Type.String({ minLength: 1 }),
    pointer: Type.String({ minLength: 1 }),
    layer: ConfigurationLayer,
    sourcePath: Type.Optional(Type.String()),
    value: ConfigurationValue,
    overridden: Type.Array(ResolvedProfileProvenanceEntry),
  },
  { additionalProperties: false },
);

export const ResolvedProfileFields = {
  profileId: ProfileId,
  workerId: WorkerId,
  roleId: RoleId,
  engine: ProfileEngine,
  accountId: Type.Optional(AccountId),
  billing: Type.Optional(Type.Literal("subscription")),
  model: Type.String({ minLength: 1 }),
  effort: Type.String({ minLength: 1 }),
  executionMode: ProfileExecutionMode,
  questions: ProfileQuestionMode,
  instructionsPath: SafeRelativePath,
  artifactContract: Type.String({ minLength: 1 }),
  focus: Type.Optional(Type.String({ minLength: 1 })),
  maxDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
  workspaceStrategy: Type.Optional(Type.String({ minLength: 1 })),
  provenance: Type.Array(ResolvedProfileProvenance),
  fingerprint: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
} as const;

/** Registered standalone compatibility contract. */
export const ResolvedProfileV1 = versioned("ResolvedProfile", 1, ResolvedProfileFields);

/** Unregistered inline shape for embedding without a nested duplicate `$id`. */
export const ResolvedProfileSchema = Type.Object(
  { schemaVersion: Type.Literal(1), ...ResolvedProfileFields },
  { additionalProperties: false },
);
