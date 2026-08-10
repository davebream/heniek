import { Type } from "@sinclair/typebox";
import { ProfileEngine, ProfileExecutionMode } from "../configuration/schemas.js";
import { versioned } from "../kernel/index.js";
import { SCHEMA_REGISTRY } from "../kernel/registry.js";

export const CapabilitySupport = Type.Union([
  Type.Literal("supported"),
  Type.Literal("unsupported"),
  Type.Literal("unknown"),
]);

const CapabilityEvidence = Type.Object(
  {
    source: Type.Union([
      Type.Literal("agent-capabilities"),
      Type.Literal("harness-inventory"),
      Type.Literal("account-profile"),
      Type.Literal("auth-readiness"),
      Type.Literal("model-api"),
      Type.Literal("model-manifest"),
      Type.Literal("compatibility-attestation"),
      Type.Literal("quota"),
      Type.Literal("cache"),
    ]),
    observedAt: Type.String({ format: "date-time" }),
    detail: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const CapabilityState = Type.Object(
  {
    support: CapabilitySupport,
    evidence: Type.Array(CapabilityEvidence),
    reasons: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  },
  { additionalProperties: false },
);

const CapabilityModel = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String({ minLength: 1 })),
    provenance: Type.Union([Type.Literal("api"), Type.Literal("manifest"), Type.Literal("none")]),
    efforts: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    executionModes: Type.Array(ProfileExecutionMode, { uniqueItems: true }),
  },
  { additionalProperties: false },
);

const CapabilityTool = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    state: CapabilityState,
  },
  { additionalProperties: false },
);

export const CapabilityCatalogueEntryV1 = Type.Object(
  {
    engine: ProfileEngine,
    accountId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    engineVersion: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    claudexorVersion: Type.String({ minLength: 1 }),
    observedAt: Type.String({ format: "date-time" }),
    expiresAt: Type.String({ format: "date-time" }),
    freshness: Type.Union([Type.Literal("fresh"), Type.Literal("stale")]),
    discovery: Type.Union([
      Type.Literal("complete"),
      Type.Literal("partial"),
      Type.Literal("failed"),
    ]),
    configured: Type.Boolean(),
    installation: Type.Union([
      Type.Literal("installed"),
      Type.Literal("not-installed"),
      Type.Literal("unknown"),
    ]),
    authentication: Type.Union([
      Type.Literal("authenticated"),
      Type.Literal("unauthenticated"),
      Type.Literal("unknown"),
    ]),
    compatibility: Type.Union([
      Type.Literal("compatible"),
      Type.Literal("incompatible"),
      Type.Literal("unknown"),
    ]),
    capacity: Type.Union([
      Type.Literal("available"),
      Type.Literal("rate-limited"),
      Type.Literal("unknown"),
    ]),
    ready: Type.Boolean(),
    models: Type.Array(CapabilityModel),
    features: Type.Object(
      {
        questions: CapabilityState,
        resume: CapabilityState,
        usage: CapabilityState,
        structuredOutput: CapabilityState,
        cancellation: CapabilityState,
        tools: Type.Array(CapabilityTool),
      },
      { additionalProperties: false },
    ),
    provenance: Type.Array(CapabilityEvidence),
    reasons: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const CapabilityCatalogueV1 = versioned("CapabilityCatalogue", 1, {
  generatedAt: Type.String({ format: "date-time" }),
  entries: Type.Array(CapabilityCatalogueEntryV1, { minItems: 3 }),
});

export const CapabilityCatalogueRequestV1 = versioned("CapabilityCatalogueRequest", 1, {
  refresh: Type.Boolean(),
});

export const CapabilitySelectionErrorV1 = versioned("CapabilitySelectionError", 1, {
  phase: Type.Union([Type.Literal("authoring"), Type.Literal("execution")]),
  engine: ProfileEngine,
  accountId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  issues: Type.Array(
    Type.Object(
      {
        capability: Type.String({ minLength: 1 }),
        state: Type.Union([
          Type.Literal("missing"),
          Type.Literal("unsupported"),
          Type.Literal("unknown"),
          Type.Literal("stale"),
          Type.Literal("incompatible"),
          Type.Literal("unauthenticated"),
          Type.Literal("rate-limited"),
        ]),
        message: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    { minItems: 1 },
  ),
});

/**
 * Axes that participate in a typed capability landing. Aggregate severity is
 * intentionally absent — readers compare per-axis values themselves.
 */
export const CapabilityDeltaAxis = Type.Union([
  Type.Literal("engine"),
  Type.Literal("account"),
  Type.Literal("billing"),
  Type.Literal("model"),
  Type.Literal("effort"),
  Type.Literal("executionMode"),
  Type.Literal("preferredFeatures"),
  Type.Literal("preferredTools"),
  Type.Literal("requiredFeatures"),
  Type.Literal("requiredTools"),
]);

/** Capability-shaped pins: admitted invocation overrides or hard requirements. */
export const CapabilityPinAxis = Type.Union([
  Type.Literal("engine"),
  Type.Literal("account"),
  Type.Literal("billing"),
  Type.Literal("model"),
  Type.Literal("effort"),
  Type.Literal("executionMode"),
  Type.Literal("requiredFeatures"),
  Type.Literal("requiredTools"),
]);

export const CapabilityFeatureName = Type.Union([
  Type.Literal("questions"),
  Type.Literal("resume"),
  Type.Literal("usage"),
  Type.Literal("structuredOutput"),
  Type.Literal("cancellation"),
]);

const SortedFeatureNames = Type.Array(CapabilityFeatureName, { uniqueItems: true });
const SortedToolNames = Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true });

/**
 * One differing axis between the requested primary profile (plus preferences)
 * and the concrete candidate that will execute. Only axes that actually differ
 * appear; equality is represented by absence, never by a zero-valued entry.
 */
export const CapabilityDifferenceV1 = Type.Union([
  Type.Object(
    {
      axis: Type.Literal("engine"),
      requested: ProfileEngine,
      resolved: ProfileEngine,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      axis: Type.Literal("account"),
      requested: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      resolved: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      axis: Type.Literal("billing"),
      requested: Type.Union([Type.Literal("subscription"), Type.Null()]),
      resolved: Type.Union([Type.Literal("subscription"), Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      axis: Type.Literal("model"),
      requested: Type.String({ minLength: 1 }),
      resolved: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      axis: Type.Literal("effort"),
      requested: Type.String({ minLength: 1 }),
      resolved: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      axis: Type.Literal("executionMode"),
      requested: ProfileExecutionMode,
      resolved: ProfileExecutionMode,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      axis: Type.Literal("preferredFeatures"),
      requested: SortedFeatureNames,
      resolved: SortedFeatureNames,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      axis: Type.Literal("preferredTools"),
      requested: SortedToolNames,
      resolved: SortedToolNames,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      axis: Type.Literal("requiredFeatures"),
      requested: SortedFeatureNames,
      resolved: SortedFeatureNames,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      axis: Type.Literal("requiredTools"),
      requested: SortedToolNames,
      resolved: SortedToolNames,
    },
    { additionalProperties: false },
  ),
]);

/** Provider-neutral record of a below-request landing. No severity field. */
export const CapabilityDeltaV1 = versioned("CapabilityDelta", 1, {
  requestedProfileId: Type.String({ minLength: 1 }),
  resolvedProfileId: Type.String({ minLength: 1 }),
  differences: Type.Array(CapabilityDifferenceV1),
});

/**
 * Typed blocker when every concrete route violates a pin or hard requirement.
 * Candidate differences explain why each alternative was rejected.
 */
export const CapabilityResolutionBlockerV1 = versioned("CapabilityResolutionBlocker", 1, {
  reason: Type.Literal("pinned_capability_unavailable"),
  pinnedAxes: Type.Array(CapabilityPinAxis, { minItems: 1, uniqueItems: true }),
  candidates: Type.Array(
    Type.Object(
      {
        profileId: Type.String({ minLength: 1 }),
        differences: Type.Array(CapabilityDifferenceV1, { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    { minItems: 1 },
  ),
});

const CAPABILITY_LANDING_SCHEMA_ID = "heniek://contract/CapabilityLanding/v1";

/**
 * Discriminated landing outcome. Callers must never infer success by absence
 * of a warning string — `satisfied` is an explicit status.
 */
export const CapabilityLandingV1 = Type.Union(
  [
    Type.Object(
      {
        schemaVersion: Type.Literal(1),
        status: Type.Literal("satisfied"),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(1),
        status: Type.Literal("degraded"),
        delta: Type.Ref(CapabilityDeltaV1),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(1),
        status: Type.Literal("blocked"),
        blocker: Type.Ref(CapabilityResolutionBlockerV1),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: CAPABILITY_LANDING_SCHEMA_ID },
);

if (SCHEMA_REGISTRY.has(CAPABILITY_LANDING_SCHEMA_ID)) {
  throw new Error(`Duplicate contract schema id: ${CAPABILITY_LANDING_SCHEMA_ID}`);
}
SCHEMA_REGISTRY.set(CAPABILITY_LANDING_SCHEMA_ID, CapabilityLandingV1);
