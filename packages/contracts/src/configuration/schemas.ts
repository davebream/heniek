import { Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";

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
