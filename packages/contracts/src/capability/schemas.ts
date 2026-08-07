import { Type } from "@sinclair/typebox";
import { ProfileEngine, ProfileExecutionMode } from "../configuration/schemas.js";
import { versioned } from "../kernel/index.js";

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
