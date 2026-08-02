/**
 * The per-request authentication core (design C6, plan Task 3 Steps 2 and
 * 8). `verifyRequest` checks, in order:
 *
 *  0. the raw line contains no duplicate JSON member name anywhere — a
 *     structural envelope defect, not an authentication failure, and the
 *     one check that runs *before* anything else and can reject with a
 *     kind distinct from "unauthorized" (plan Task 3 Step 2(a));
 *  1. `params.auth` is present exactly once as a direct child of `params`
 *     and validates against the closed `DaemonRequestAuth/v1` shape (Step
 *     2(e)) — using `src/auth/canonical.ts`'s real JSON tokenizer to locate
 *     it, never a substring search;
 *  2. `keyId` matches the current credential's;
 *  3. `sequence` is strictly greater than `lastSequence` on this connection;
 *  4. `mac === HMAC-SHA256(secret, challenge ‖ "\n" ‖ sequence ‖ "\n" ‖
 *     canonicalRequestBytes)`, where `canonicalRequestBytes` is the exact
 *     received line with the `params.auth` member excised by
 *     `canonicaliseRequest` — never a re-serialisation of a parsed object.
 *
 * The MAC computation and comparison run **unconditionally** once the
 * duplicate-key check has passed — regardless of whether `params.auth` was
 * even present, whether `keyId` matched, or whether `sequence` was in the
 * replay window — so the amount of work performed, and therefore its
 * timing, does not vary with *why* a request is about to be rejected
 * (STD-9's second, timing, oracle). Every rejection this function can
 * produce past that first check is folded by `src/rpc/dispatch.ts` into the
 * single, uniform `-32001` response; this function's `reason` field exists
 * for tests and tracing only and must never reach the wire.
 */

import type { MacProvider } from "../ports.js";
import { canonicaliseRequest, extractAuthValueText, hasDuplicateKey } from "./canonical.js";
import type { ConnectionAuthState } from "./challenge.js";

export interface AuthenticatedCredential {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

export type VerifyResult =
  | { readonly kind: "authenticated" }
  /** A duplicate JSON member name was found anywhere in the frame — an envelope defect, not an authentication failure (plan Task 3 Step 2(a)). */
  | { readonly kind: "malformed-envelope"; readonly reason: string }
  | { readonly kind: "unauthorized"; readonly reason: string };

const HEX_DIGITS = "0123456789abcdef";
const HEX64_PATTERN = /^[a-f0-9]{64}$/;
const FALLBACK_MAC_HEX = "0".repeat(64);
const MAC_BYTES = 32;
const SEQUENCE_MAX = 2 ** 31 - 1;

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX_DIGITS[byte >> 4];
    out += HEX_DIGITS[byte & 0x0f];
  }
  return out;
}

/** Inverse of `bytesToHex`. Never throws — callers only ever pass a string this module has already shape-checked as 64 lowercase hex characters. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const textEncoder = new TextEncoder();

/**
 * Builds the signed preimage: `challenge ‖ "\n" ‖ sequence ‖ "\n" ‖
 * canonicalRequestBytes` (design C6). The separators keep the fields
 * unambiguous — without them, a sequence of `12` followed by a canonical
 * line starting `3…` would build the same bytes as a sequence of `123`.
 */
export function buildAuthMacMessage(
  challenge: Uint8Array,
  sequence: number,
  canonicalRequestBytes: string,
): Uint8Array {
  const suffix = textEncoder.encode(`\n${sequence}\n${canonicalRequestBytes}`);
  const message = new Uint8Array(challenge.length + suffix.length);
  message.set(challenge, 0);
  message.set(suffix, challenge.length);
  return message;
}

interface RequestAuthEnvelope {
  readonly keyId: string;
  readonly sequence: number;
  readonly mac: string;
}

const REQUEST_AUTH_KEYS = ["schemaVersion", "keyId", "sequence", "mac"] as const;

/**
 * Hand-validates the closed `DaemonRequestAuth/v1` shape (design C4/C6)
 * without a runtime TypeBox dependency — `@sinclair/typebox` is a
 * type-only `devDependency` in this package (plan Task 1 Step 2). This
 * mirrors the schema's constraints (`additionalProperties: false`,
 * `sequence` an integer in `[1, 2^31 - 1]`, `mac` exactly 64 lowercase hex
 * characters) by hand, the same way `src/rpc/codec.ts` hand-rolls framing
 * instead of taking a library dependency (OR-10).
 */
function validateRequestAuthEnvelope(value: unknown): RequestAuthEnvelope | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== REQUEST_AUTH_KEYS.length) {
    return undefined;
  }
  for (const key of keys) {
    if (!(REQUEST_AUTH_KEYS as readonly string[]).includes(key)) {
      return undefined;
    }
  }
  if (record.schemaVersion !== 1) {
    return undefined;
  }
  if (typeof record.keyId !== "string" || record.keyId.length < 1) {
    return undefined;
  }
  if (
    typeof record.sequence !== "number" ||
    !Number.isInteger(record.sequence) ||
    record.sequence < 1 ||
    record.sequence > SEQUENCE_MAX
  ) {
    return undefined;
  }
  // Shape-checking `mac` here is what keeps `constantTimeEqual`'s
  // throw-on-unequal-length behaviour (STD-10) from ever becoming a crash
  // or a length oracle: `hexToBytes` below only ever sees a 64-character
  // hex string, valid or the fixed-width fallback.
  if (typeof record.mac !== "string" || !HEX64_PATTERN.test(record.mac)) {
    return undefined;
  }
  return { keyId: record.keyId, sequence: record.sequence, mac: record.mac };
}

function describeRejection(
  envelope: RequestAuthEnvelope | undefined,
  keyIdMatches: boolean,
  sequenceAdvances: boolean,
  macMatches: boolean,
): string {
  if (envelope === undefined) {
    return "missing or malformed params.auth";
  }
  if (!keyIdMatches) {
    return "unknown keyId";
  }
  if (!sequenceAdvances) {
    return "sequence did not advance";
  }
  if (!macMatches) {
    return "mac mismatch";
  }
  return "unauthorized";
}

export function verifyRequest(
  macProvider: MacProvider,
  credential: AuthenticatedCredential,
  connection: ConnectionAuthState,
  rawLine: string,
): VerifyResult {
  let duplicate: boolean;
  try {
    duplicate = hasDuplicateKey(rawLine);
  } catch {
    // Defensive only: `src/rpc/codec.ts` already proved `rawLine` parses
    // with `JSON.parse` before this function is ever called, so the
    // tokenizer disagreeing is an internal inconsistency, not a real
    // client input.
    return { kind: "malformed-envelope", reason: "request line could not be re-scanned" };
  }
  if (duplicate) {
    return { kind: "malformed-envelope", reason: "duplicate JSON member name in request" };
  }

  let canonicalRequestBytes: string;
  let authValueText: string | undefined;
  try {
    canonicalRequestBytes = canonicaliseRequest(rawLine) ?? rawLine;
    authValueText = extractAuthValueText(rawLine);
  } catch {
    return { kind: "malformed-envelope", reason: "request line could not be re-scanned" };
  }

  let envelope: RequestAuthEnvelope | undefined;
  if (authValueText !== undefined) {
    try {
      envelope = validateRequestAuthEnvelope(JSON.parse(authValueText));
    } catch {
      envelope = undefined;
    }
  }

  // The MAC is computed and compared unconditionally from this point on —
  // never short-circuited by a missing `params.auth`, an unknown `keyId`,
  // or a stale `sequence` — so the timing of every rejection past the
  // duplicate-key check is identical (STD-9's timing oracle).
  const sequence = envelope?.sequence ?? 0;
  const macHex = envelope?.mac ?? FALLBACK_MAC_HEX;
  const suppliedKeyId = envelope?.keyId ?? "";

  const expectedMac = macProvider.hmacSha256(
    credential.secret,
    buildAuthMacMessage(connection.challenge, sequence, canonicalRequestBytes),
  );
  const suppliedMac = hexToBytes(macHex);
  const macMatches =
    suppliedMac.length === MAC_BYTES && macProvider.constantTimeEqual(suppliedMac, expectedMac);
  const keyIdMatches = suppliedKeyId === credential.keyId;
  const sequenceAdvances = sequence > connection.lastSequence;

  const authenticated = envelope !== undefined && keyIdMatches && sequenceAdvances && macMatches;
  if (!authenticated) {
    return {
      kind: "unauthorized",
      reason: describeRejection(envelope, keyIdMatches, sequenceAdvances, macMatches),
    };
  }

  connection.lastSequence = sequence;
  return { kind: "authenticated" };
}
