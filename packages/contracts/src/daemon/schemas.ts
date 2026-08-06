import { Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";
import { RunId } from "../run/ids.js";
import { RunStatus } from "../run/state.js";
import { RunRecoveryClass } from "./state.js";

/** 32 raw bytes (challenge) or a 32-byte HMAC-SHA256 digest, hex-encoded. */
const HEX_32_BYTES = "^[a-f0-9]{64}$";

/**
 * The single pre-auth method's result (`daemon.hello`, design C2/C8). `keyId`
 * lets a client learn the credential id it is about to authenticate against
 * from the handshake itself, rather than through a separate call.
 */
export const DaemonHelloResultV1 = versioned("DaemonHelloResult", 1, {
  protocolVersion: Type.Integer({ minimum: 1 }),
  instanceId: Type.String({ minLength: 1 }),
  challenge: Type.String({ pattern: HEX_32_BYTES, description: "32 bytes, hex-encoded" }),
  macAlgorithm: Type.Literal("hmac-sha256"),
  keyId: Type.String({ minLength: 1 }),
});

/**
 * The per-request proof envelope every authenticated call carries in
 * `params.auth` (design C6, NIST SP 800-63B-4 §3.2.7 / STD-12). Carries
 * **no** secret. The schema is closed (`versioned()` already imposes
 * `additionalProperties: false`) and `sequence` is pinned as a bounded
 * integer, not a bare `number` (plan-review round 1, finding M4(d)) — a bare
 * `number` would admit `1e308`, `NaN`, and fractional values, and this shape
 * cannot be tightened later without a digest change once it is pinned.
 */
export const DaemonRequestAuthV1 = versioned("DaemonRequestAuth", 1, {
  keyId: Type.String({ minLength: 1 }),
  sequence: Type.Integer({ minimum: 1, maximum: 2 ** 31 - 1 }),
  mac: Type.String({ pattern: HEX_32_BYTES, description: "HMAC-SHA256, hex-encoded" }),
});

/*
 * There is deliberately no `DaemonCredentialRotation/v1` and no
 * `daemon.rotateCredential` method (plan-review round 2, finding 13; design
 * `## Alternatives Considered` row S). Round 1's finding M2 had added the
 * schema as that method's result contract; round 2 withdrew the method
 * itself, and the contract had no other consumer. The secret is rotated
 * once per process start, **before the socket is bound**, so no live client
 * can observe a key change mid-session and there is nothing for a rotation
 * RPC to report. `keyId` stays on `DaemonHelloResult/v1` so a client learns
 * the key it is about to authenticate against from the handshake itself.
 */

/**
 * `daemon.status`'s result (design C9, OR-19) — makes the lifecycle
 * observable. `lifecycleState` is an open string rather than a closed enum:
 * the concrete state vocabulary lands in `src/lifecycle/state.ts` in a later
 * phase, and this schema must not need a digest-moving edit the day that
 * vocabulary gains a state. `reconciliation` and `artifactRecovery` are
 * plain non-negative counts, not classification records — the per-run
 * detail lives in `RunRecoveryClassification/v1` below.
 */
export const DaemonStatusV1 = versioned("DaemonStatus", 1, {
  instanceId: Type.String({ minLength: 1 }),
  lifecycleState: Type.String({ minLength: 1 }),
  startedAt: Type.String({ format: "date-time" }),
  reconciliation: Type.Object(
    {
      probed: Type.Integer({ minimum: 0 }),
      resumable: Type.Integer({ minimum: 0 }),
      failed: Type.Integer({ minimum: 0 }),
      cancelled: Type.Integer({ minimum: 0 }),
      unknown: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  artifactRecovery: Type.Object(
    {
      removedIncoming: Type.Integer({ minimum: 0 }),
      skippedIncoming: Type.Integer({ minimum: 0 }),
      unreferencedBlobs: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
});

/**
 * The authenticated protocol negotiation request. Protocol method versions
 * deliberately live beside, rather than inside, the domain DTO versions.
 */
export const DaemonNegotiationRequestV1 = versioned("DaemonNegotiationRequest", 1, {
  auth: Type.Object(
    {
      schemaVersion: Type.Literal(1),
      keyId: Type.String({ minLength: 1 }),
      sequence: Type.Integer({ minimum: 1, maximum: 2 ** 31 - 1 }),
      mac: Type.String({ pattern: HEX_32_BYTES }),
    },
    { additionalProperties: false },
  ),
  transportVersions: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, uniqueItems: true }),
  requiredMethods: Type.Array(
    Type.Object(
      {
        name: Type.String({ minLength: 1 }),
        methodVersions: Type.Array(Type.Integer({ minimum: 1 }), {
          minItems: 1,
          uniqueItems: true,
        }),
        resultSchemas: Type.Array(
          Type.Object(
            {
              schemaId: Type.String({ minLength: 1 }),
              sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, uniqueItems: true },
        ),
      },
      { additionalProperties: false },
    ),
    { minItems: 1 },
  ),
});

export const DaemonNegotiationResultV1 = versioned("DaemonNegotiationResult", 1, {
  compatibility: Type.Union([Type.Literal("compatible"), Type.Literal("incompatible")]),
  selectedTransportVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  contractManifestVersion: Type.String({ minLength: 1 }),
  methods: Type.Array(
    Type.Object(
      {
        name: Type.String({ minLength: 1 }),
        methodVersion: Type.Integer({ minimum: 1 }),
        wireMethod: Type.String({ minLength: 1 }),
        resultSchemaId: Type.String({ minLength: 1 }),
        resultSchemaSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      },
      { additionalProperties: false },
    ),
  ),
  reasons: Type.Array(
    Type.Union([
      Type.Literal("NO_COMMON_TRANSPORT"),
      Type.Literal("METHOD_UNAVAILABLE"),
      Type.Literal("RESULT_SCHEMA_UNAVAILABLE"),
    ]),
    { uniqueItems: true },
  ),
});

export const RpcCancelRequestV1 = versioned("RpcCancelRequest", 1, {
  auth: Type.Object(
    {
      schemaVersion: Type.Literal(1),
      keyId: Type.String({ minLength: 1 }),
      sequence: Type.Integer({ minimum: 1, maximum: 2 ** 31 - 1 }),
      mac: Type.String({ pattern: HEX_32_BYTES }),
    },
    { additionalProperties: false },
  ),
  requestId: Type.Union([Type.String({ minLength: 1 }), Type.Integer()]),
});

export const RpcCancelResultV1 = versioned("RpcCancelResult", 1, {
  accepted: Type.Boolean(),
});

export const DaemonRecoveryResultV1 = versioned("DaemonRecoveryResult", 1, {
  classifications: Type.Array(
    Type.Object(
      {
        runId: Type.String({ minLength: 1 }),
        classification: Type.Union(RunRecoveryClass.map((value) => Type.Literal(value))),
        runStatus: Type.Union([
          Type.Literal("queued"),
          Type.Literal("running"),
          Type.Literal("waiting_on_user"),
          Type.Literal("succeeded"),
          Type.Literal("failed"),
          Type.Literal("cancelled"),
          Type.Literal("recovery_required"),
        ]),
        probeOutcome: Type.Union([Type.Literal("status"), Type.Literal("error")]),
      },
      { additionalProperties: false },
    ),
  ),
});

/**
 * `daemon.recovery`'s result element (design C12, AC-3) — makes the
 * four-way classification split observable and testable. `classification`
 * references the plain-tuple `RunRecoveryClass`, never `defineStates`; the
 * probe outcome names how the classification was reached, distinct from
 * both the classification and the projected `RunStatus`.
 *
 * `probeOutcome` is deliberately `"status" | "error"` with no `"absent"`
 * member (plan review round 1, reviewer B, finding MINOR 2).
 * `ExecutionBackend.status(runId)` (`../execution-backend/backend.js`)
 * has no unknown-run channel and contracts define no typed not-found
 * error, so a conforming backend can only ever produce those two
 * outcomes; `"absent"` was reachable solely through a test helper's
 * marker and does not belong in a versioned wire contract. A run whose
 * status cannot be resolved classifies as `unknown` with
 * `probeOutcome: "error"`.
 */
export const RunRecoveryClassificationV1 = versioned("RunRecoveryClassification", 1, {
  runId: RunId,
  classification: Type.Union(RunRecoveryClass.map((value) => Type.Literal(value))),
  runStatus: RunStatus.schema,
  probeOutcome: Type.Union([Type.Literal("status"), Type.Literal("error")]),
});
