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
});
