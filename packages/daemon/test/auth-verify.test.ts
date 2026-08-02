/**
 * Request authentication (design C6, plan Task 3).
 *
 * The `MacProvider` is a deterministic test double, not real HMAC: what is
 * under test is the decision rule — envelope shape, key match, sequence
 * advance, constant-time comparison, and the uniformity of failure — not
 * SHA-256 itself. `src/runtime/mac.ts` (Phase 5) supplies the real primitive.
 */

import { describe, expect, it } from "vitest";
import { type ConnectionAuth, fromHex, toHex } from "../src/auth/challenge.js";
import {
  buildPreimage,
  parseAuthEnvelope,
  type RequestAuthEnvelope,
  verifyRequest,
} from "../src/auth/verify.js";
import type { MacProvider } from "../src/ports.js";

const KEY_ID = "key-1";
const SECRET = new Uint8Array(32).fill(7);
const CHALLENGE = new Uint8Array(32).fill(3);
const CHALLENGE_HEX = toHex(CHALLENGE);

/**
 * A stand-in MAC: a deterministic 32-byte fold of key and message. Not
 * cryptographic — it only needs to be a stable function of its inputs so that
 * "the right preimage produces the right digest" is testable.
 */
function fakeHmac(key: Uint8Array, message: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < message.length; i += 1) {
    out[i % 32] = ((out[i % 32] as number) + (message[i] as number) * 31 + i) % 256;
  }
  for (let i = 0; i < key.length; i += 1) {
    out[i % 32] = ((out[i % 32] as number) ^ (key[i] as number)) % 256;
  }
  return out;
}

function makeMacProvider(): MacProvider & { comparisons: Array<[number, number]> } {
  const comparisons: Array<[number, number]> = [];
  return {
    comparisons,
    hmacSha256: fakeHmac,
    constantTimeEqual(a, b) {
      comparisons.push([a.length, b.length]);
      if (a.length !== b.length) {
        // Mirrors `crypto.timingSafeEqual`, which throws on a length mismatch.
        throw new RangeError("input buffers must have the same byte length");
      }
      return a.every((byte, i) => byte === b[i]);
    },
  };
}

const CONNECTION: ConnectionAuth = { challenge: CHALLENGE, lastSequence: 0 };

/** Builds a correctly-signed request line for `sequence`. */
function signedLine(sequence: number, params: Record<string, unknown> = {}): string {
  const withoutAuth = { jsonrpc: "2.0", id: 1, method: "daemon.status", params };
  const canonical = JSON.stringify(withoutAuth);
  const mac = toHex(fakeHmac(SECRET, buildPreimage(CHALLENGE_HEX, sequence, canonical)));

  // Insert `auth` as the FIRST member of params, so excision must actually
  // reproduce `canonical` rather than get there by luck.
  const authMember = `"auth":${JSON.stringify({ keyId: KEY_ID, sequence, mac })}`;
  const paramsBody = Object.keys(params).length
    ? `{${authMember},${JSON.stringify(params).slice(1, -1)}}`
    : `{${authMember}}`;
  return `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":${paramsBody}}`;
}

function envelopeOf(line: string): RequestAuthEnvelope {
  const parsed = parseAuthEnvelope((JSON.parse(line) as { params: { auth: unknown } }).params.auth);
  if (parsed === undefined) {
    throw new Error("test fixture produced an invalid envelope");
  }
  return parsed;
}

function verify(line: string, auth: ConnectionAuth = CONNECTION) {
  return verifyRequest(
    { auth, rawLine: line, keyId: KEY_ID, secret: SECRET },
    envelopeOf(line),
    makeMacProvider(),
    CHALLENGE_HEX,
  );
}

describe("parseAuthEnvelope — the closed shape (finding M4(a))", () => {
  const valid = { keyId: "k", sequence: 1, mac: "a".repeat(64) };

  it("accepts exactly the three expected members", () => {
    expect(parseAuthEnvelope(valid)).toEqual(valid);
  });

  it("rejects an extra member — it would ride along inside the excised span", () => {
    // This is the whole reason the shape must be closed: anything here is
    // unauthenticated by construction.
    expect(parseAuthEnvelope({ ...valid, extra: "smuggled" })).toBeUndefined();
  });

  it.each([
    ["missing keyId", { sequence: 1, mac: "a".repeat(64) }],
    ["empty keyId", { ...valid, keyId: "" }],
    ["fractional sequence", { ...valid, sequence: 1.5 }],
    ["zero sequence", { ...valid, sequence: 0 }],
    ["NaN sequence", { ...valid, sequence: Number.NaN }],
    ["out-of-range sequence", { ...valid, sequence: 2 ** 31 }],
    ["short mac", { ...valid, mac: "ab" }],
    ["uppercase mac", { ...valid, mac: "A".repeat(64) }],
    ["non-hex mac", { ...valid, mac: "z".repeat(64) }],
    ["array", [1, 2, 3]],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(parseAuthEnvelope(value)).toBeUndefined();
  });

  it("rejects a bad mac before any comparison can see it", () => {
    // Shape validation is what stops `constantTimeEqual`'s throw-on-length
    // -mismatch from becoming a crash or a length oracle.
    const provider = makeMacProvider();
    const line = signedLine(1).replace(/"mac":"[a-f0-9]+"/, '"mac":"abcd"');

    expect(parseAuthEnvelope(JSON.parse(line).params.auth)).toBeUndefined();
    expect(provider.comparisons).toEqual([]);
  });
});

describe("verifyRequest — the authentic path", () => {
  it("accepts a correctly signed request", () => {
    expect(verify(signedLine(1)).ok).toBe(true);
  });

  it("advances lastSequence to the accepted sequence", () => {
    const outcome = verify(signedLine(5));

    expect(outcome.ok && outcome.auth.lastSequence).toBe(5);
  });

  it("keeps the connection's challenge unchanged", () => {
    const outcome = verify(signedLine(1));

    expect(outcome.ok && outcome.auth.challenge).toBe(CHALLENGE);
  });

  it("accepts a request carrying additional params alongside auth", () => {
    expect(verify(signedLine(1, { limit: 10 })).ok).toBe(true);
  });

  it("only ever compares two 32-byte buffers", () => {
    const provider = makeMacProvider();
    const line = signedLine(1);

    verifyRequest(
      { auth: CONNECTION, rawLine: line, keyId: KEY_ID, secret: SECRET },
      envelopeOf(line),
      provider,
      CHALLENGE_HEX,
    );

    expect(provider.comparisons).toEqual([[32, 32]]);
  });
});

describe("verifyRequest — rejection", () => {
  it("rejects a replayed request, even though its MAC is perfectly valid", () => {
    // The sequence window is what makes a captured-and-resent request fail.
    const line = signedLine(3);

    expect(verify(line, { challenge: CHALLENGE, lastSequence: 3 }).ok).toBe(false);
  });

  it("rejects a sequence that goes backwards", () => {
    expect(verify(signedLine(2), { challenge: CHALLENGE, lastSequence: 9 }).ok).toBe(false);
  });

  it("rejects an unknown keyId", () => {
    const line = signedLine(1).replace(`"keyId":"${KEY_ID}"`, '"keyId":"other"');

    expect(verify(line).ok).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const line = signedLine(1);

    const outcome = verifyRequest(
      { auth: CONNECTION, rawLine: line, keyId: KEY_ID, secret: new Uint8Array(32).fill(9) },
      envelopeOf(line),
      makeMacProvider(),
      CHALLENGE_HEX,
    );

    expect(outcome.ok).toBe(false);
  });

  it("rejects a request signed against a different challenge", () => {
    const line = signedLine(1);

    const outcome = verifyRequest(
      { auth: CONNECTION, rawLine: line, keyId: KEY_ID, secret: SECRET },
      envelopeOf(line),
      makeMacProvider(),
      toHex(new Uint8Array(32).fill(4)),
    );

    // A fresh challenge per connection is what stops a replay on a new
    // connection of the same instance.
    expect(outcome.ok).toBe(false);
  });

  it("rejects a tampered body — the MAC covers the bytes outside auth", () => {
    const line = signedLine(1, { limit: 10 }).replace('"limit":10', '"limit":99');

    expect(verify(line).ok).toBe(false);
  });

  it("rejects a tampered method", () => {
    const line = signedLine(1).replace('"daemon.status"', '"daemon.recovery"');

    expect(verify(line).ok).toBe(false);
  });

  it("carries no reason a caller could use as an oracle", () => {
    const wrongKey = verify(signedLine(1).replace(`"keyId":"${KEY_ID}"`, '"keyId":"other"'));
    const replayed = verify(signedLine(1), { challenge: CHALLENGE, lastSequence: 5 });

    // Byte-identical outcomes: nothing distinguishes an unknown key from a
    // stale sequence.
    expect(wrongKey).toEqual(replayed);
    expect(Object.keys(wrongKey)).toEqual(["ok"]);
  });
});

describe("buildPreimage — field separation", () => {
  it("separates sequence from the canonical body", () => {
    // Without separators, sequence 12 followed by a body starting "3…" would
    // build the same bytes as sequence 123.
    const a = buildPreimage(CHALLENGE_HEX, 12, "3abc");
    const b = buildPreimage(CHALLENGE_HEX, 123, "abc");

    expect(a).not.toEqual(b);
  });

  it("binds the challenge into the preimage", () => {
    const a = buildPreimage(CHALLENGE_HEX, 1, "{}");
    const b = buildPreimage(toHex(new Uint8Array(32).fill(9)), 1, "{}");

    expect(a).not.toEqual(b);
  });
});

describe("hex helpers", () => {
  it("round-trips", () => {
    expect(fromHex(toHex(SECRET), 32)).toEqual(SECRET);
  });

  it("rejects the wrong length and uppercase", () => {
    expect(fromHex("abcd", 32)).toBeUndefined();
    expect(fromHex("A".repeat(64), 32)).toBeUndefined();
  });
});
