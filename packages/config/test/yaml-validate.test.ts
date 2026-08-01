import { describe, expect, it } from "vitest";
import { loadRestrictedYamlDocument } from "../src/yaml/validate.js";

interface Profile {
  readonly name: string;
  readonly count: number;
}

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    count: { type: "integer", minimum: 0 },
  },
  required: ["name", "count"],
  additionalProperties: false,
} as const;

describe("loadRestrictedYamlDocument", () => {
  it("accepts a document that satisfies both the restricted-YAML subset and the schema", () => {
    const result = loadRestrictedYamlDocument<Profile>("name: alice\ncount: 3\n", PROFILE_SCHEMA);
    expect(result).toEqual({
      ok: true,
      value: { name: "alice", count: 3 },
      diagnostics: [],
    });
  });

  it("maps a missing-required-property Ajv error to configuration.schema-violation at the root pointer", () => {
    const result = loadRestrictedYamlDocument<Profile>("name: alice\n", PROFILE_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "configuration.schema-violation",
        severity: "error",
        pointer: "",
      }),
    ]);
  });

  it("maps a wrong-type Ajv error to configuration.schema-violation with the instance pointer", () => {
    const result = loadRestrictedYamlDocument<Profile>(
      "name: alice\ncount: not-a-number\n",
      PROFILE_SCHEMA,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "configuration.schema-violation",
        severity: "error",
        pointer: "/count",
      }),
    ]);
  });

  it("reports every Ajv violation when more than one property is invalid (allErrors: true)", () => {
    const result = loadRestrictedYamlDocument<Profile>(
      "name: 5\ncount: not-a-number\n",
      PROFILE_SCHEMA,
    );
    expect(result.ok).toBe(false);
    const pointers = result.diagnostics.map((d) => d.pointer).sort();
    expect(pointers).toEqual(["/count", "/name"]);
  });

  /**
   * Test-strengthening: `compareDiagnostics`' pointer tiebreak is exercised
   * by the test above, but that test re-sorts the pointers before comparing
   * them — a `compareDiagnostics` whose pointer tiebreak silently regressed
   * (e.g. producing `["/name", "/count"]`) would still pass it. Both
   * diagnostics here share the same code and severity, so pointer is the
   * *only* thing that can be discriminating the emitted order; asserted
   * directly, with no re-sort, so a broken tiebreak cannot pass silently.
   */
  it("emits schema-violation diagnostics in compareDiagnostics' pointer order directly, without a re-sort", () => {
    const result = loadRestrictedYamlDocument<Profile>(
      "name: 5\ncount: not-a-number\n",
      PROFILE_SCHEMA,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "configuration.schema-violation",
      "configuration.schema-violation",
    ]);
    expect(result.diagnostics.map((d) => d.pointer)).toEqual(["/count", "/name"]);
  });

  it("short-circuits before Ajv runs when restricted-YAML parsing itself fails", () => {
    const result = loadRestrictedYamlDocument<Profile>("password: hunter2\n", PROFILE_SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "yaml.sensitive-value-not-allowed" }),
    ]);
    // No schema-violation diagnostic layered on top of the YAML-level failure.
    expect(result.diagnostics.some((d) => d.code === "configuration.schema-violation")).toBe(false);
  });

  it("attaches sourcePath to a schema-violation diagnostic when provided", () => {
    const result = loadRestrictedYamlDocument<Profile>("name: alice\n", PROFILE_SCHEMA, {
      sourcePath: "config/profiles/opus-planner.yaml",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.sourcePath).toBe("config/profiles/opus-planner.yaml");
  });

  it("rejects an additional property not declared in the schema", () => {
    const result = loadRestrictedYamlDocument<Profile>(
      "name: alice\ncount: 1\nextra: true\n",
      PROFILE_SCHEMA,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("configuration.schema-violation");
  });

  it("carries forward restricted-YAML warnings (e.g. ambiguous-scalar) alongside a passing schema validation", () => {
    const schema = {
      type: "object",
      properties: { flag: { type: "string" } },
      required: ["flag"],
    } as const;
    const result = loadRestrictedYamlDocument<{ flag: string }>("flag: yes\n", schema);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "yaml.ambiguous-scalar", severity: "warning" }),
    ]);
  });

  // C4: an Ajv singleton throws `schema with key or id "..." already exists`
  // on the *second* `ajv.compile` of a distinct object literal sharing an
  // `$id` — the identity-keyed cache alone cannot prevent this, since two
  // distinct object literals are two distinct cache keys.
  describe("C4: Ajv $id / schema-compile robustness", () => {
    it("the same $id-bearing schema passed twice as two distinct object literals works both times", () => {
      const schemaA = {
        $id: "https://heniek.example/schemas/c4-profile",
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      } as const;
      const schemaB = {
        $id: "https://heniek.example/schemas/c4-profile",
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      } as const;

      const first = loadRestrictedYamlDocument<{ name: string }>("name: alice\n", schemaA);
      expect(first).toEqual({ ok: true, value: { name: "alice" }, diagnostics: [] });

      // A second, distinct object literal with the identical `$id` must not
      // throw Ajv's duplicate-`$id` compile error.
      expect(() =>
        loadRestrictedYamlDocument<{ name: string }>("name: bob\n", schemaB),
      ).not.toThrow();
      const second = loadRestrictedYamlDocument<{ name: string }>("name: bob\n", schemaB);
      expect(second).toEqual({ ok: true, value: { name: "bob" }, diagnostics: [] });
    });

    it("a schema with an unknown keyword yields a diagnostic rather than throwing out of loadRestrictedYamlDocument", () => {
      const invalidSchema = {
        type: "object",
        // `strict: true` rejects an unrecognised keyword at compile time —
        // this must surface as a diagnostic, not an uncaught Ajv exception.
        thisKeywordDoesNotExist: true,
      } as const;

      expect(() => loadRestrictedYamlDocument("name: alice\n", invalidSchema)).not.toThrow();
      const result = loadRestrictedYamlDocument("name: alice\n", invalidSchema);
      expect(result.ok).toBe(false);
      // A distinct code from `configuration.schema-violation` — "the schema
      // itself is broken" is a different failure than "the document doesn't
      // satisfy an otherwise-valid schema", and callers may want to react
      // differently (e.g. treat the former as a programming error).
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: "configuration.schema-invalid", severity: "error" }),
      ]);
    });

    // M2: two *distinct* schema bodies (not just two literal copies of the
    // same body, as the getSchema-reuse test above already covers) sharing
    // an `$id` still must not throw — `loadRestrictedYamlDocument` stays
    // total either way, whether that means silently reusing the
    // first-registered validator (per `compile`'s getSchema-first strategy)
    // or reporting a `configuration.schema-invalid` diagnostic.
    it("two distinct schema bodies sharing an $id do not throw — loadRestrictedYamlDocument stays total (M2)", () => {
      const schemaA = {
        $id: "https://heniek.example/schemas/m2-duplicate-id",
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      } as const;
      const schemaB = {
        $id: "https://heniek.example/schemas/m2-duplicate-id",
        type: "object",
        properties: { b: { type: "string" } },
        required: ["b"],
        additionalProperties: false,
      } as const;

      const first = loadRestrictedYamlDocument("a: hi\n", schemaA);
      expect(first.ok).toBe(true);

      expect(() => loadRestrictedYamlDocument("b: hi\n", schemaB)).not.toThrow();
      const second = loadRestrictedYamlDocument("b: hi\n", schemaB);
      expect(typeof second.ok).toBe("boolean");
    });
  });

  // D2: schema-violation diagnostics resolve back to a source position via
  // the retained Document + LineCounter.
  describe("D2: schema-violation diagnostics carry a resolved position", () => {
    it("resolves a wrong-type violation to the exact line/column of the offending scalar", () => {
      const result = loadRestrictedYamlDocument<Profile>(
        "name: alice\ncount: not-a-number\n",
        PROFILE_SCHEMA,
      );
      expect(result.ok).toBe(false);
      const diagnostic = result.diagnostics.find((d) => d.pointer === "/count");
      expect(diagnostic).toBeDefined();
      expect(diagnostic?.line).toBe(2);
      expect(diagnostic?.column).toBe(8);
    });

    it("resolves a root-pointer violation to the document's own start position", () => {
      const result = loadRestrictedYamlDocument<Profile>("name: alice\n", PROFILE_SCHEMA);
      expect(result.ok).toBe(false);
      const diagnostic = result.diagnostics.find((d) => d.pointer === "");
      expect(diagnostic).toBeDefined();
      expect(diagnostic?.line).toBe(1);
      expect(diagnostic?.column).toBe(1);
    });

    it("falls back to a pointer-only diagnostic (no fabricated position) when the pointer cannot resolve to a node", () => {
      // An empty source parses to JSON `null` via the accepted-empty-document
      // path, which never retains a composed `Document` at all — there is no
      // node position `loadRestrictedYamlDocument` could resolve `""` to.
      const schema = { type: "object" } as const;
      const result = loadRestrictedYamlDocument("", schema);
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: "configuration.schema-violation", pointer: "" }),
      ]);
      expect(result.diagnostics[0]?.line).toBeUndefined();
      expect(result.diagnostics[0]?.column).toBeUndefined();
    });
  });
});
