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

/**
 * `daemon.rotateCredential`'s result (plan-review round 1, finding M2 — the
 * prior draft shipped no versioned result contract). Carries **no** secret
 * material, only the new opaque `keyId` and when rotation happened.
 * Rotation is atomic and total: the new secret is written to the
 * `SecretStore` first, then installed; every connection — including the
 * rotating caller's — validates against the new `keyId` from the next frame
 * onward; a frame carrying the previous `keyId` after rotation receives the
 * uniform `-32001`.
 */
export const DaemonCredentialRotationV1 = versioned("DaemonCredentialRotation", 1, {
  instanceId: Type.String({ minLength: 1 }),
  keyId: Type.String({ minLength: 1 }),
  rotatedAt: Type.String({ format: "date-time" }),
});

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
 * `daemon.recovery`'s result element (design C12, AC-3) — makes the
 * four-way classification split observable and testable. `classification`
 * references the plain-tuple `RunRecoveryClass`, never `defineStates`; the
 * probe outcome names how the classification was reached, distinct from
 * both the classification and the projected `RunStatus`.
 */
export const RunRecoveryClassificationV1 = versioned("RunRecoveryClassification", 1, {
  runId: RunId,
  classification: Type.Union(RunRecoveryClass.map((value) => Type.Literal(value))),
  runStatus: RunStatus.schema,
  probeOutcome: Type.Union([
    Type.Literal("status"),
    Type.Literal("error"),
    Type.Literal("absent"),
  ]),
});
