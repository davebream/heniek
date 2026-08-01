import { describe, expect, it } from "vitest";
import {
  isDisallowedConfigurationEntry,
  looksLikeCredentialKey,
  looksLikeCredentialValue,
} from "../src/patterns.js";
import { REDACTION_PLACEHOLDER, redactJson, redactText } from "../src/redaction.js";
import { SensitiveValue } from "../src/sensitive-value.js";

describe("looksLikeCredentialKey", () => {
  it.each([
    "password",
    "PASSWORD",
    "passphrase",
    "secret",
    "api_key",
    "api-key",
    "apiKey",
    "apikey",
    "access_key",
    "private_key",
    "client_secret",
    "auth_token",
    "access_token",
    "refresh_token",
    "bearer",
    "credential",
    "credentials",
    "db.password",
    "db_password",
    "GITHUB_API_KEY",
    // M6 recall-gap fixes:
    "GITHUB_TOKEN",
    "gh_token",
    "AWS_SESSION_TOKEN",
    "secretKey",
    "apiSecret",
    "secretAccessKey",
  ])("matches credential-shaped key %s", (key) => {
    expect(looksLikeCredentialKey(key)).toBe(true);
  });

  it.each([
    "max_tokens",
    "token_budget",
    "token",
    "tokens",
    "name",
    "id",
    "count",
    "timeout_ms",
    // M6 false-positive fixes:
    "tokenCount",
    "secretsDirectory",
    "bearer_capacity",
  ])("does not match non-credential key %s (false-positive exclusion)", (key) => {
    expect(looksLikeCredentialKey(key)).toBe(false);
  });
});

describe("looksLikeCredentialValue", () => {
  it("matches a GitHub classic personal access token", () => {
    expect(looksLikeCredentialValue(`ghp_${"a".repeat(36)}`)).toBe(true);
  });

  it.each(["gho_", "ghu_", "ghs_", "ghr_"])(
    "matches a GitHub scoped token with the %s prefix (H3)",
    (prefix) => {
      expect(looksLikeCredentialValue(`${prefix}${"a".repeat(36)}`)).toBe(true);
    },
  );

  it("matches a GitHub fine-grained personal access token", () => {
    expect(looksLikeCredentialValue(`github_pat_${"a".repeat(24)}`)).toBe(true);
  });

  it("matches an OpenAI-style secret key", () => {
    expect(looksLikeCredentialValue(`sk-${"a".repeat(24)}`)).toBe(true);
  });

  it("matches an OpenAI project secret key (sk-proj-…, H3)", () => {
    expect(looksLikeCredentialValue(`sk-proj-${"a".repeat(30)}`)).toBe(true);
  });

  it("matches an Anthropic-style secret key (sk-ant-api03-…, H3)", () => {
    expect(looksLikeCredentialValue(`sk-ant-api03-${"a".repeat(30)}`)).toBe(true);
  });

  it("matches a Stripe-style secret key (sk_live_…, H3)", () => {
    expect(looksLikeCredentialValue(`sk_live_${"a".repeat(30)}`)).toBe(true);
  });

  it("matches an AWS access key id", () => {
    expect(looksLikeCredentialValue("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  it("matches a PEM private key header", () => {
    expect(looksLikeCredentialValue("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(looksLikeCredentialValue("-----BEGIN PRIVATE KEY-----")).toBe(true);
  });

  it("matches a JWT-shaped base64url string", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(looksLikeCredentialValue(jwt)).toBe(true);
  });

  it("does not match ordinary strings", () => {
    expect(looksLikeCredentialValue("hello world")).toBe(false);
    expect(looksLikeCredentialValue("1.2.3")).toBe(false);
    expect(looksLikeCredentialValue("example.com")).toBe(false);
  });

  // M1: the H1 fix (anchoring the JWT pattern on `eyJ`) removed the
  // dotted-identifier false positives the old un-anchored 3-segment pattern
  // produced, but the previous negative corpus (`"hello world"`, `"1.2.3"`,
  // `"example.com"`) was far too short to ever reach that pattern in the
  // first place. These are long enough to actually exercise it.
  it.each([
    "packages-registry.internal-network.example-domain",
    "configuration_layers.built_in_defaults.pipeline_template",
    "my_long_module.some_submodule.another_thing",
    // ISO-timestamp-with-uuid: the kind of dotted, long, non-credential
    // string that a naive floor-only rule would also have swept up.
    "2026-08-01T13:19:08.421Z-550e8400-e29b-41d4-a716-446655440000",
    // A long fully-qualified hostname.
    "build-worker-07.us-east-1.internal.example-service.corp.example.com",
  ])("does not match long dotted/hyphenated non-credential identifier %s", (value) => {
    expect(looksLikeCredentialValue(value)).toBe(false);
  });

  // H1 regression: the old un-anchored JWT pattern
  // (`\b[A-Za-z0-9_-]{10,}\.[...]{10,}\.[...]{10,}\b`) was quadratic against
  // a long hyphenated run, since `-` is not a `\w` character and so gives a
  // fresh `\b` boundary at every letter. The `eyJ`-anchored, length-capped
  // replacement must complete well inside a time budget on the same input.
  it("completes well inside a time budget on a long hyphenated string (H1 perf regression)", () => {
    const pathological = "a-".repeat(50_000);

    const start = performance.now();
    looksLikeCredentialValue(pathological);
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe("redactText performance", () => {
  // Same H1 regression as above, exercised through `redactText` — the
  // consumer that runs the JWT pattern (among the whole
  // `CREDENTIAL_VALUE_PATTERNS` array) over every log line.
  it("completes well inside a time budget on a long hyphenated string", () => {
    const pathological = "a-".repeat(50_000);

    const start = performance.now();
    redactText(pathological);
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe("isDisallowedConfigurationEntry (M8)", () => {
  it("is true when the key is credential-shaped and the value is a scalar string", () => {
    expect(isDisallowedConfigurationEntry("apiKey", "raw-value")).toBe(true);
  });

  it("is false when the key is credential-shaped but the value is not a string", () => {
    expect(isDisallowedConfigurationEntry("credentials", { store: "file", name: "github" })).toBe(
      false,
    );
  });

  it("is true when the value shape matches a known credential pattern, regardless of key", () => {
    expect(isDisallowedConfigurationEntry("value", `ghp_${"a".repeat(36)}`)).toBe(true);
  });

  it("is false for an ordinary key/string-value pair", () => {
    expect(isDisallowedConfigurationEntry("name", "ok")).toBe(false);
  });
});

describe("redactJson", () => {
  it("redacts a value under a credential-shaped key", () => {
    const result = redactJson({ apiKey: "raw-value", name: "ok" });
    expect(result).toEqual({ apiKey: REDACTION_PLACEHOLDER, name: "ok" });
  });

  it("redacts a nested credential-shaped key at any depth", () => {
    const result = redactJson({ auth: { access_token: "raw-value" } });
    expect(result).toEqual({ auth: { access_token: REDACTION_PLACEHOLDER } });
  });

  it("does not redact a non-credential key such as max_tokens", () => {
    const result = redactJson({ max_tokens: 4096, token_budget: 100 });
    expect(result).toEqual({ max_tokens: 4096, token_budget: 100 });
  });

  it("redacts a credential-shaped string value even under an innocuous key", () => {
    const result = redactJson({ value: `ghp_${"a".repeat(36)}` });
    expect(result).toEqual({ value: REDACTION_PLACEHOLDER });
  });

  it("redacts a SensitiveValue wherever it appears", () => {
    const result = redactJson({ note: SensitiveValue.from("raw-value") });
    expect(result).toEqual({ note: REDACTION_PLACEHOLDER });
  });

  it("redacts any type of value under a credential key, not just strings", () => {
    const result = redactJson({ credentials: { store: "file", name: "github" } });
    expect(result).toEqual({ credentials: REDACTION_PLACEHOLDER });
  });

  it("redacts values inside arrays", () => {
    const result = redactJson(["hello", `ghp_${"a".repeat(36)}`]);
    expect(result).toEqual(["hello", REDACTION_PLACEHOLDER]);
  });

  it("leaves unrelated values untouched and returns a new structure", () => {
    const input = { name: "ok", count: 3, enabled: true, note: null };
    const result = redactJson(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it("is cycle-safe", () => {
    const input: Record<string, unknown> = { name: "ok" };
    input.self = input;

    let result: unknown;
    expect(() => {
      result = redactJson(input);
    }).not.toThrow();
    expect((result as { self: unknown }).self).toBe("[circular]");
  });

  it("does not flag a repeated (non-cyclic) reference as circular", () => {
    const shared = { name: "ok" };
    const input = { a: shared, b: shared };
    const result = redactJson(input);
    expect(result).toEqual({ a: { name: "ok" }, b: { name: "ok" } });
  });

  // H0: rebuilding an object with `result[key] = …` on a `{}` literal is
  // vulnerable to prototype pollution — bracket assignment to `__proto__`
  // invokes `Object.prototype`'s accessor setter, which reassigns the
  // accumulator's own prototype instead of creating a `"__proto__"` data
  // property. `redactJson` must produce a result that neither pollutes the
  // global `Object.prototype` nor silently drops the `__proto__` key.
  it("does not pollute Object.prototype and preserves an own __proto__ key (H0)", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;

    const result = redactJson(input) as Record<string, unknown>;

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    // `result.__proto__` would trigger the deprecated accessor rather than
    // reading the own data property — `getOwnPropertyDescriptor` reads the
    // own property directly, which is exactly what this test needs to prove.
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({
      polluted: true,
    });
  });

  it("does not pollute Object.prototype via a constructor/prototype key either", () => {
    const input = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as Record<
      string,
      unknown
    >;

    const result = redactJson(input) as Record<string, unknown>;

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(result, "constructor")).toBe(true);
  });

  // H0 (A4): exotic/boxed values must not fall through to the plain-object
  // branch, which would either mangle them (a Buffer's indexed properties
  // walked as a byte dump) or silently render them as `{}` (Date/Map/Set
  // have no own enumerable properties).
  it("renders a Buffer as an opaque placeholder rather than a byte dump", () => {
    const result = redactJson({ key: Buffer.from("raw-secret-bytes", "utf8") });
    expect(result).toEqual({ key: "[binary]" });
  });

  it("renders a Uint8Array as an opaque placeholder rather than a byte dump", () => {
    const result = redactJson({ key: new Uint8Array([1, 2, 3]) });
    expect(result).toEqual({ key: "[binary]" });
  });

  it("renders a Date as its ISO string rather than an empty object", () => {
    const date = new Date("2026-08-01T00:00:00.000Z");
    const result = redactJson({ createdAt: date });
    expect(result).toEqual({ createdAt: "2026-08-01T00:00:00.000Z" });
  });

  it("renders a Map's entries, redacting credential-shaped values inside it", () => {
    const map = new Map<string, string>([
      ["name", "ok"],
      ["token", `ghp_${"a".repeat(36)}`],
    ]);
    const result = redactJson({ headers: map });
    expect(result).toEqual({
      headers: [
        ["name", "ok"],
        ["token", REDACTION_PLACEHOLDER],
      ],
    });
  });

  it("renders a Set's values, redacting credential-shaped entries inside it", () => {
    const set = new Set<string>(["ok", `ghp_${"a".repeat(36)}`]);
    const result = redactJson({ tags: set });
    expect(result).toEqual({ tags: ["ok", REDACTION_PLACEHOLDER] });
  });

  it("unwraps a boxed String and still redacts a credential shape inside it", () => {
    // `new String(...)` (a boxed primitive) is exactly the input this test
    // exercises — see the boxed/exotic-value note on `redactValue` in
    // src/redaction.ts for why it needs its own handling.
    const boxed = new String(`ghp_${"a".repeat(36)}`);
    const result = redactJson({ value: boxed });
    expect(result).toEqual({ value: REDACTION_PLACEHOLDER });
  });

  it("is depth-safe against pathologically deep structures", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 10_000; i++) {
      deep = { child: deep };
    }

    let result: unknown;
    expect(() => {
      result = redactJson(deep);
    }).not.toThrow();

    let depth = 0;
    let node = result;
    while (
      node !== null &&
      typeof node === "object" &&
      "child" in (node as Record<string, unknown>)
    ) {
      depth++;
      node = (node as Record<string, unknown>).child;
    }
    expect(depth).toBeLessThan(10_000);
  });
});

describe("redactText", () => {
  it("redacts a credential-shaped substring within free text", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const text = `starting up with token=${token} on host example.com`;
    expect(redactText(text)).toBe(
      `starting up with token=${REDACTION_PLACEHOLDER} on host example.com`,
    );
  });

  it("redacts multiple occurrences", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const text = `${token} then again ${token}`;
    expect(redactText(text)).toBe(`${REDACTION_PLACEHOLDER} then again ${REDACTION_PLACEHOLDER}`);
  });

  it("leaves text with no credential-shaped substrings untouched", () => {
    const text = "nothing sensitive here, just a normal log line";
    expect(redactText(text)).toBe(text);
  });
});
