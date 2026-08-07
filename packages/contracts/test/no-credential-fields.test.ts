import { describe, expect, it } from "vitest";
import { SCHEMA_REGISTRY } from "../src/kernel/index.js";
// Side-effect only: every `versioned()` call registers itself on import.
import "../src/index.js";

/**
 * Deliberately broader than "password"/"secret" — matches the shapes real
 * credential leaks take (`apiKey`, `api_key`, `PRIVATE_KEY`, `accessToken`, ...).
 */
const CREDENTIAL_NAME_PATTERN =
  /password|secret|token|api[-_]?key|credential|private[-_]?key|access[-_]?key|passphrase/i;

function collectPropertyNames(
  schema: unknown,
  out: Set<string>,
  seen: Set<unknown> = new Set(),
): void {
  if (schema === null || typeof schema !== "object" || seen.has(schema)) {
    return;
  }
  seen.add(schema);

  if (Array.isArray(schema)) {
    for (const item of schema) collectPropertyNames(item, out, seen);
    return;
  }

  const record = schema as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object") {
    for (const key of Object.keys(record.properties as Record<string, unknown>)) {
      out.add(key);
    }
  }
  for (const value of Object.values(record)) {
    collectPropertyNames(value, out, seen);
  }
}

function collectLiteralStringValues(
  schema: unknown,
  out: Set<string>,
  seen: Set<unknown> = new Set(),
): void {
  if (schema === null || typeof schema !== "object" || seen.has(schema)) {
    return;
  }
  seen.add(schema);

  if (Array.isArray(schema)) {
    for (const item of schema) collectLiteralStringValues(item, out, seen);
    return;
  }

  const record = schema as Record<string, unknown>;
  if (typeof record.const === "string") {
    out.add(record.const);
  }
  if (Array.isArray(record.enum)) {
    for (const value of record.enum) {
      if (typeof value === "string") out.add(value);
    }
  }
  for (const value of Object.values(record)) {
    collectLiteralStringValues(value, out, seen);
  }
}

describe("no-credential-fields scan", () => {
  it("has a non-empty registry to scan", () => {
    expect(SCHEMA_REGISTRY.size).toBeGreaterThan(0);
  });

  it("no public contract property name is credential-shaped", () => {
    const propertyNames = new Set<string>();
    for (const schema of SCHEMA_REGISTRY.values()) {
      collectPropertyNames(schema, propertyNames);
    }

    const offenders = [...propertyNames].filter((name) => CREDENTIAL_NAME_PATTERN.test(name));
    expect(offenders, `credential-shaped property names: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no public contract literal/enum value is credential-shaped", () => {
    const literals = new Set<string>();
    for (const schema of SCHEMA_REGISTRY.values()) {
      collectLiteralStringValues(schema, literals);
    }

    const offenders = [...literals].filter((value) => CREDENTIAL_NAME_PATTERN.test(value));
    expect(offenders, `credential-shaped literal values: ${offenders.join(", ")}`).toEqual([]);
  });
});
