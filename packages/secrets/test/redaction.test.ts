import { describe, expect, it } from "vitest";
import { looksLikeCredentialKey, looksLikeCredentialValue } from "../src/patterns.js";
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
  ])("matches credential-shaped key %s", (key) => {
    expect(looksLikeCredentialKey(key)).toBe(true);
  });

  it.each(["max_tokens", "token_budget", "token", "tokens", "name", "id", "count", "timeout_ms"])(
    "does not match non-credential key %s (false-positive exclusion)",
    (key) => {
      expect(looksLikeCredentialKey(key)).toBe(false);
    },
  );
});

describe("looksLikeCredentialValue", () => {
  it("matches a GitHub classic personal access token", () => {
    expect(looksLikeCredentialValue(`ghp_${"a".repeat(36)}`)).toBe(true);
  });

  it("matches a GitHub fine-grained personal access token", () => {
    expect(looksLikeCredentialValue(`github_pat_${"a".repeat(24)}`)).toBe(true);
  });

  it("matches an OpenAI-style secret key", () => {
    expect(looksLikeCredentialValue(`sk-${"a".repeat(24)}`)).toBe(true);
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
