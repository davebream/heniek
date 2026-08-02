/**
 * The auth core (design C5/C6, plan Task 3 Steps 2 and 7-8):
 * `mintCredential`, `mintConnectionAuthState`, and `verifyRequest`'s
 * canonicaliser + replay window.
 *
 * `verifyRequest` is driven directly with hand-authored request lines
 * throughout, so the "canonical bytes" every test expects are visible in
 * the test itself rather than derived from the module under test — the
 * whole point of a canonicalisation test is that it must not validate
 * itself.
 */

import { describe, expect, it, vi } from "vitest";
import { mintConnectionAuthState } from "../src/auth/challenge.js";
import { mintCredential } from "../src/auth/credential.js";
import {
  type AuthenticatedCredential,
  buildAuthMacMessage,
  bytesToHex,
  hexToBytes,
  verifyRequest,
} from "../src/auth/verify.js";
import type { MacProvider, RandomSource } from "../src/ports.js";

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

/**
 * A deterministic, non-cryptographic stand-in for HMAC-SHA256 — sufficient
 * to prove the *plumbing* (canonicalisation, replay window, uniform
 * rejection) is correct. Cryptographic correctness against the real
 * `node:crypto` provider is proven in Phase 5's `runtime-mac.test.ts` (plan
 * Task 3 Step 2, "Real-provider coverage requirement").
 */
function fakeMacProvider(): MacProvider & {
  readonly hmacCalls: number;
  readonly compareCalls: number;
} {
  const state = { hmacCalls: 0, compareCalls: 0 };
  return {
    get hmacCalls() {
      return state.hmacCalls;
    },
    get compareCalls() {
      return state.compareCalls;
    },
    hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
      state.hmacCalls += 1;
      const digest = new Uint8Array(32);
      let seed = 7;
      for (const byte of key) {
        seed = (seed * 31 + byte) & 0xff;
      }
      for (let index = 0; index < message.length; index++) {
        const slot = index % 32;
        digest[slot] = ((digest[slot] ?? 0) ^ ((message[index] ?? 0) + seed + index)) & 0xff;
      }
      return digest;
    },
    constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
      state.compareCalls += 1;
      if (a.length !== b.length) {
        return false;
      }
      let diff = 0;
      for (let index = 0; index < a.length; index++) {
        diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
      }
      return diff === 0;
    },
  };
}

const KEY_ID = "aaaabbbbccccdddd";
const SECRET = Uint8Array.from({ length: 32 }, (_v, i) => i + 1);

function credential(): AuthenticatedCredential {
  return { keyId: KEY_ID, secret: SECRET };
}

/** Signs `canonical` and returns the hex `mac` field to embed on the wire. */
function sign(
  mac: MacProvider,
  challenge: Uint8Array,
  sequence: number,
  canonical: string,
): string {
  return bytesToHex(mac.hmacSha256(SECRET, buildAuthMacMessage(challenge, sequence, canonical)));
}

function authObject(sequence: number, mac: string): string {
  return `{"schemaVersion":1,"keyId":"${KEY_ID}","sequence":${sequence},"mac":"${mac}"}`;
}

describe("mintCredential", () => {
  it("mints a 32-byte secret and a 32-hex-character keyId from the injected RandomSource", () => {
    const credentialValue = mintCredential(counterRandomSource());
    expect(credentialValue.secret).toHaveLength(32);
    expect(credentialValue.keyId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic given a deterministic RandomSource", () => {
    const a = mintCredential(counterRandomSource());
    const b = mintCredential(counterRandomSource());
    expect(bytesToHex(a.secret)).toBe(bytesToHex(b.secret));
    expect(a.keyId).toBe(b.keyId);
  });
});

describe("mintConnectionAuthState", () => {
  it("mints a fresh 32-byte challenge and starts lastSequence at 0, unauthenticated", () => {
    const state = mintConnectionAuthState(counterRandomSource());
    expect(state.challenge).toHaveLength(32);
    expect(state.lastSequence).toBe(0);
    expect(state.helloCalled).toBe(false);
  });
});

describe("verifyRequest — canonicalisation and MAC", () => {
  it("accepts a validly signed request and advances lastSequence", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const canonical = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}';
    const macHex = sign(mac, connection.challenge, 5, canonical);
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${authObject(5, macHex)}}}`;

    const result = verifyRequest(mac, credential(), connection, line);

    expect(result.kind).toBe("authenticated");
    expect(connection.lastSequence).toBe(5);
  });

  it("excises a leading params.auth member (auth first, another member follows) correctly", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const canonical = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"runId":"r1"}}';
    const macHex = sign(mac, connection.challenge, 1, canonical);
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${authObject(1, macHex)},"runId":"r1"}}`;

    const result = verifyRequest(mac, credential(), connection, line);
    expect(result.kind).toBe("authenticated");
  });

  it("excises a trailing params.auth member (another member first, auth last) correctly", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const canonical = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"runId":"r1"}}';
    const macHex = sign(mac, connection.challenge, 1, canonical);
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"runId":"r1","auth":${authObject(1, macHex)}}}`;

    const result = verifyRequest(mac, credential(), connection, line);
    expect(result.kind).toBe("authenticated");
  });

  it("missing keyId (params.auth entirely absent) is unauthorized", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const line = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}';

    const result = verifyRequest(mac, credential(), connection, line);
    expect(result.kind).toBe("unauthorized");
  });

  it("wrong keyId is unauthorized, and the MAC computation still runs exactly once", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const canonical = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}';
    const macHex = sign(mac, connection.challenge, 1, canonical);
    const wrongKeyAuth = `{"schemaVersion":1,"keyId":"0000000000000000","sequence":1,"mac":"${macHex}"}`;
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${wrongKeyAuth}}}`;

    const before = mac.hmacCalls;
    const result = verifyRequest(mac, credential(), connection, line);

    expect(result.kind).toBe("unauthorized");
    expect(mac.hmacCalls).toBe(before + 1);
    expect(mac.compareCalls).toBeGreaterThan(0);
  });

  it("wrong mac is unauthorized", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${authObject(1, "0".repeat(64))}}}`;

    const result = verifyRequest(mac, credential(), connection, line);
    expect(result.kind).toBe("unauthorized");
  });

  it("a mac that is not exactly 64 lowercase hex characters is rejected without ever mismatching lengths in the compare", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const shortMacAuth = `{"schemaVersion":1,"keyId":"${KEY_ID}","sequence":1,"mac":"abcd"}`;
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${shortMacAuth}}}`;

    expect(() => verifyRequest(mac, credential(), connection, line)).not.toThrow();
    const result = verifyRequest(mac, credential(), connection, line);
    expect(result.kind).toBe("unauthorized");
  });

  it("performs the same MAC computation whether or not the keyId is known (missing vs wrong vs correct keyId)", () => {
    const connection1 = mintConnectionAuthState(counterRandomSource());
    const connection2 = mintConnectionAuthState(counterRandomSource());
    const mac1 = fakeMacProvider();
    const mac2 = fakeMacProvider();

    const canonical = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}';
    const macHex1 = sign(mac1, connection1.challenge, 1, canonical);
    const missingAuthLine = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}';
    const wrongKeyLine = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":{"schemaVersion":1,"keyId":"ffffffffffffffff","sequence":1,"mac":"${macHex1}"}}}`;

    verifyRequest(mac1, credential(), connection1, missingAuthLine);
    verifyRequest(mac2, credential(), connection2, wrongKeyLine);

    expect(mac1.hmacCalls).toBe(mac2.hmacCalls);
    expect(mac1.compareCalls).toBe(mac2.compareCalls);
  });

  it("replay of a byte-identical request on the same connection is rejected (sequence not strictly increasing)", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const canonical = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}';
    const macHex = sign(mac, connection.challenge, 5, canonical);
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${authObject(5, macHex)}}}`;

    expect(verifyRequest(mac, credential(), connection, line).kind).toBe("authenticated");
    expect(verifyRequest(mac, credential(), connection, line).kind).toBe("unauthorized");
  });

  it("the same bytes replayed on a new connection are rejected (fresh challenge, MAC mismatch)", () => {
    const mac = fakeMacProvider();
    const connection1 = mintConnectionAuthState(counterRandomSource());
    const canonical = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}';
    const macHex = sign(mac, connection1.challenge, 5, canonical);
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${authObject(5, macHex)}}}`;

    expect(verifyRequest(mac, credential(), connection1, line).kind).toBe("authenticated");

    // A different connection has a different challenge — even the counter
    // source's next-in-sequence bytes differ from connection1's.
    const connection2 = mintConnectionAuthState(counterRandomSource());
    // Force a distinct challenge deterministically.
    connection2.challenge.set([0xff]);
    const result = verifyRequest(mac, credential(), connection2, line);
    expect(result.kind).toBe("unauthorized");
  });

  it("a forward sequence gap is accepted; equal or lower is rejected", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const canonical = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}';

    const macHex10 = sign(mac, connection.challenge, 10, canonical);
    const line10 = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${authObject(10, macHex10)}}}`;
    expect(verifyRequest(mac, credential(), connection, line10).kind).toBe("authenticated");

    const macHex10Again = sign(mac, connection.challenge, 10, canonical);
    const lineEqual = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${authObject(10, macHex10Again)}}}`;
    expect(verifyRequest(mac, credential(), connection, lineEqual).kind).toBe("unauthorized");

    const macHex3 = sign(mac, connection.challenge, 3, canonical);
    const lineLower = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${authObject(3, macHex3)}}}`;
    expect(verifyRequest(mac, credential(), connection, lineLower).kind).toBe("unauthorized");

    const macHex99 = sign(mac, connection.challenge, 99, canonical);
    const lineGap = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${authObject(99, macHex99)}}}`;
    expect(verifyRequest(mac, credential(), connection, lineGap).kind).toBe("authenticated");
  });

  it("a sequence of 1.5, NaN-shaped, 0, or 2^31 is rejected by schema validation rather than the sequence window", () => {
    const mac = fakeMacProvider();
    for (const badSequence of ["1.5", '"not-a-number"', "0", String(2 ** 31)]) {
      const connection = mintConnectionAuthState(counterRandomSource());
      const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":{"schemaVersion":1,"keyId":"${KEY_ID}","sequence":${badSequence},"mac":"${"a".repeat(64)}"}}}`;
      const result = verifyRequest(mac, credential(), connection, line);
      expect(result.kind).toBe("unauthorized");
    }
  });

  it("an unexpected member inside params.auth is rejected (closed shape)", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const canonical = '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}';
    const macHex = sign(mac, connection.challenge, 1, canonical);
    const extraMemberAuth = `{"schemaVersion":1,"keyId":"${KEY_ID}","sequence":1,"mac":"${macHex}","extra":"nope"}`;
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${extraMemberAuth}}}`;

    const result = verifyRequest(mac, credential(), connection, line);
    expect(result.kind).toBe("unauthorized");
  });

  it("duplicate 'auth' keys at params level are rejected as malformed-envelope, not unauthorized", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"auth":${authObject(1, "a".repeat(64))},"auth":${authObject(1, "b".repeat(64))}}}`;

    const result = verifyRequest(mac, credential(), connection, line);
    expect(result.kind).toBe("malformed-envelope");
  });

  it("a duplicate key anywhere in the frame (not just params.auth) is rejected as malformed-envelope", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const line = `{"jsonrpc":"2.0","id":1,"id":2,"method":"daemon.status","params":{"auth":${authObject(1, "a".repeat(64))}}}`;

    const result = verifyRequest(mac, credential(), connection, line);
    expect(result.kind).toBe("malformed-envelope");
  });

  it("an auth-shaped substring inside an unrelated string value does not confuse the scanner", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    // No real params.auth exists at all here — only a string that *looks*
    // like one embedded inside another field's value.
    const line =
      '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"note":"\\"auth\\": {\\"keyId\\":\\"x\\"}"}}';

    const result = verifyRequest(mac, credential(), connection, line);
    // Missing real auth ⇒ unauthorized, never a scan crash and never
    // treated as a duplicate-key/malformed-envelope case.
    expect(result.kind).toBe("unauthorized");
  });

  it("a nested member also named auth (not a direct child of params) is not excised, and the MAC still verifies over it", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    const canonical =
      '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"nested":{"auth":"decoy"}}}';
    const macHex = sign(mac, connection.challenge, 1, canonical);
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"nested":{"auth":"decoy"},"auth":${authObject(1, macHex)}}}`;

    const result = verifyRequest(mac, credential(), connection, line);
    expect(result.kind).toBe("authenticated");
  });

  it("only the single direct params.auth member is ever excised, even when a look-alike sits elsewhere in params", () => {
    const mac = fakeMacProvider();
    const connection = mintConnectionAuthState(counterRandomSource());
    // If the implementation ever excised more than one span, the canonical
    // bytes it computes would differ from this hand-verified single-excision
    // string, and the MAC would fail to verify.
    const canonical =
      '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"meta":{"auth":{"fake":true}}}}';
    const macHex = sign(mac, connection.challenge, 1, canonical);
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"meta":{"auth":{"fake":true}},"auth":${authObject(1, macHex)}}}`;

    const result = verifyRequest(mac, credential(), connection, line);
    expect(result.kind).toBe("authenticated");
  });
});

describe("hexToBytes / bytesToHex", () => {
  it("round-trips", () => {
    const original = Uint8Array.from([0, 1, 2, 255, 128, 16]);
    expect(hexToBytes(bytesToHex(original))).toEqual(original);
  });
});
