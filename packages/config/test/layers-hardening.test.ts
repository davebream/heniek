/**
 * Behaviours that only unscreened documents can trigger.
 *
 * The restricted-YAML guard screens documents that came from a *file*, but
 * three of the seven layers routinely do not: `built-in-defaults` is a
 * TypeScript constant, and both `invocation-override` and test fixtures are
 * ordinary JS objects. Such a document can carry things YAML never
 * produces — `undefined`, `NaN`, a `__proto__` key — so the merge cannot
 * assume its input was pre-validated. These tests construct exactly those
 * documents.
 */

import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import {
  type ConfigurationLayerDocument,
  hasBlockingDiagnostics,
  renderResolvedConfigurationSnapshot,
  resolveConfiguration,
} from "../src/layers/index.js";

function document(
  layer: ConfigurationLayerDocument["layer"],
  values: JsonObject,
  sourcePath?: string,
): ConfigurationLayerDocument {
  return sourcePath === undefined ? { layer, values } : { layer, sourcePath, values };
}

/** Builds a document carrying a value the `JsonObject` type forbids but a runtime object can hold. */
function unsafeDocument(
  layer: ConfigurationLayerDocument["layer"],
  values: Record<string, unknown>,
): ConfigurationLayerDocument {
  return { layer, values: values as JsonObject };
}

describe("values with no JSON representation", () => {
  it("prunes an undefined value and reports it as an error", () => {
    const resolved = resolveConfiguration({
      documents: [unsafeDocument("codebase", { kept: 1, broken: undefined })],
    });

    expect(resolved.values).toEqual({ kept: 1 });
    const invalid = resolved.diagnostics.find(
      (entry) => entry.code === "configuration.invalid-value",
    );
    expect(invalid?.severity).toBe("error");
    expect(invalid?.pointer).toBe("/broken");
  });

  it("prunes non-finite numbers", () => {
    const resolved = resolveConfiguration({
      documents: [unsafeDocument("codebase", { nan: Number.NaN, inf: Number.POSITIVE_INFINITY })],
    });

    expect(resolved.values).toEqual({});
    expect(
      resolved.diagnostics.filter((entry) => entry.code === "configuration.invalid-value"),
    ).toHaveLength(2);
  });

  /**
   * The point of pruning: `canonicalJsonStringify` throws on `undefined` and
   * on non-finite numbers by design (`json.ts`). If such a value survived the
   * merge, every snapshot of that configuration would throw instead of
   * rendering — so pruning is what keeps "resolution is total" true.
   */
  it("leaves the resolved configuration serialisable", () => {
    const resolved = resolveConfiguration({
      documents: [unsafeDocument("codebase", { broken: Number.NaN })],
    });

    expect(() => renderResolvedConfigurationSnapshot(resolved)).not.toThrow();
  });

  /**
   * Arrays are atomic everywhere else in this module, so a partially-invalid
   * array is dropped whole rather than compacted — there is no unambiguous
   * way to merge a "partially valid" array against a competing layer's array,
   * and silently shortening one would corrupt positional meaning.
   */
  it("drops an array wholesale when any element is invalid", () => {
    const resolved = resolveConfiguration({
      documents: [unsafeDocument("codebase", { list: [1, Number.NaN, 3] })],
    });

    expect(resolved.values).toEqual({});
  });

  it("keeps a sibling key unaffected by an invalid neighbour", () => {
    const resolved = resolveConfiguration({
      documents: [unsafeDocument("codebase", { nested: { good: "value", bad: undefined } })],
    });

    expect(resolved.values).toEqual({ nested: { good: "value" } });
  });
});

describe("hasBlockingDiagnostics", () => {
  it("is false for a clean resolution", () => {
    const resolved = resolveConfiguration({
      documents: [document("codebase", { key: 1 })],
    });

    expect(hasBlockingDiagnostics(resolved)).toBe(false);
  });

  /**
   * An overridden value is ordinary, expected layering — it is recorded at
   * `info` precisely so that routine layering does not read as a problem.
   */
  it("is false for a merely overridden value", () => {
    const resolved = resolveConfiguration({
      documents: [document("codebase", { key: 1 }), document("repository", { key: 2 })],
    });

    expect(
      resolved.diagnostics.some((entry) => entry.code === "configuration.value-overridden"),
    ).toBe(true);
    expect(hasBlockingDiagnostics(resolved)).toBe(false);
  });

  it("is true when an invocation override was blocked", () => {
    const resolved = resolveConfiguration({
      documents: [document("invocation-override", { key: 1 })],
      policy: { rules: [] },
    });

    expect(hasBlockingDiagnostics(resolved)).toBe(true);
  });

  it("is true when a privacy weakening was blocked", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { privacy: { mode: "confidential" } }),
        document("repository", { privacy: { mode: "open" } }),
      ],
      policy: {
        rules: [
          {
            kind: "ordered-privacy",
            pointer: "/privacy/mode",
            strictestFirst: ["confidential", "internal", "open"],
          },
        ],
      },
    });

    expect(hasBlockingDiagnostics(resolved)).toBe(true);
  });

  /**
   * A clamped hard limit is a warning, not an error: the resolution is
   * usable — the strict value simply held — so it must not block a caller
   * that gates on `hasBlockingDiagnostics`.
   */
  it("is false for a clamped hard limit", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { limits: { workers: 2 } }),
        document("repository", { limits: { workers: 16 } }),
      ],
      policy: { rules: [{ kind: "hard-limit", pointer: "/limits/workers", strictest: "lower" }] },
    });

    expect(hasBlockingDiagnostics(resolved)).toBe(false);
  });
});

describe("a scalar shadowed by a later object", () => {
  /**
   * The type-change direction that leaf provenance cannot express: when a more
   * specific layer replaces a scalar with an object, the scalar's pointer is no
   * longer a leaf, so it owns no provenance record and its loss would otherwise
   * go entirely unreported.
   */
  it("reports the shadowed scalar even though it owns no leaf record", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { section: "scalar" }, "/c.yaml"),
        document("repository", { section: { a: 1 } }, "/r.yaml"),
      ],
    });

    expect(resolved.provenance.map((record) => record.pointer)).toEqual(["/section/a"]);

    const shadowed = resolved.diagnostics.find((entry) => entry.pointer === "/section");
    expect(shadowed).toBeDefined();
    expect(shadowed?.message).toContain("/c.yaml");
  });

  it("says nothing when no layer put a scalar there", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { section: { a: 1 } }),
        document("repository", { section: { b: 2 } }),
      ],
    });

    expect(resolved.diagnostics.filter((entry) => entry.pointer === "/section")).toEqual([]);
  });

  /**
   * A blocked invocation override contributed nothing to the merged document,
   * so it must not be reported as having shadowed anything — that would
   * describe an effect the dropped value never had.
   */
  it("ignores a scalar from a blocked invocation override", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { section: { a: 1 } }),
        document("invocation-override", { section: "flag" }),
      ],
      policy: { rules: [] },
    });

    expect(resolved.values).toEqual({ section: { a: 1 } });
    expect(
      resolved.diagnostics.some(
        (entry) => entry.pointer === "/section" && entry.code === "configuration.value-overridden",
      ),
    ).toBe(false);
  });
});
