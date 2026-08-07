import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import {
  type ConfigurationLayerDocument,
  HENIEK_BUILT_IN_CONFIGURATION_POLICY,
  HENIEK_BUILT_IN_DEFAULTS,
  renderConfigurationDiagnostics,
  renderResolvedConfigurationSnapshot,
  resolveConfiguration,
  toResolvedConfigurationSnapshot,
} from "../src/layers/index.js";

function document(
  layer: ConfigurationLayerDocument["layer"],
  values: JsonObject,
  sourcePath?: string,
): ConfigurationLayerDocument {
  return sourcePath === undefined ? { layer, values } : { layer, sourcePath, values };
}

describe("resolved configuration snapshot", () => {
  /**
   * The property that makes the snapshot usable as a diff target: two
   * resolutions that differ *only* in the order their documents happened to
   * introduce keys must serialise to identical bytes. Written with genuinely
   * different key insertion orders, since `toEqual` on the objects would pass
   * regardless and prove nothing about the serialisation.
   */
  it("is byte-identical for inputs that differ only in key order", () => {
    const first = resolveConfiguration({
      documents: [document("codebase", { zebra: 1, alpha: { y: 2, x: 3 } })],
    });
    const second = resolveConfiguration({
      documents: [document("codebase", { alpha: { x: 3, y: 2 }, zebra: 1 })],
    });

    expect(renderResolvedConfigurationSnapshot(first)).toBe(
      renderResolvedConfigurationSnapshot(second),
    );
  });

  it("sorts keys at every level and ends with a newline", () => {
    const resolved = resolveConfiguration({
      documents: [document("codebase", { b: 1, a: 2 })],
    });
    const text = renderResolvedConfigurationSnapshot(resolved);

    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"diagnostics"')).toBeLessThan(text.indexOf('"layers"'));
    expect(text.indexOf('"layers"')).toBeLessThan(text.indexOf('"provenance"'));
  });

  it("carries the four contract fields", () => {
    const resolved = resolveConfiguration({
      documents: [document("codebase", { a: 1 }, "/c.yaml")],
    });
    const snapshot = toResolvedConfigurationSnapshot(resolved);

    expect(Object.keys(snapshot).sort()).toEqual(["diagnostics", "layers", "provenance", "values"]);
    expect(snapshot.layers).toEqual(["codebase"]);
    expect(snapshot.values).toEqual({ a: 1 });
  });

  it("round-trips through JSON.parse as plain JSON", () => {
    const resolved = resolveConfiguration({
      documents: [HENIEK_BUILT_IN_DEFAULTS],
      policy: HENIEK_BUILT_IN_CONFIGURATION_POLICY,
    });

    expect(JSON.parse(renderResolvedConfigurationSnapshot(resolved))).toEqual(
      toResolvedConfigurationSnapshot(resolved),
    );
  });

  it("includes provenance and diagnostics for a conflicting resolution", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { key: "old" }, "/c.yaml"),
        document("repository", { key: "new" }, "/r.yaml"),
      ],
    });
    const snapshot = toResolvedConfigurationSnapshot(resolved);

    expect(snapshot.provenance).toEqual([
      {
        pointer: "/key",
        layer: "repository",
        sourcePath: "/r.yaml",
        value: "new",
        overridden: [{ layer: "codebase", sourcePath: "/c.yaml", value: "old" }],
      },
    ]);
    expect((snapshot.diagnostics as readonly JsonObject[])[0]?.code).toBe(
      "configuration.value-overridden",
    );
  });
});

describe("diagnostic rendering", () => {
  it("shows the winning value, its layer, and what it overrode", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { key: "old" }, "/c.yaml"),
        document("repository", { key: "new" }, "/r.yaml"),
      ],
    });
    const text = renderConfigurationDiagnostics(resolved);

    expect(text).toContain("/key");
    expect(text).toContain('"new"');
    expect(text).toContain("repository (/r.yaml)");
    expect(text).toContain('overrode "old"');
    expect(text).toContain("codebase (/c.yaml)");
  });

  it("names each policy diagnostic with its severity and code", () => {
    const resolved = resolveConfiguration({
      documents: [
        HENIEK_BUILT_IN_DEFAULTS,
        document("repository", { privacy: { mode: "open" } }, "/r.yaml"),
      ],
      policy: HENIEK_BUILT_IN_CONFIGURATION_POLICY,
    });
    const text = renderConfigurationDiagnostics(resolved);

    expect(text).toContain("error  configuration.privacy-weakening-blocked");
  });

  it("says so plainly when there is nothing to render", () => {
    expect(renderConfigurationDiagnostics(resolveConfiguration({ documents: [] }))).toBe(
      "(no configuration values)\n",
    );
  });

  it("renders a layer with no sourcePath as the bare layer name", () => {
    const resolved = resolveConfiguration({ documents: [document("codebase", { key: 1 })] });

    expect(renderConfigurationDiagnostics(resolved)).toContain("[codebase]");
  });
});
