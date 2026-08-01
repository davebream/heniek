import { describe, expect, it } from "vitest";
import { parseRestrictedYaml } from "../src/yaml/restricted.js";

/** Asserts `result` failed with exactly one diagnostic matching `code`/`line`/`column`. */
function expectSingleRejection(
  result: ReturnType<typeof parseRestrictedYaml>,
  code: string,
  line: number,
  column: number,
): void {
  expect(result.ok).toBe(false);
  const diagnostic = result.diagnostics.find((entry) => entry.code === code);
  expect(diagnostic).toBeDefined();
  expect(diagnostic?.line).toBe(line);
  expect(diagnostic?.column).toBe(column);
}

describe("parseRestrictedYaml — accepted subset", () => {
  it("parses an empty source as JSON null", () => {
    const result = parseRestrictedYaml("");
    expect(result).toEqual({ ok: true, value: null, diagnostics: [] });
  });

  it("parses a golden document with strings, numbers, booleans, nested maps and lists", () => {
    const result = parseRestrictedYaml(
      'name: "example"\ncount: 3\nenabled: true\nnested:\n  list:\n    - 1\n    - 2\n',
    );
    expect(result).toEqual({
      ok: true,
      value: {
        name: "example",
        count: 3,
        enabled: true,
        nested: { list: [1, 2] },
      },
      diagnostics: [],
    });
  });

  it("accepts an explicit core-schema tag (e.g. !!str) — it is not a custom tag", () => {
    const result = parseRestrictedYaml("a: !!str 007\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: "007" });
    }
    // "007" is still ambiguous under the leading-zero rule, quite separately
    // from the (accepted) explicit tag.
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "yaml.ambiguous-scalar", severity: "warning" }),
    ]);
  });

  it("accepts a reference object under a credential-shaped key", () => {
    const result = parseRestrictedYaml('credentials:\n  store: "file"\n  name: "github"\n');
    expect(result).toEqual({
      ok: true,
      value: { credentials: { store: "file", name: "github" } },
      diagnostics: [],
    });
  });

  it("does not flag true/false/TRUE/False as ambiguous — core schema already resolves them", () => {
    const result = parseRestrictedYaml("a: true\nb: False\nc: TRUE\n");
    expect(result).toEqual({
      ok: true,
      value: { a: true, b: false, c: true },
      diagnostics: [],
    });
  });

  it("does not flag a casing outside the exact YAML-1.1 boolean word set (e.g. 'yEs')", () => {
    const result = parseRestrictedYaml("a: yEs\n");
    expect(result).toEqual({ ok: true, value: { a: "yEs" }, diagnostics: [] });
  });
});

describe("parseRestrictedYaml — rejection rules", () => {
  it("yaml.syntax-error: a malformed document is rejected without echoing the source line", () => {
    const result = parseRestrictedYaml('key: "unterminated\n');
    expectSingleRejection(result, "yaml.syntax-error", 2, 1);
    expect(result.diagnostics[0]?.message).not.toContain("unterminated");
  });

  it("yaml.duplicate-key: a repeated mapping key is rejected", () => {
    const result = parseRestrictedYaml("a: 1\na: 2\n");
    expectSingleRejection(result, "yaml.duplicate-key", 2, 1);
  });

  it("yaml.multiple-documents-not-supported: a second '---' document is rejected", () => {
    const result = parseRestrictedYaml("a: 1\n---\nb: 2\n");
    expectSingleRejection(result, "yaml.multiple-documents-not-supported", 2, 1);
  });

  it("yaml.alias-not-supported: an alias node is rejected", () => {
    const result = parseRestrictedYaml("a: &anchor 1\nb: *anchor\n");
    expect(result.ok).toBe(false);
    const alias = result.diagnostics.find((d) => d.code === "yaml.alias-not-supported");
    expect(alias?.line).toBe(2);
    expect(alias?.column).toBe(4);
  });

  it("yaml.anchor-not-supported: an anchored node is rejected", () => {
    const result = parseRestrictedYaml("a: &anchor 1\nb: 2\n");
    expectSingleRejection(result, "yaml.anchor-not-supported", 1, 12);
  });

  it("yaml.custom-tag-not-supported: an explicit non-core tag is rejected", () => {
    const result = parseRestrictedYaml("a: !mytag value\n");
    expectSingleRejection(result, "yaml.custom-tag-not-supported", 1, 11);
  });

  it("yaml.merge-key-not-supported: a literal '<<' mapping key is rejected", () => {
    const result = parseRestrictedYaml("a:\n  <<: value\n  b: 1\n");
    expectSingleRejection(result, "yaml.merge-key-not-supported", 2, 3);
  });

  it("yaml.non-string-key-not-supported: a non-string scalar key is rejected", () => {
    const result = parseRestrictedYaml("1: value\n");
    expectSingleRejection(result, "yaml.non-string-key-not-supported", 1, 1);
  });

  it("yaml.non-string-key-not-supported: a complex (mapping) key is rejected", () => {
    const result = parseRestrictedYaml("? {a: 1}\n: value\n");
    expectSingleRejection(result, "yaml.non-string-key-not-supported", 1, 3);
  });

  it("yaml.non-json-value: unquoted .nan/.inf scalars are rejected", () => {
    const result = parseRestrictedYaml("a: .nan\nb: .inf\n");
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toEqual(["yaml.non-json-value", "yaml.non-json-value"]);
    expect(result.diagnostics[0]).toMatchObject({ line: 1, column: 4 });
    expect(result.diagnostics[1]).toMatchObject({ line: 2, column: 4 });
  });

  it("yaml.max-depth-exceeded: nesting past the configured maxDepth is rejected", () => {
    const result = parseRestrictedYaml("a:\n  b:\n    c: 1\n", { maxDepth: 1 });
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find((d) => d.code === "yaml.max-depth-exceeded");
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.message).toContain("1");
  });

  it("yaml.sensitive-value-not-allowed: a credential-shaped key holding a scalar string is rejected", () => {
    const result = parseRestrictedYaml("password: hunter2\n");
    expectSingleRejection(result, "yaml.sensitive-value-not-allowed", 1, 11);
    expect(result.diagnostics[0]?.message).not.toContain("hunter2");
  });

  it("yaml.sensitive-value-not-allowed: a credential-shaped value with no key (array item) is rejected", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const result = parseRestrictedYaml(`items:\n  - ${token}\n`);
    expectSingleRejection(result, "yaml.sensitive-value-not-allowed", 2, 5);
    expect(result.diagnostics[0]?.message).not.toContain(token);
  });

  it("yaml.sensitive-value-not-allowed: a credential-shaped value under an innocuous key is still rejected", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const result = parseRestrictedYaml(`note: contact ${token} for access\n`);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("yaml.sensitive-value-not-allowed");
    expect(result.diagnostics[0]?.message).not.toContain(token);
  });

  it("sourcePath is attached to every diagnostic when provided", () => {
    const result = parseRestrictedYaml("password: hunter2\n", {
      sourcePath: "config/defaults.yaml",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.sourcePath).toBe("config/defaults.yaml");
  });
});

describe("parseRestrictedYaml — yaml.ambiguous-scalar (warning)", () => {
  it("warns on the YAML-1.1 boolean word 'yes' left unquoted", () => {
    const result = parseRestrictedYaml("flag: yes\n");
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([
      {
        code: "yaml.ambiguous-scalar",
        severity: "warning",
        message: expect.stringContaining("yes"),
        line: 1,
        column: 7,
      },
    ]);
    if (result.ok) {
      expect(result.value).toEqual({ flag: "yes" });
    }
  });

  it.each([
    "y",
    "Y",
    "yes",
    "Yes",
    "YES",
    "n",
    "N",
    "no",
    "No",
    "NO",
    "on",
    "On",
    "ON",
    "off",
    "Off",
    "OFF",
  ])("warns on the exact YAML-1.1 boolean word %s", (word) => {
    const result = parseRestrictedYaml(`flag: ${word}\n`);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("yaml.ambiguous-scalar");
    expect(result.diagnostics[0]?.severity).toBe("warning");
  });

  it("warns on a leading-zero integer left unquoted", () => {
    const result = parseRestrictedYaml("code: 007\n");
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([
      {
        code: "yaml.ambiguous-scalar",
        severity: "warning",
        message: expect.stringContaining("007"),
        line: 1,
        column: 7,
      },
    ]);
    if (result.ok) {
      expect(result.value).toEqual({ code: 7 });
    }
  });

  it("does not warn on a quoted ambiguous-looking word", () => {
    const result = parseRestrictedYaml('flag: "yes"\n');
    expect(result).toEqual({ ok: true, value: { flag: "yes" }, diagnostics: [] });
  });

  it("a warning alone does not make the document unusable", () => {
    const result = parseRestrictedYaml("flag: yes\n");
    expect(result.ok).toBe(true);
  });
});
