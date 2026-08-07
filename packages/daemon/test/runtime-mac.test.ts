/**
 * The real `MacProvider` adapter's own coverage (design C6/C10, plan Task 5
 * Step 2c, finding M5). `src/runtime/mac.ts` ships behind a port every
 * Phase 3 auth test can — and does — pass against a fabricated stub whose
 * `hmacSha256` returns a constant and whose `constantTimeEqual` is `===`.
 * Ratifying `MacProvider` as a C10 port (the Phase 3 planner note) means
 * that stub coverage alone would let the *real* HMAC implementation ship
 * with zero tests of its own. This file closes that gap:
 *
 * (a) RFC 4231 HMAC-SHA-256 known-answer vectors, driven through the real
 *     adapter — proof against the standard, not against itself;
 * (b) an unequal-length input to `constantTimeEqual`, asserting it returns
 *     `false` rather than letting `crypto.timingSafeEqual`'s
 *     `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` escape as a crash;
 * (c) one Phase 3 auth accept/reject pair run against the real provider
 *     (not the stub), proving the wiring between `src/auth/verify.ts` and
 *     the real HMAC actually works end to end.
 */

import { describe, expect, it } from "vitest";
import { mintConnectionAuthState } from "../src/auth/challenge.js";
import { buildAuthMacMessage, bytesToHex, verifyRequest } from "../src/auth/verify.js";
import type { RandomSource } from "../src/ports.js";
import { createHmacSha256MacProvider } from "../src/runtime/mac.js";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("createHmacSha256MacProvider — RFC 4231 known-answer vectors", () => {
  it("matches RFC 4231 Test Case 1 (20-byte key, 'Hi There')", () => {
    const provider = createHmacSha256MacProvider();
    const key = new Uint8Array(20).fill(0x0b);
    const digest = provider.hmacSha256(key, ascii("Hi There"));

    expect(hex(digest)).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  });

  it("matches RFC 4231 Test Case 2 (key 'Jefe', 'what do ya want for nothing?')", () => {
    const provider = createHmacSha256MacProvider();
    const digest = provider.hmacSha256(ascii("Jefe"), ascii("what do ya want for nothing?"));

    expect(hex(digest)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });
});

describe("createHmacSha256MacProvider — constantTimeEqual", () => {
  it("returns true for identical byte arrays", () => {
    const provider = createHmacSha256MacProvider();
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(provider.constantTimeEqual(a, b)).toBe(true);
  });

  it("returns false for equal-length, differing byte arrays", () => {
    const provider = createHmacSha256MacProvider();
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(provider.constantTimeEqual(a, b)).toBe(false);
  });

  it("returns false — never throws — for an unequal-length pair (plan Task 5 Step 2c(b))", () => {
    const provider = createHmacSha256MacProvider();
    const a = new Uint8Array(32);
    const b = new Uint8Array(31);
    expect(() => provider.constantTimeEqual(a, b)).not.toThrow();
    expect(provider.constantTimeEqual(a, b)).toBe(false);
  });

  it("returns false for a zero-length pair rather than throwing", () => {
    const provider = createHmacSha256MacProvider();
    expect(provider.constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    expect(provider.constantTimeEqual(new Uint8Array(0), new Uint8Array(1))).toBe(false);
  });
});

function counterRandomSource(): RandomSource {
  let counter = 0;
  return {
    bytes: (length: number) =>
      Uint8Array.from({ length }, () => {
        counter += 1;
        return counter & 0xff;
      }),
  };
}

describe("verifyRequest against the real MacProvider (plan Task 5 Step 2c(c))", () => {
  const provider = createHmacSha256MacProvider();
  const credential = { keyId: "aaaabbbbccccdddd", secret: new Uint8Array(32).fill(7) };

  it("accepts a correctly signed request", () => {
    const connection = mintConnectionAuthState(counterRandomSource());
    const canonical = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}';
    const sequence = 1;
    const mac = bytesToHex(
      provider.hmacSha256(
        credential.secret,
        buildAuthMacMessage(connection.challenge, sequence, canonical),
      ),
    );
    const auth = `{"schemaVersion":1,"keyId":"${credential.keyId}","sequence":${sequence},"mac":"${mac}"}`;
    const raw = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${auth}}}`;

    const result = verifyRequest(provider, credential, connection, raw);
    expect(result.kind).toBe("authenticated");
  });

  it("rejects a request signed with a wrong secret", () => {
    const connection = mintConnectionAuthState(counterRandomSource());
    const canonical = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}';
    const sequence = 1;
    const wrongSecret = new Uint8Array(32).fill(9);
    const mac = bytesToHex(
      provider.hmacSha256(
        wrongSecret,
        buildAuthMacMessage(connection.challenge, sequence, canonical),
      ),
    );
    const auth = `{"schemaVersion":1,"keyId":"${credential.keyId}","sequence":${sequence},"mac":"${mac}"}`;
    const raw = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${auth}}}`;

    const result = verifyRequest(provider, credential, connection, raw);
    expect(result.kind).toBe("unauthorized");
  });
});
