import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";
import {
  type ConfigurationLayerDocument,
  type ConfigurationPolicy,
  HENIEK_BUILT_IN_CONFIGURATION_POLICY,
  HENIEK_BUILT_IN_DEFAULTS,
  hardLimitMagnitude,
  privacyRank,
  resolveConfiguration,
} from "../src/layers/index.js";

function document(
  layer: ConfigurationLayerDocument["layer"],
  values: JsonObject,
  sourcePath?: string,
): ConfigurationLayerDocument {
  return sourcePath === undefined ? { layer, values } : { layer, sourcePath, values };
}

function codeOf(
  resolved: ReturnType<typeof resolveConfiguration>,
  code: string,
): ReturnType<typeof resolveConfiguration>["diagnostics"][number] | undefined {
  return resolved.diagnostics.find((entry) => entry.code === code);
}

const LIMIT_POLICY: ConfigurationPolicy = {
  rules: [{ kind: "hard-limit", pointer: "/limits/workers", strictest: "lower" }],
};

describe("hard limits — strictest wins", () => {
  it("keeps the stricter value when a more specific layer relaxes it", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { limits: { workers: 2 } }, "/codebase.yaml"),
        document("repository", { limits: { workers: 16 } }, "/repo.yaml"),
      ],
      policy: LIMIT_POLICY,
    });

    expect((resolved.values.limits as JsonObject).workers).toBe(2);

    const clamped = codeOf(resolved, "configuration.hard-limit-clamped");
    expect(clamped?.severity).toBe("warning");
    expect(clamped?.pointer).toBe("/limits/workers");
    expect(clamped?.message).toContain("/codebase.yaml");
    expect(clamped?.message).toContain("16");
  });

  /**
   * The credited layer must be the one that actually supplied the surviving
   * value. If provenance still named the relaxing layer, the resolved value
   * and its stated source would disagree — which is worse than no provenance
   * at all, because it reads as authoritative.
   */
  it("credits the layer the surviving value came from", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { limits: { workers: 2 } }, "/codebase.yaml"),
        document("repository", { limits: { workers: 16 } }, "/repo.yaml"),
      ],
      policy: LIMIT_POLICY,
    });

    const record = resolved.provenance.find((entry) => entry.pointer === "/limits/workers");
    expect(record?.layer).toBe("codebase");
    expect(record?.value).toBe(2);
    expect(record?.overridden).toEqual([
      { layer: "repository", sourcePath: "/repo.yaml", value: 16 },
    ]);
  });

  it("applies a tightening silently, with no clamp warning", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { limits: { workers: 16 } }),
        document("repository", { limits: { workers: 2 } }),
      ],
      policy: LIMIT_POLICY,
    });

    expect((resolved.values.limits as JsonObject).workers).toBe(2);
    expect(codeOf(resolved, "configuration.hard-limit-clamped")).toBeUndefined();
  });

  it("honours strictest: higher for a floor-style limit", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { limits: { minimum: 10 } }),
        document("repository", { limits: { minimum: 1 } }),
      ],
      policy: { rules: [{ kind: "hard-limit", pointer: "/limits/minimum", strictest: "higher" }] },
    });

    expect((resolved.values.limits as JsonObject).minimum).toBe(10);
    expect(codeOf(resolved, "configuration.hard-limit-clamped")?.severity).toBe("warning");
  });

  it("takes the strictest value from any layer, not just the two most specific", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("built-in-defaults", { limits: { workers: 1 } }),
        document("codebase", { limits: { workers: 8 } }),
        document("repository", { limits: { workers: 4 } }),
      ],
      policy: LIMIT_POLICY,
    });

    expect((resolved.values.limits as JsonObject).workers).toBe(1);
  });
});

describe("hard limits — duration values", () => {
  /**
   * The spec writes `max_pipeline_duration: 4h`. Compared as strings,
   * `"30m" < "4h"` — the lexical order is the *opposite* of the real one for
   * these two, so a string comparison would silently pick the looser limit
   * exactly when a stage tried to tighten it.
   */
  it("compares durations by magnitude, not lexically", () => {
    expect(hardLimitMagnitude("30m")).toBeLessThan(hardLimitMagnitude("4h") as number);
    expect("30m" < "4h").toBe(true);
  });

  it("parses each supported duration unit", () => {
    expect(hardLimitMagnitude("500ms")).toBe(500);
    expect(hardLimitMagnitude("2s")).toBe(2_000);
    expect(hardLimitMagnitude("3m")).toBe(180_000);
    expect(hardLimitMagnitude("4h")).toBe(14_400_000);
    expect(hardLimitMagnitude("1d")).toBe(86_400_000);
  });

  it("returns undefined for values with no defensible ordering", () => {
    expect(hardLimitMagnitude(true)).toBeUndefined();
    expect(hardLimitMagnitude("soon")).toBeUndefined();
    expect(hardLimitMagnitude("4 h")).toBeUndefined();
    expect(hardLimitMagnitude(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(hardLimitMagnitude(null)).toBeUndefined();
  });

  it("clamps a relaxed duration back to the stricter one", () => {
    const resolved = resolveConfiguration({
      documents: [
        HENIEK_BUILT_IN_DEFAULTS,
        document("profile-or-stage", { limits: { max_pipeline_duration: "30m" } }),
        document("invocation-override", { limits: { max_pipeline_duration: "12h" } }),
      ],
      policy: HENIEK_BUILT_IN_CONFIGURATION_POLICY,
    });

    expect((resolved.values.limits as JsonObject).max_pipeline_duration).toBe("30m");
    expect(codeOf(resolved, "configuration.hard-limit-clamped")?.severity).toBe("warning");
  });

  /**
   * An uncomparable value must not become the effective limit. Letting it
   * through would turn "the strictest hard limit wins" into "any unparseable
   * string disables the limit" — the exact bypass the rule guards against, and
   * reachable from a programmatically built `invocation-override` document
   * that never passed the restricted-YAML guard.
   */
  it("ignores an incomparable hard limit and keeps the strictest comparable one", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { limits: { workers: 2 } }),
        document("repository", { limits: { workers: "as many as possible" } }),
      ],
      policy: LIMIT_POLICY,
    });

    const incomparable = codeOf(resolved, "configuration.hard-limit-incomparable");
    expect(incomparable?.severity).toBe("warning");
    expect(incomparable?.pointer).toBe("/limits/workers");
    expect((resolved.values.limits as JsonObject).workers).toBe(2);
  });

  /**
   * An incomparable value is neither a tightening nor a loosening, so it must
   * not be reported as an attempted relaxation — that would be a misleading
   * warning naming a comparison that never happened.
   */
  it("does not report a clamp when the most specific value was merely incomparable", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { limits: { workers: 2 } }),
        document("repository", { limits: { workers: "as many as possible" } }),
      ],
      policy: LIMIT_POLICY,
    });

    expect(codeOf(resolved, "configuration.hard-limit-clamped")).toBeUndefined();
  });

  it("keeps an incomparable value when no layer supplied a comparable one", () => {
    const resolved = resolveConfiguration({
      documents: [document("repository", { limits: { workers: "unbounded" } })],
      policy: LIMIT_POLICY,
    });

    expect((resolved.values.limits as JsonObject).workers).toBe("unbounded");
    expect(codeOf(resolved, "configuration.hard-limit-incomparable")).toBeDefined();
  });
});

describe("privacy — tightened, never silently weakened", () => {
  const PRIVACY_POLICY: ConfigurationPolicy = {
    rules: [
      {
        kind: "ordered-privacy",
        pointer: "/privacy/mode",
        strictestFirst: ["confidential", "internal", "open"],
      },
    ],
  };

  it("blocks a weakening and reports it as an error", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { privacy: { mode: "confidential" } }, "/codebase.yaml"),
        document("repository", { privacy: { mode: "open" } }, "/repo.yaml"),
      ],
      policy: PRIVACY_POLICY,
    });

    expect((resolved.values.privacy as JsonObject).mode).toBe("confidential");

    const blocked = codeOf(resolved, "configuration.privacy-weakening-blocked");
    expect(blocked?.severity).toBe("error");
    expect(blocked?.message).toContain("/repo.yaml");
    expect(blocked?.message).toContain("open");
  });

  /**
   * "Never *silently* weakened" is two obligations, not one: the value must
   * not change, *and* the attempt must be reported. A test that only checked
   * the value would pass against an implementation that dropped the attempt
   * on the floor.
   */
  it("both keeps the value and reports the attempt", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { privacy: { mode: "confidential" } }),
        document("repository", { privacy: { mode: "internal" } }),
      ],
      policy: PRIVACY_POLICY,
    });

    expect((resolved.values.privacy as JsonObject).mode).toBe("confidential");
    expect(codeOf(resolved, "configuration.privacy-weakening-blocked")).toBeDefined();
  });

  it("allows a tightening silently", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { privacy: { mode: "open" } }),
        document("repository", { privacy: { mode: "confidential" } }),
      ],
      policy: PRIVACY_POLICY,
    });

    expect((resolved.values.privacy as JsonObject).mode).toBe("confidential");
    expect(codeOf(resolved, "configuration.privacy-weakening-blocked")).toBeUndefined();
  });

  it("ranks boolean privacy switches with false as the strictest", () => {
    expect(privacyRank(false, [false, true])).toBe(0);
    expect(privacyRank(true, [false, true])).toBe(1);
    expect(privacyRank("maybe", [false, true])).toBeUndefined();
  });

  /**
   * An unrecognised privacy value has no place in the strictness order, so it
   * cannot be shown to be a tightening — and a value that cannot be shown to
   * be a tightening must not silently become the effective privacy setting.
   * It is ignored in favour of the strictest recognised value and reported;
   * reporting it as a *weakening* would be wrong, since no comparison was
   * possible.
   */
  it("ignores an unrecognised privacy value rather than letting it take effect", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("codebase", { privacy: { mode: "confidential" } }),
        document("repository", { privacy: { mode: "unheard-of" } }),
      ],
      policy: PRIVACY_POLICY,
    });

    expect((resolved.values.privacy as JsonObject).mode).toBe("confidential");
    expect(codeOf(resolved, "configuration.privacy-incomparable")?.severity).toBe("warning");
    expect(codeOf(resolved, "configuration.privacy-weakening-blocked")).toBeUndefined();
  });

  it("blocks every privacy pointer in the built-in policy", () => {
    const weakened: JsonObject = {
      mode: "open",
      telemetry: "anonymous",
      crash_reports: "upload",
      include_repository_content: true,
      include_prompts: true,
      include_paths: true,
      diagnostics_export: "automatic",
    };
    const resolved = resolveConfiguration({
      documents: [HENIEK_BUILT_IN_DEFAULTS, document("repository", { privacy: weakened })],
      policy: HENIEK_BUILT_IN_CONFIGURATION_POLICY,
    });

    expect(resolved.values.privacy).toEqual({
      mode: "confidential",
      telemetry: "off",
      crash_reports: "local",
      include_repository_content: false,
      include_prompts: false,
      include_paths: false,
      diagnostics_export: "explicit",
    });
    expect(
      resolved.diagnostics.filter(
        (entry) => entry.code === "configuration.privacy-weakening-blocked",
      ),
    ).toHaveLength(7);
  });
});

describe("invocation overrides — overridable only", () => {
  it("drops an override of a pointer that was not declared overridable", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("repository", { guarded: "from-repo" }),
        document("invocation-override", { guarded: "from-flag" }, "cli"),
      ],
      policy: { rules: [] },
    });

    expect(resolved.values.guarded).toBe("from-repo");

    const dropped = codeOf(resolved, "configuration.override-not-permitted");
    expect(dropped?.severity).toBe("error");
    expect(dropped?.pointer).toBe("/guarded");
  });

  it("lets an override through once the pointer is declared overridable", () => {
    const resolved = resolveConfiguration({
      documents: [
        document("repository", { tunable: "from-repo" }),
        document("invocation-override", { tunable: "from-flag" }),
      ],
      policy: { rules: [{ kind: "overridable", pointer: "/tunable" }] },
    });

    expect(resolved.values.tunable).toBe("from-flag");
    expect(codeOf(resolved, "configuration.override-not-permitted")).toBeUndefined();
  });

  /**
   * Default deny taken to its conclusion: when the override was the *only*
   * source of a pointer, dropping it must remove the pointer entirely rather
   * than leave it present with an unvetted value.
   */
  it("removes a pointer supplied only by an impermissible override", () => {
    const resolved = resolveConfiguration({
      documents: [document("invocation-override", { injected: "value" })],
      policy: { rules: [] },
    });

    expect(resolved.values).toEqual({});
    expect(resolved.provenance).toEqual([]);
    expect(codeOf(resolved, "configuration.override-not-permitted")).toBeDefined();
  });

  it("keeps the enclosing object when its only leaf was dropped", () => {
    const resolved = resolveConfiguration({
      documents: [document("invocation-override", { section: { injected: "value" } })],
      policy: { rules: [] },
    });

    expect(resolved.values).toEqual({ section: {} });
  });

  it("refuses an invocation override of a privacy pointer", () => {
    const resolved = resolveConfiguration({
      documents: [
        HENIEK_BUILT_IN_DEFAULTS,
        document("invocation-override", { privacy: { mode: "open" } }, "cli"),
      ],
      policy: HENIEK_BUILT_IN_CONFIGURATION_POLICY,
    });

    expect((resolved.values.privacy as JsonObject).mode).toBe("confidential");
    expect(codeOf(resolved, "configuration.override-not-permitted")?.pointer).toBe("/privacy/mode");
  });

  it("permits an invocation override of a limit, still subject to strictest-wins", () => {
    const tightened = resolveConfiguration({
      documents: [
        HENIEK_BUILT_IN_DEFAULTS,
        document("invocation-override", { limits: { max_concurrent_workers: 1 } }),
      ],
      policy: HENIEK_BUILT_IN_CONFIGURATION_POLICY,
    });
    const relaxed = resolveConfiguration({
      documents: [
        HENIEK_BUILT_IN_DEFAULTS,
        document("invocation-override", { limits: { max_concurrent_workers: 64 } }),
      ],
      policy: HENIEK_BUILT_IN_CONFIGURATION_POLICY,
    });

    expect((tightened.values.limits as JsonObject).max_concurrent_workers).toBe(1);
    expect((relaxed.values.limits as JsonObject).max_concurrent_workers).toBe(4);
    expect(codeOf(relaxed, "configuration.hard-limit-clamped")).toBeDefined();
  });
});

describe("built-in defaults", () => {
  it("resolves to the spec's stated defaults when nothing else is supplied", () => {
    const resolved = resolveConfiguration({
      documents: [HENIEK_BUILT_IN_DEFAULTS],
      policy: HENIEK_BUILT_IN_CONFIGURATION_POLICY,
    });

    expect(resolved.values).toEqual({
      limits: {
        max_pipeline_duration: "4h",
        max_concurrent_workers: 4,
        max_repair_attempts: 3,
        max_graph_revisions: 5,
      },
      privacy: {
        mode: "confidential",
        telemetry: "off",
        crash_reports: "local",
        include_repository_content: false,
        include_prompts: false,
        include_paths: false,
        diagnostics_export: "explicit",
      },
    });
    expect(resolved.diagnostics).toEqual([]);
  });

  it("carries no sourcePath, since it comes from code rather than a file", () => {
    expect("sourcePath" in HENIEK_BUILT_IN_DEFAULTS).toBe(false);
  });
});
