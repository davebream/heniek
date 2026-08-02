/**
 * Request authentication (design C6). Pure over the injected `MacProvider`:
 * the cryptography built-in is quarantined to `src/runtime/mac.ts`, which is
 * what lets this module — the part with the actual decision content — be unit
 * tested without `node:crypto` and stay inside C10's carve-out.
 *
 * A request is authentic iff, in this order:
 *
 * 0. `params.auth` validates closed against `DaemonRequestAuth/v1`'s shape.
 *    **This runs before any MAC is computed.** Every byte inside the
 *    `params.auth` span is excised from the signed preimage by construction,
 *    so anything an attacker puts there is unauthenticated; closing the shape
 *    is what makes that safe, by limiting the span to exactly `keyId`,
 *    `sequence`, and `mac`.
 * 1. `keyId` matches the current credential's.
 * 2. `sequence` strictly exceeds this connection's `lastSequence`.
 * 3. the MAC matches, compared in constant time.
 *
 * **Failure is uniform.** The outcome carries no reason, because a caller must
 * not learn whether the key was unknown, the sequence stale, or the MAC wrong
 * — nor, since authentication runs before method lookup, whether the method
 * exists at all (STD-9, CWE-204). Checks 1–3 are all evaluated before the
 * verdict is formed rather than short-circuited, so the work done does not
 * vary with which one failed.
 */

import type { MacProvider } from "../ports.js";
import { canonicaliseRequest } from "./canonical.js";
import { type ConnectionAuth, fromHex } from "./challenge.js";

/** Digest width of HMAC-SHA256, and therefore of a `mac` field. */
const MAC_BYTES = 32;
const SEQUENCE_MAX = 2 ** 31 - 1;

/**
 * The `params.auth` envelope, mirroring `DaemonRequestAuth/v1`. Validated
 * structurally here rather than by pulling the TypeBox validator in, so this
 * module keeps its only dependency on the `MacProvider` port.
 */
export interface RequestAuthEnvelope {
  readonly keyId: string;
  readonly sequence: number;
  readonly mac: string;
}

export type VerifyOutcome =
  | { readonly ok: true; readonly auth: ConnectionAuth }
  /** Deliberately reasonless — see the header. */
  | { readonly ok: false };

const REJECTED: VerifyOutcome = { ok: false };

export interface VerifyInput {
  readonly auth: ConnectionAuth;
  /** The exact line as received, before any re-serialisation. */
  readonly rawLine: string;
  /** The credential id this daemon currently authenticates against. */
  readonly keyId: string;
  readonly secret: Uint8Array;
}

/**
 * Validates `params.auth`'s shape closed. Returns `undefined` for anything
 * that is not exactly the three expected members with the expected types —
 * including extra members, which `additionalProperties: false` forbids on the
 * contract and which would otherwise ride along inside the excised span.
 */
export function parseAuthEnvelope(value: unknown): RequestAuthEnvelope | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;

  const keys = Object.keys(record);
  if (keys.length !== 3) {
    return undefined;
  }

  const keyId = record["keyId"];
  const sequence = record["sequence"];
  const mac = record["mac"];

  if (typeof keyId !== "string" || keyId.length === 0) {
    return undefined;
  }
  if (typeof sequence !== "number" || !Number.isInteger(sequence)) {
    return undefined;
  }
  if (sequence < 1 || sequence > SEQUENCE_MAX) {
    return undefined;
  }
  // Shape-checking `mac` here is what keeps `constantTimeEqual`'s
  // throw-on-unequal-length behaviour from ever becoming a crash or a length
  // oracle: it only ever sees two 32-byte buffers.
  if (typeof mac !== "string" || fromHex(mac, MAC_BYTES) === undefined) {
    return undefined;
  }

  return { keyId, sequence, mac };
}

/**
 * Builds the signed preimage: `challenge ‖ "\n" ‖ sequence ‖ "\n" ‖ canonical`.
 *
 * The challenge is included in its **hex** form — the same 64 characters
 * `daemon.hello` handed the client — so the preimage is a pure text
 * construction and there is no raw-bytes-versus-hex ambiguity for a client to
 * get wrong. The separators keep the fields unambiguous: without them, a
 * sequence of `12` followed by a canonical line starting `3…` would build the
 * same bytes as a sequence of `123`.
 */
export function buildPreimage(
  challengeHex: string,
  sequence: number,
  canonical: string,
): Uint8Array {
  return new TextEncoder().encode(`${challengeHex}\n${sequence}\n${canonical}`);
}

export function verifyRequest(
  input: VerifyInput,
  envelope: RequestAuthEnvelope,
  macProvider: MacProvider,
  challengeHex: string,
): VerifyOutcome {
  const canonical = canonicaliseRequest(input.rawLine);
  if (canonical === undefined) {
    // No `params.auth` span to excise — the request cannot have been signed.
    return REJECTED;
  }

  const provided = fromHex(envelope.mac, MAC_BYTES);
  if (provided === undefined) {
    return REJECTED;
  }

  const expected = macProvider.hmacSha256(
    input.secret,
    buildPreimage(challengeHex, envelope.sequence, canonical),
  );

  // All three evaluated before the verdict: no short-circuit, so the work done
  // does not reveal which check failed.
  const macMatches = macProvider.constantTimeEqual(expected, provided);
  const keyMatches = envelope.keyId === input.keyId;
  const sequenceAdvances = envelope.sequence > input.auth.lastSequence;

  if (!macMatches || !keyMatches || !sequenceAdvances) {
    return REJECTED;
  }

  return {
    ok: true,
    auth: { challenge: input.auth.challenge, lastSequence: envelope.sequence },
  };
}
