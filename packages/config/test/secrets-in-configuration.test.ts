/**
 * Credentials must not travel through configuration, and this is checked at
 * two independent depths (design §5, §7).
 *
 * The *first* line of defence is the restricted-YAML guard: a credential-shaped
 * entry is rejected at parse time, so it never becomes a configuration value at
 * all. The *second* is redaction at every point where a resolved configuration
 * turns into text — the snapshot and the diagnostic table.
 *
 * The second line exists because the first only covers documents that came
 * from YAML. A document assembled in memory (an invocation override built from
 * CLI flags, a test fixture, a future loader) bypasses the parser entirely, so
 * the rendering layer cannot assume its input was already screened. These
 * tests deliberately construct such a document.
 */

import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import {
  type ConfigurationLayerDocument,
  renderConfigurationDiagnostics,
  renderResolvedConfigurationSnapshot,
  resolveConfiguration,
} from "../src/layers/index.js";
import { parseRestrictedYaml } from "../src/yaml/index.js";

/** A syntactically valid GitHub personal access token shape, not a real token. */
const TOKEN_SHAPED_VALUE = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8".slice(0, 36)}`;

function document(
  layer: ConfigurationLayerDocument["layer"],
  values: JsonObject,
): ConfigurationLayerDocument {
  return { layer, values };
}

describe("first line of defence — the YAML guard", () => {
  it("rejects a credential-shaped key before it becomes configuration", () => {
    const result = parseRestrictedYaml("api_key: anything\n", { sourcePath: "/c.yaml" });

    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((entry) => entry.message.includes("looks like a credential")),
    ).toBe(true);
  });

  it("rejects a credential-shaped value under an innocuous key", () => {
    const result = parseRestrictedYaml(`note: ${TOKEN_SHAPED_VALUE}\n`);

    expect(result.ok).toBe(false);
  });

  /**
   * The rejection diagnostic must not itself become the leak. A guard that
   * announced "the value `ghp_…` looks like a credential" would copy the
   * secret straight into whatever log the diagnostic reaches.
   */
  it("does not echo the credential in its own rejection message", () => {
    const result = parseRestrictedYaml(`note: ${TOKEN_SHAPED_VALUE}\n`);

    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.message).not.toContain(TOKEN_SHAPED_VALUE);
    }
  });
});

describe("second line of defence — redaction at render time", () => {
  const resolved = resolveConfiguration({
    documents: [document("invocation-override", { note: TOKEN_SHAPED_VALUE })],
    policy: { rules: [{ kind: "overridable", pointer: "/note" }] },
  });

  it("redacts a credential-shaped value in the snapshot", () => {
    const text = renderResolvedConfigurationSnapshot(resolved);

    expect(text).not.toContain(TOKEN_SHAPED_VALUE);
    expect(text).toContain("[redacted]");
  });

  it("redacts a credential-shaped value in the diagnostic table", () => {
    const text = renderConfigurationDiagnostics(resolved);

    expect(text).not.toContain(TOKEN_SHAPED_VALUE);
    expect(text).toContain("[redacted]");
  });

  it("redacts an overridden value as well as the winning one", () => {
    const withHistory = resolveConfiguration({
      documents: [
        document("codebase", { note: TOKEN_SHAPED_VALUE }),
        document("repository", { note: "harmless" }),
      ],
    });

    expect(renderResolvedConfigurationSnapshot(withHistory)).not.toContain(TOKEN_SHAPED_VALUE);
    expect(renderConfigurationDiagnostics(withHistory)).not.toContain(TOKEN_SHAPED_VALUE);
  });

  /**
   * Diagnostic *messages* are built during the merge, before any renderer
   * runs, so they need their own redaction rather than inheriting the
   * renderer's — a conflict message quotes both the winning and the
   * overridden value verbatim.
   */
  it("redacts values embedded in merge diagnostics themselves", () => {
    const withHistory = resolveConfiguration({
      documents: [
        document("codebase", { note: TOKEN_SHAPED_VALUE }),
        document("repository", { note: "harmless" }),
      ],
    });

    for (const diagnostic of withHistory.diagnostics) {
      expect(diagnostic.message).not.toContain(TOKEN_SHAPED_VALUE);
    }
    expect(withHistory.diagnostics.some((entry) => entry.message.includes("[redacted]"))).toBe(
      true,
    );
  });

  it("redacts a credential nested deep inside the values", () => {
    const nested = resolveConfiguration({
      documents: [document("codebase", { a: { b: { c: [TOKEN_SHAPED_VALUE] } } })],
    });

    expect(renderResolvedConfigurationSnapshot(nested)).not.toContain(TOKEN_SHAPED_VALUE);
  });

  /**
   * Redaction happens on the way *out*, not in place: the resolved values a
   * caller reads programmatically must still be the real ones, or the
   * configuration would be unusable for its actual purpose.
   */
  it("leaves the in-memory resolved value intact", () => {
    expect(resolved.values.note).toBe(TOKEN_SHAPED_VALUE);
  });
});
