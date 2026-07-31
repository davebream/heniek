import { describe, expect, it } from "vitest";
import { readSmokeConfig, validateSmokeModuleSpecifier } from "../src/smoke/env.js";

// Fixture repo root — a string used only for `node:path` resolution, never
// touched on disk, so these tests need no filesystem fixtures.
const REPO_ROOT = "/repo";

describe("validateSmokeModuleSpecifier (X4 — HENIEK_CONFORMANCE_SMOKE_MODULE is never trusted unvalidated)", () => {
  it("accepts a valid bare package specifier", () => {
    expect(validateSmokeModuleSpecifier("@heniek/example-smoke-adapter", REPO_ROOT)).toBe(
      "@heniek/example-smoke-adapter",
    );
    expect(validateSmokeModuleSpecifier("example-smoke-adapter", REPO_ROOT)).toBe(
      "example-smoke-adapter",
    );
  });

  it("accepts a valid path resolving inside the repository root", () => {
    expect(validateSmokeModuleSpecifier("./fixtures/smoke-adapter.mjs", REPO_ROOT)).toBe(
      "./fixtures/smoke-adapter.mjs",
    );
    expect(validateSmokeModuleSpecifier(`${REPO_ROOT}/tools/smoke-adapter.mjs`, REPO_ROOT)).toBe(
      `${REPO_ROOT}/tools/smoke-adapter.mjs`,
    );
  });

  it("rejects an absolute path outside the repository root", () => {
    expect(() => validateSmokeModuleSpecifier("/etc/passwd", REPO_ROOT)).toThrow(
      /HENIEK_CONFORMANCE_SMOKE_MODULE must be either a bare package specifier/,
    );
  });

  it("rejects a `../` escape out of the repository root", () => {
    expect(() => validateSmokeModuleSpecifier("../../../etc/passwd", REPO_ROOT)).toThrow(
      /HENIEK_CONFORMANCE_SMOKE_MODULE must be either a bare package specifier/,
    );
  });

  it("rejects file:/data:/http: URL specifiers", () => {
    for (const specifier of [
      "file:///etc/passwd",
      "data:text/javascript,console.log(1)",
      "http://evil.example/adapter.js",
      "https://evil.example/adapter.js",
    ]) {
      expect(() => validateSmokeModuleSpecifier(specifier, REPO_ROOT)).toThrow(
        /HENIEK_CONFORMANCE_SMOKE_MODULE must be either a bare package specifier/,
      );
    }
  });

  it("never echoes the observed (rejected) value in the thrown error", () => {
    const secretLookingValue = "/etc/shadow-secret-marker-should-not-appear";
    try {
      validateSmokeModuleSpecifier(secretLookingValue, REPO_ROOT);
      throw new Error("expected validateSmokeModuleSpecifier to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(secretLookingValue);
    }
  });
});

describe("readSmokeConfig rejects an invalid HENIEK_CONFORMANCE_SMOKE_MODULE", () => {
  it("throws when the module specifier is neither a bare specifier nor an in-repo path", () => {
    expect(() =>
      readSmokeConfig({
        HENIEK_CONFORMANCE_SMOKE: "1",
        HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE: "none",
        HENIEK_CONFORMANCE_SMOKE_MODULE: "http://evil.example/adapter.js",
      }),
    ).toThrow(/HENIEK_CONFORMANCE_SMOKE_MODULE must be either a bare package specifier/);
  });
});
