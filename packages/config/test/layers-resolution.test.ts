import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import {
  CONFIGURATION_LAYERS,
  type ConfigurationLayerDocument,
  resolveConfiguration,
  sortConfigurationDocuments,
} from "../src/layers/index.js";

function document(
  layer: ConfigurationLayerDocument["layer"],
  values: JsonObject,
  sourcePath?: string,
): ConfigurationLayerDocument {
  return sourcePath === undefined ? { layer, values } : { layer, sourcePath, values };
}

/** Provenance lookup by pointer, so assertions do not depend on array position. */
function at(resolved: ReturnType<typeof resolveConfiguration>, pointer: string) {
  return resolved.provenance.find((record) => record.pointer === pointer);
}

describe("layer precedence", () => {
  it("orders all seven layers least-specific first", () => {
    expect([...CONFIGURATION_LAYERS]).toEqual([
      "built-in-defaults",
      "global-defaults",
      "codebase",
      "repository",
      "pipeline-template",
      "profile-or-stage",
      "invocation-override",
    ]);
  });

  /**
   * The precedence guarantee stated end-to-end: every layer beats every layer
   * before it. Written as a fold over the whole ordering rather than as one
   * hand-picked pair so that inserting a layer in the middle of
   * `CONFIGURATION_LAYERS` cannot leave a stale, still-passing test.
   */
  it("lets each layer override every less specific layer", () => {
    for (let index = 1; index < CONFIGURATION_LAYERS.length; index += 1) {
      const lower = CONFIGURATION_LAYERS[index - 1] as ConfigurationLayerDocument["layer"];
      const higher = CONFIGURATION_LAYERS[index] as ConfigurationLayerDocument["layer"];
      const resolved = resolveConfiguration({
        documents: [document(lower, { key: "lower" }), document(higher, { key: "higher" })],
        policy: { rules: [{ kind: "overridable", pointer: "/key" }] },
      });

      expect(resolved.values.key).toBe("higher");
      expect(at(resolved, "/key")?.layer).toBe(higher);
    }
  });

  it("does not depend on the caller having sorted the documents", () => {
    const sorted = resolveConfiguration({
      documents: [document("codebase", { key: "low" }), document("repository", { key: "high" })],
    });
    const shuffled = resolveConfiguration({
      documents: [document("repository", { key: "high" }), document("codebase", { key: "low" })],
    });

    expect(shuffled.values).toEqual(sorted.values);
    expect(shuffled.values.key).toBe("high");
  });

  /**
   * Several documents legitimately share a layer (several repositories,
   * several stage settings). Their relative order is the caller's — it carries
   * real meaning — so the sort must be stable rather than merely correct on
   * layer rank.
   */
  it("preserves caller order within a single layer", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("repository", { key: "first" }, "/a.yaml"),
        document("repository", { key: "second" }, "/b.yaml"),
      ],
    });

    expect(resolved.values.key).toBe("second");
    expect(at(resolved, "/key")?.sourcePath).toBe("/b.yaml");
  });

  it("sorts documents by rank without reordering equal-ranked entries", () => {
    const documents = [
      document("invocation-override", {}, "/override.yaml"),
      document("repository", {}, "/first.yaml"),
      document("repository", {}, "/second.yaml"),
      document("built-in-defaults", {}),
    ];

    expect(sortConfigurationDocuments(documents).map((entry) => entry.sourcePath)).toEqual([
      undefined,
      "/first.yaml",
      "/second.yaml",
      "/override.yaml",
    ]);
  });
});

describe("merge semantics", () => {
  it("merges objects key-wise across layers", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { nested: { kept: 1, replaced: "old" } }),
        document("repository", { nested: { replaced: "new" } }),
      ],
    });

    expect(resolved.values).toEqual({ nested: { kept: 1, replaced: "new" } });
  });

  /**
   * Arrays are atomic by decision (design §4). The temptation is element-wise
   * merging; the reason not to is that it makes "which layer produced this
   * value" unanswerable, and answering that is AC2's whole point.
   */
  it("replaces arrays wholesale rather than merging element-wise", () => {
    const resolved = resolveConfiguration({
      documents: [document("codebase", { list: [1, 2, 3] }), document("repository", { list: [9] })],
    });

    expect(resolved.values.list).toEqual([9]);
    expect(at(resolved, "/list")?.overridden).toEqual([{ layer: "codebase", value: [1, 2, 3] }]);
  });

  it("treats null as a value, not a deletion marker", () => {
    const resolved = resolveConfiguration({
      documents: [document("codebase", { key: "set" }), document("repository", { key: null })],
    });

    expect(resolved.values.key).toBeNull();
    expect(at(resolved, "/key")?.value).toBeNull();
  });

  it("replaces a subtree with a scalar when a more specific layer says so", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { section: { a: 1, b: 2 } }),
        document("repository", { section: "collapsed" }),
      ],
    });

    expect(resolved.values.section).toBe("collapsed");
    expect(at(resolved, "/section")?.value).toBe("collapsed");
    expect(at(resolved, "/section/a")).toBeUndefined();
  });

  it("replaces a scalar with a subtree when a more specific layer says so", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { section: "scalar" }),
        document("repository", { section: { a: 1 } }),
      ],
    });

    expect(resolved.values.section).toEqual({ a: 1 });
    expect(at(resolved, "/section/a")?.value).toBe(1);
  });

  /**
   * A document carrying an own `__proto__` key reaches the merge unscreened:
   * the restricted-YAML guard rejects reserved key names, but it only runs on
   * file-sourced YAML — the built-in defaults and a programmatically built
   * invocation override never pass through it. With an `Object.prototype`-rooted
   * accumulator, `merged["__proto__"] = ...` would invoke the inherited setter
   * and reassign the accumulator's prototype instead of creating a property.
   */
  it("treats __proto__ as an ordinary key without polluting any prototype", () => {
    const polluted = JSON.parse('{"__proto__": {"polluted": true}}') as JsonObject;
    const resolved = resolveConfiguration({ documents: [document("codebase", polluted)] });

    const injected = Object.getOwnPropertyDescriptor(polluted, "__proto__")?.value;

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // The key survived as ordinary data rather than being swallowed by a setter…
    expect(Object.hasOwn(resolved.values, "__proto__")).toBe(true);
    // …and it did not become the resolved object's prototype.
    expect(Object.getPrototypeOf(resolved.values)).not.toBe(injected);
  });

  it("merges a __proto__ subtree key-wise like any other key", () => {
    const base = JSON.parse('{"__proto__": {"kept": 1}}') as JsonObject;
    const over = JSON.parse('{"__proto__": {"added": 2}}') as JsonObject;
    const resolved = resolveConfiguration({
      documents: [document("codebase", base), document("repository", over)],
    });

    expect(Object.getOwnPropertyDescriptor(resolved.values, "__proto__")?.value).toEqual({
      kept: 1,
      added: 2,
    });
    expect(({} as Record<string, unknown>).kept).toBeUndefined();
  });

  it("escapes pointer segments containing / and ~", () => {
    const resolved = resolveConfiguration({
      documents: [document("codebase", { "a/b": { "c~d": 1 } })],
    });

    expect(at(resolved, "/a~1b/c~0d")?.value).toBe(1);
  });
});

describe("provenance", () => {
  it("records the winning layer, value, and every overridden layer in order", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("built-in-defaults", { key: "default" }),
        document("codebase", { key: "codebase" }, "/codebase.yaml"),
        document("repository", { key: "repository" }, "/repo.yaml"),
      ],
    });

    expect(at(resolved, "/key")).toEqual({
      pointer: "/key",
      layer: "repository",
      sourcePath: "/repo.yaml",
      value: "repository",
      overridden: [
        { layer: "built-in-defaults", value: "default" },
        { layer: "codebase", sourcePath: "/codebase.yaml", value: "codebase" },
      ],
    });
  });

  /**
   * `exactOptionalPropertyTypes` makes an explicit `undefined` distinct from
   * an absent property, and the distinction is user-visible here: an in-memory
   * document has no path to show, so `sourcePath` must be absent rather than
   * present-and-undefined.
   */
  it("omits sourcePath entirely for in-memory documents", () => {
    const resolved = resolveConfiguration({ documents: [document("codebase", { key: 1 })] });

    expect("sourcePath" in (at(resolved, "/key") ?? {})).toBe(false);
  });

  it("emits a value-overridden info only when the overridden value differs", () => {
    const conflicting = resolveConfiguration({
      documents: [document("codebase", { key: "a" }), document("repository", { key: "b" })],
    });
    const agreeing = resolveConfiguration({
      documents: [document("codebase", { key: "same" }), document("repository", { key: "same" })],
    });

    const conflict = conflicting.diagnostics.find(
      (entry) => entry.code === "configuration.value-overridden",
    );
    expect(conflict?.severity).toBe("info");
    expect(conflict?.message).toContain("codebase");
    expect(conflict?.message).toContain("repository");
    expect(conflict?.message).toContain('"a"');
    expect(conflict?.message).toContain('"b"');

    expect(
      agreeing.diagnostics.filter((entry) => entry.code === "configuration.value-overridden"),
    ).toEqual([]);
  });

  it("sorts provenance by pointer so equivalent inputs compare equal", () => {
    const resolved = resolveConfiguration({
      documents: [document("codebase", { zebra: 1, alpha: 2, middle: 3 })],
    });

    expect(resolved.provenance.map((record) => record.pointer)).toEqual([
      "/alpha",
      "/middle",
      "/zebra",
    ]);
  });

  it("lists only the layers that actually contributed, in precedence order", () => {
    const resolved = resolveConfiguration({
      documents: [document("repository", { a: 1 }), document("built-in-defaults", { b: 2 })],
    });

    expect(resolved.layers).toEqual(["built-in-defaults", "repository"]);
  });
});

describe("freezing", () => {
  it("deep-freezes the resolved configuration", () => {
    const resolved = resolveConfiguration({
      documents: [document("codebase", { nested: { list: [1] } })],
    });

    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.values)).toBe(true);
    expect(Object.isFrozen(resolved.values.nested)).toBe(true);
    expect(Object.isFrozen(resolved.provenance)).toBe(true);
  });

  /**
   * Freezing must not be achieved by handing back the caller's own object:
   * a caller that kept a reference to the document it passed in would then
   * find its own literal frozen underneath it.
   */
  it("does not freeze the caller's input documents", () => {
    const values: JsonObject = { nested: { a: 1 } };
    resolveConfiguration({ documents: [document("codebase", values)] });

    expect(Object.isFrozen(values)).toBe(false);
  });
});

describe("determinism", () => {
  it("produces deep-equal output for the same input, repeatedly", () => {
    const documents = [
      document("built-in-defaults", { a: { b: 1 }, list: [1, 2] }),
      document("repository", { a: { c: 2 } }, "/repo.yaml"),
    ];

    expect(resolveConfiguration({ documents })).toEqual(resolveConfiguration({ documents }));
  });

  it("resolves an empty document set to an empty configuration", () => {
    const resolved = resolveConfiguration({ documents: [] });

    expect(resolved.values).toEqual({});
    expect(resolved.provenance).toEqual([]);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.layers).toEqual([]);
  });
});
