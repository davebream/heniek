/**
 * Byte-level `params.auth` excision (design C6, plan Task 3).
 *
 * Two properties matter, and they pull in opposite directions:
 *
 * 1. Everything outside the `params.auth` span must survive **byte-identically**
 *    — that is what makes the MAC cover what actually arrived.
 * 2. The `auth` member itself must be gone, since it carries the MAC and a MAC
 *    cannot cover itself.
 */

import { describe, expect, it } from "vitest";
import { canonicaliseRequest, extractAuthValueText, hasDuplicateKey } from "../src/auth/canonical.js";

const AUTH = '"auth":{"keyId":"k1","sequence":3,"mac":"ab"}';

describe("canonicaliseRequest — excision", () => {
  it("removes the auth member and leaves valid JSON", () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{${AUTH},"limit":10}}`;

    const canonical = canonicaliseRequest(line);

    expect(canonical).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{"limit":10}}',
    );
    expect(() => JSON.parse(canonical as string)).not.toThrow();
  });

  it("removes it when it is the last member", () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"limit":10,${AUTH}}}`;

    const canonical = canonicaliseRequest(line);

    expect(JSON.parse(canonical as string).params).toEqual({ limit: 10 });
  });

  it("removes it when it is the only member", () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{${AUTH}}}`;

    const canonical = canonicaliseRequest(line);

    expect(JSON.parse(canonical as string).params).toEqual({});
  });

  it("removes it from the middle of several members", () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"a":1,${AUTH},"b":2}}`;

    const canonical = canonicaliseRequest(line);

    expect(JSON.parse(canonical as string).params).toEqual({ a: 1, b: 2 });
  });
});

describe("canonicaliseRequest — byte fidelity", () => {
  it("preserves the surrounding bytes exactly, including insignificant whitespace", () => {
    // Whitespace is semantically irrelevant to JSON but must survive, because
    // the client signed these bytes and the verifier must reproduce them.
    const line = `{ "jsonrpc" : "2.0" ,  "id":1, "method":"m", "params":{ "a" : 1 , ${AUTH} } }`;

    const canonical = canonicaliseRequest(line) as string;

    expect(canonical).toBe(`{ "jsonrpc" : "2.0" ,  "id":1, "method":"m", "params":{ "a" : 1  } }`);
  });

  it("preserves a number's exact lexical form rather than normalising it", () => {
    // `1e2` and `100` parse equal but are different bytes. A verifier that
    // re-serialised would authenticate the wrong preimage.
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"n":1e2,${AUTH}}}`;

    expect(canonicaliseRequest(line)).toContain("1e2");
  });

  it("preserves the caller's escape choices inside strings", () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"s":"\\u0041",${AUTH}}}`;

    // `A` and `A` are the same string but not the same bytes.
    expect(canonicaliseRequest(line)).toContain("\\u0041");
  });

  it("preserves key order", () => {
    const line = `{"method":"m","id":1,"jsonrpc":"2.0","params":{"z":1,"a":2,${AUTH}}}`;

    expect(canonicaliseRequest(line)).toBe(
      '{"method":"m","id":1,"jsonrpc":"2.0","params":{"z":1,"a":2}}',
    );
  });
});

describe("canonicaliseRequest — nested and adversarial shapes", () => {
  it("does not mistake a nested auth key for the real one", () => {
    // The decisive case: a caller plants `"auth"` inside another member,
    // hoping the excision removes that instead and leaves the real MAC in the
    // signed preimage.
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"payload":{"auth":"decoy"},${AUTH}}}`;

    const canonical = canonicaliseRequest(line) as string;

    expect(JSON.parse(canonical).params).toEqual({ payload: { auth: "decoy" } });
    expect(canonical).not.toContain('"mac"');
  });

  it('does not mistake the string "auth" appearing as a value', () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"label":"auth",${AUTH}}}`;

    const canonical = canonicaliseRequest(line) as string;

    expect(JSON.parse(canonical).params).toEqual({ label: "auth" });
  });

  it("is not confused by braces or commas inside string values", () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"s":"},{\\"auth\\":1",${AUTH}}}`;

    const canonical = canonicaliseRequest(line) as string;

    expect(JSON.parse(canonical).params).toEqual({ s: '},{"auth":1' });
  });

  it("handles an auth member sitting after a nested array", () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"xs":[1,{"y":2},3],${AUTH}}}`;

    const canonical = canonicaliseRequest(line) as string;

    expect(JSON.parse(canonical).params).toEqual({ xs: [1, { y: 2 }, 3] });
  });

  it("handles escaped backslashes immediately before a quote", () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"s":"back\\\\",${AUTH}}}`;

    const canonical = canonicaliseRequest(line) as string;

    expect(JSON.parse(canonical).params).toEqual({ s: "back\\" });
  });
});

describe("canonicaliseRequest — absent auth", () => {
  it("returns undefined when params has no auth member", () => {
    expect(
      canonicaliseRequest('{"jsonrpc":"2.0","id":1,"method":"m","params":{"a":1}}'),
    ).toBeUndefined();
  });

  it("returns undefined when there are no params at all", () => {
    expect(canonicaliseRequest('{"jsonrpc":"2.0","id":1,"method":"m"}')).toBeUndefined();
  });

  it("returns undefined when params is not an object", () => {
    expect(
      canonicaliseRequest('{"jsonrpc":"2.0","id":1,"method":"m","params":[1,2]}'),
    ).toBeUndefined();
  });

  it("returns undefined when the root is not an object", () => {
    expect(canonicaliseRequest("[1,2,3]")).toBeUndefined();
  });
});

describe("extractAuthValueText", () => {
  it("returns exactly the auth member's value text, not its key and not any surrounding comma", () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"limit":10,${AUTH}}}`;

    expect(extractAuthValueText(line)).toBe('{"keyId":"k1","sequence":3,"mac":"ab"}');
  });

  it("returns undefined under the same conditions canonicaliseRequest does", () => {
    expect(
      extractAuthValueText('{"jsonrpc":"2.0","id":1,"method":"m","params":{"a":1}}'),
    ).toBeUndefined();
    expect(extractAuthValueText('{"jsonrpc":"2.0","id":1,"method":"m"}')).toBeUndefined();
  });

  it("locates the same auth member canonicaliseRequest excises, even when a decoy sits elsewhere", () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"payload":{"auth":"decoy"},${AUTH}}}`;

    expect(extractAuthValueText(line)).toBe('{"keyId":"k1","sequence":3,"mac":"ab"}');
  });
});

describe("hasDuplicateKey", () => {
  it("is false for an ordinary well-formed request", () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"a":1,${AUTH}}}`;
    expect(hasDuplicateKey(line)).toBe(false);
  });

  it("is true when the top-level object repeats a key", () => {
    expect(hasDuplicateKey('{"jsonrpc":"2.0","id":1,"id":2,"method":"m"}')).toBe(true);
  });

  it("is true when params repeats 'auth'", () => {
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{${AUTH},${AUTH}}}`;
    expect(hasDuplicateKey(line)).toBe(true);
  });

  it("is true for a duplicate key nested inside a value the top-level scan would otherwise skip over", () => {
    const line =
      '{"jsonrpc":"2.0","id":1,"method":"m","params":{"nested":{"x":1,"x":2}}}';
    expect(hasDuplicateKey(line)).toBe(true);
  });

  it("is true for a duplicate key inside an object nested in an array", () => {
    const line =
      '{"jsonrpc":"2.0","id":1,"method":"m","params":{"xs":[1,{"y":1,"y":2}]}}';
    expect(hasDuplicateKey(line)).toBe(true);
  });

  it("is false when the same key name appears in two different (non-duplicate) objects", () => {
    // "auth" legitimately appears once at the top of `params` and, separately,
    // as an ordinary string value elsewhere — not a repeated key of the same object.
    const line = `{"jsonrpc":"2.0","id":1,"method":"m","params":{"label":"auth",${AUTH}}}`;
    expect(hasDuplicateKey(line)).toBe(false);
  });

  it("does not mistake an 'auth'-shaped run of characters inside a string for a structural key", () => {
    const line =
      '{"jsonrpc":"2.0","id":1,"method":"m","params":{"note":"\\"auth\\": {\\"auth\\":1}"}}';
    expect(hasDuplicateKey(line)).toBe(false);
  });
});
