import { describe, expect, it } from "vitest";
import { parseRestrictedYaml } from "../src/yaml/restricted.js";

/**
 * Asserts `result` failed with *exactly* the given list of diagnostic codes
 * (in any order) — not merely "contains a diagnostic with this code" (C1).
 * The former assertion style passed against an implementation that also
 * emitted arbitrary spurious diagnostics alongside the expected one; this
 * one does not.
 */
function expectRejection(
  result: ReturnType<typeof parseRestrictedYaml>,
  codes: readonly string[],
): void {
  expect(result.ok).toBe(false);
  expect(result.diagnostics.map((d) => d.code).sort()).toEqual([...codes].sort());
}

/** Asserts `result` failed with exactly one diagnostic matching `code`/`line`/`column`. */
function expectSingleRejection(
  result: ReturnType<typeof parseRestrictedYaml>,
  code: string,
  line: number,
  column: number,
): void {
  expectRejection(result, [code]);
  const diagnostic = result.diagnostics[0];
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

describe("parseRestrictedYaml — rejection rules (C1: exact diagnostic sets)", () => {
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
    // Also carries `yaml.anchor-not-supported` for the `&anchor` definition
    // itself — both are independently, legitimately true of this source.
    const result = parseRestrictedYaml("a: &anchor 1\nb: *anchor\n");
    expectRejection(result, ["yaml.alias-not-supported", "yaml.anchor-not-supported"]);
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

  // B6: an explicit-empty key parses `pair.key` as the JS literal `null`,
  // which carries no `range` of its own — the diagnostic must still fall
  // back to the pair's own position instead of silently losing line/column.
  it("yaml.non-string-key-not-supported: an explicit-empty key falls back to the pair's position (B6)", () => {
    const result = parseRestrictedYaml("? \n: value\n");
    expectRejection(result, ["yaml.non-string-key-not-supported"]);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.line).toBeDefined();
    expect(diagnostic?.column).toBeDefined();
  });

  it("yaml.non-json-value: unquoted .nan/.inf scalars are rejected", () => {
    const result = parseRestrictedYaml("a: .nan\nb: .inf\n");
    expectRejection(result, ["yaml.non-json-value", "yaml.non-json-value"]);
    expect(result.diagnostics[0]).toMatchObject({ line: 1, column: 4 });
    expect(result.diagnostics[1]).toMatchObject({ line: 2, column: 4 });
  });

  it("yaml.max-depth-exceeded: nesting past the configured maxDepth is rejected", () => {
    const result = parseRestrictedYaml("a:\n  b:\n    c: 1\n", { maxDepth: 1 });
    expectRejection(result, ["yaml.max-depth-exceeded"]);
    expect(result.diagnostics[0]?.message).toContain("1");
  });

  // B2: `maxDepth: Infinity` must not disable the guard entirely — it is
  // clamped to a hard ceiling (well above the default, well below a stack
  // overflow) rather than trusted verbatim. 1,500 levels of flow-sequence
  // nesting exceeds that ceiling, but `yaml`'s own composer independently
  // enforces its own internal nesting limit on flow collections and gives
  // up (a `yaml.syntax-error`) *before* traversal ever reaches this guard —
  // so either code is an acceptable "rejected safely" outcome here; the
  // invariant under test is "does not honour `Infinity` and does not
  // silently accept", not "which layer detects it first".
  it("maxDepth: Infinity is clamped, not honoured verbatim — rejected safely either way (B2)", () => {
    const deep = `${"[".repeat(1_500)}1${"]".repeat(1_500)}\n`;
    const result = parseRestrictedYaml(deep, { maxDepth: Number.POSITIVE_INFINITY });
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.code === "yaml.max-depth-exceeded" || d.code === "yaml.syntax-error",
      ),
    ).toBe(true);
  });

  // B2: a pathologically deeply nested source must not throw a raw
  // `RangeError` out of this Result-typed function.
  it("does not throw on deeply nested input — returns a diagnostic instead (B2)", () => {
    const deep = `${"[".repeat(200_000)}1${"]".repeat(200_000)}\n`;
    expect(() => parseRestrictedYaml(deep)).not.toThrow();
    const result = parseRestrictedYaml(deep);
    expect(result.ok).toBe(false);
  });

  // B2: an oversized source must fail fast with a diagnostic rather than
  // being handed to the underlying parser unbounded.
  it("yaml.source-too-large: an oversized source is rejected before parsing (B2)", () => {
    const huge = `a: "${"x".repeat(2_100_000)}"\n`;
    const result = parseRestrictedYaml(huge);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "yaml.source-too-large")).toBe(true);
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
    expectRejection(result, ["yaml.sensitive-value-not-allowed"]);
    expect(result.diagnostics[0]?.message).not.toContain(token);
  });

  // A6: __proto__/constructor/prototype must never survive as an own
  // mapping key — rejected outright, with position, rather than merely
  // "handled safely downstream".
  it.each(["__proto__", "constructor", "prototype"])(
    "yaml.unsafe-key-not-supported: %s is rejected as a mapping key (A6)",
    (key) => {
      const result = parseRestrictedYaml(`${key}: 1\n`);
      expectRejection(result, ["yaml.unsafe-key-not-supported"]);
      expect(result.diagnostics[0]?.line).toBe(1);
      expect(result.diagnostics[0]?.column).toBe(1);
    },
  );

  it("yaml.unsafe-key-not-supported: a nested reserved key is also rejected (A6)", () => {
    const result = parseRestrictedYaml("a:\n  __proto__:\n    polluted: true\n");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "yaml.unsafe-key-not-supported")).toBe(true);
  });

  // C2: a *valid* parse must never carry an injected prototype member —
  // the reserved-key rejection above proves the document is refused, this
  // proves a document that never used a reserved key comes back completely
  // ordinary.
  it("C2: a valid parse result's prototype is untouched Object.prototype, with no injected members", () => {
    const result = parseRestrictedYaml("a: 1\nb:\n  c: 2\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
      expect(Object.prototype).not.toHaveProperty("polluted");
    }
  });

  // C5: a credential-shaped key holding a *sequence* of scalar strings —
  // the guard was previously scoped to scalar values only. `api_key`
  // (singular) is used, not `api_keys`: `looksLikeCredentialKey`'s pattern
  // requires the credential word to be followed by a `[._-]` separator or
  // end-of-string, so a trailing plural "s" (`api_keys`, `passwords`) is
  // deliberately excluded by that pattern — see `patterns.ts`.
  it("yaml.sensitive-value-not-allowed: a credential-shaped key holding a sequence of scalar strings is rejected (C5)", () => {
    const result = parseRestrictedYaml("api_key:\n  - hunter2\n");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "yaml.sensitive-value-not-allowed")).toBe(
      true,
    );
    expect(result.diagnostics.every((d) => !d.message.includes("hunter2"))).toBe(true);
  });

  // C5 (decision #1, not relitigated): a credential-shaped key holding a
  // *mapping* value stays legal — this is the sanctioned reference form.
  it("accepts a credential-shaped key holding a mapping value — the sanctioned reference form (C5)", () => {
    const result = parseRestrictedYaml('credentials:\n  - store: "file"\n');
    // A sequence *containing a mapping* (not a scalar string) must not be
    // rejected — only sequences of scalar strings are in scope for C5.
    expect(result).toEqual({
      ok: true,
      value: { credentials: [{ store: "file" }] },
      diagnostics: [],
    });
  });

  // C6a: a credential in *key* position (rather than value position) was
  // previously invisible to the value-shape scan entirely.
  it("yaml.sensitive-value-not-allowed: a credential-shaped key text (not just credential-shaped value) is rejected (C6a)", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const result = parseRestrictedYaml(`${token}: enabled\n`);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "yaml.sensitive-value-not-allowed")).toBe(
      true,
    );
  });

  // C6b: no diagnostic message may ever contain the raw credential, even
  // when the credential is the key text itself.
  it("no diagnostic message ever contains the raw credential, including when it is in key position (C6b)", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const result = parseRestrictedYaml(`${token}: enabled\n`);
    expect(result.ok).toBe(false);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.message).not.toContain(token);
    }
  });

  it("sourcePath is attached to every diagnostic when provided", () => {
    const result = parseRestrictedYaml("password: hunter2\n", {
      sourcePath: "config/defaults.yaml",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.sourcePath).toBe("config/defaults.yaml");
  });
});

describe("parseRestrictedYaml — B3: empty-stream errors/warnings are not discarded", () => {
  it("a directive-only stream that yaml rejects is not silently reported as a successfully parsed empty document", () => {
    const result = parseRestrictedYaml("%YAML 1.3\n");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("a stream of only comments still parses as an accepted empty document (no errors to surface)", () => {
    const result = parseRestrictedYaml("# just a comment\n");
    expect(result).toEqual({ ok: true, value: null, diagnostics: [] });
  });
});

describe("parseRestrictedYaml — yaml.ambiguous-scalar (warning)", () => {
  it("warns on the YAML-1.1 boolean word 'yes' left unquoted", () => {
    const result = parseRestrictedYaml("flag: yes\n");
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "yaml.ambiguous-scalar",
        severity: "warning",
        message: expect.stringContaining("yes"),
        line: 1,
        column: 7,
      }),
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
      expect.objectContaining({
        code: "yaml.ambiguous-scalar",
        severity: "warning",
        message: expect.stringContaining("007"),
        line: 1,
        column: 7,
      }),
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

  // C8b: YAML-1.1 sexagesimal (base-60) notation — the core schema leaves it
  // as a string, but a YAML-1.1 reader resolves it to a number.
  it("warns on a YAML-1.1 sexagesimal-looking scalar (C8b)", () => {
    const result = parseRestrictedYaml("duration: 12:30\n");
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "yaml.ambiguous-scalar", severity: "warning" }),
    ]);
    if (result.ok) {
      expect(result.value).toEqual({ duration: "12:30" });
    }
  });

  it("does not warn on an ordinary port-mapping-shaped string (C8b false-positive guard)", () => {
    const result = parseRestrictedYaml("ports: 8080:8080\n");
    expect(result).toEqual({ ok: true, value: { ports: "8080:8080" }, diagnostics: [] });
  });

  // C8b: the `~`/`Null`/`NULL` null spellings — readability ambiguity, not
  // cross-parser disagreement (both YAML 1.1 and the core schema resolve
  // them identically), but easy to misread as a sentinel string.
  it.each(["~", "Null", "NULL"])("warns on the null spelling %s (C8b)", (spelling) => {
    const result = parseRestrictedYaml(`flag: ${spelling}\n`);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "yaml.ambiguous-scalar", severity: "warning" }),
    ]);
    if (result.ok) {
      expect(result.value).toEqual({ flag: null });
    }
  });

  it("does not warn on the canonical lowercase 'null' spelling (C8b)", () => {
    const result = parseRestrictedYaml("flag: null\n");
    expect(result).toEqual({ ok: true, value: { flag: null }, diagnostics: [] });
  });
});
