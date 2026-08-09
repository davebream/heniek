/**
 * The public surface: the optional profile check, the layers a document
 * passes through, and the three renderers.
 */

import { describe, expect, it } from "vitest";
import { PIPELINE_DIAGNOSTIC_CODES } from "../src/diagnostics.js";
import { parsePipelineDocument } from "../src/parse.js";
import {
  renderPipelineDiagnostics,
  renderPipelineGraph,
  toPipelineValidationResult,
} from "../src/render.js";
import { suggestionForPointer, withSuggestion } from "../src/suggestions.js";

const TWO_STAGE = `
schemaVersion: 1
id: two-stage
stages:
  - id: design
    type: agent
    profile: opus-designer
    writes: [artifacts.design]
  - id: verify
    type: verify
    profile: sol-verifier
    needs: [design]
    reads: [artifacts.design]
    on_validation_failure:
      strategy: delegate
      delegate_to: sol-critic
`;

function codesOf(source: string, options?: Parameters<typeof parsePipelineDocument>[1]) {
  return parsePipelineDocument(source, options).diagnostics.map((entry) => entry.code);
}

describe("profile references", () => {
  it("says nothing about profiles when the caller supplies no list", () => {
    expect(codesOf(TWO_STAGE, { sourcePath: "p.yaml" })).toEqual([]);
  });

  it("accepts every reference when all of them are declared", () => {
    const result = parsePipelineDocument(TWO_STAGE, {
      sourcePath: "p.yaml",
      knownProfileIds: ["opus-designer", "sol-verifier", "sol-critic"],
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  /**
   * Every place a profile can be named — the stage's worker, the repair
   * delegate, an evaluator condition, and a `verdict` completion requirement
   * — is checked, not just the obvious one.
   */
  it("reports a worker, a delegate, an evaluator, and a verdict alike", () => {
    const source = `
schemaVersion: 1
id: references
stages:
  - id: gate
    type: verify
    profile: missing-worker
    writes: [artifacts.gate]
    completion:
      require:
        - verdict: missing-judge
    on_validation_failure:
      strategy: delegate
      delegate_to: missing-delegate
    transitions:
      - when:
          evaluator: missing-evaluator
          question: Should we ship?
        then: ship
  - id: ship
    type: publish
    reads: [artifacts.gate]
`;
    const result = parsePipelineDocument(source, {
      sourcePath: "p.yaml",
      knownProfileIds: ["something-else"],
    });
    expect(result.ok).toBe(false);
    const named = result.diagnostics
      .filter((entry) => entry.code === PIPELINE_DIAGNOSTIC_CODES.profileNotDeclared)
      .map((entry) => entry.message);
    expect(named).toHaveLength(4);
    for (const profile of [
      "missing-worker",
      "missing-judge",
      "missing-delegate",
      "missing-evaluator",
    ]) {
      expect(
        named.some((message) => message.includes(profile)),
        profile,
      ).toBe(true);
    }
  });
});

describe("layering", () => {
  it("stops at the YAML layer without reporting schema or semantic rules", () => {
    const codes = codesOf("schemaVersion: 1\nid: x\nstages: [\n", { sourcePath: "p.yaml" });
    expect(codes.every((code) => code.startsWith("yaml."))).toBe(true);
    expect(codes.length).toBeGreaterThan(0);
  });

  it("stops at the schema layer without running semantic rules", () => {
    const codes = codesOf("schemaVersion: 1\nid: x\nstages: []\n", { sourcePath: "p.yaml" });
    expect(codes).toEqual(["configuration.schema-violation"]);
  });

  /**
   * The normalizer and the validator both run even when the normalizer found
   * a broken condition, so an author fixing a pipeline sees every problem in
   * one pass rather than one per attempt.
   */
  it("reports a broken condition and the semantic rules together", () => {
    const source = `
schemaVersion: 1
id: both
stages:
  - id: gate
    type: verify
    profile: sol-verifier
    transitions:
      - when:
          expression: "a >"
        then: ship
  - id: ship
    type: publish
  - id: island
    type: approval
    needs: [nowhere]
`;
    const codes = new Set(codesOf(source, { sourcePath: "p.yaml" }));
    expect(codes.has(PIPELINE_DIAGNOSTIC_CODES.expressionInvalid)).toBe(true);
    expect(codes.has(PIPELINE_DIAGNOSTIC_CODES.unknownStageReference)).toBe(true);
  });

  it("carries the source path onto every diagnostic, and omits it when there is none", () => {
    const withPath = parsePipelineDocument("stages: []\n", { sourcePath: "here.yaml" });
    for (const diagnostic of withPath.diagnostics) {
      expect(diagnostic.sourcePath).toBe("here.yaml");
    }
    const withoutPath = parsePipelineDocument("stages: []\n");
    for (const diagnostic of withoutPath.diagnostics) {
      expect(diagnostic.sourcePath).toBeUndefined();
    }
  });
});

describe("renderers", () => {
  it("renders a graph as canonical JSON ending in a newline", () => {
    const result = parsePipelineDocument(TWO_STAGE);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const text = renderPipelineGraph(result.graph);
    expect(text.endsWith("\n")).toBe(true);
    // Keys sorted at every level: `edges` precedes `limits` precedes `stages`.
    expect(text.indexOf('"edges"')).toBeLessThan(text.indexOf('"limits"'));
    expect(text.indexOf('"limits"')).toBeLessThan(text.indexOf('"stages"'));
  });

  it("includes the graph only when the parse succeeded", () => {
    const good = toPipelineValidationResult(parsePipelineDocument(TWO_STAGE));
    expect(good.graph).toBeDefined();
    const bad = toPipelineValidationResult(parsePipelineDocument("stages: []\n"));
    expect(bad.graph).toBeUndefined();
    expect(bad.schemaVersion).toBe(1);
  });

  it("prints location, severity, rule, message, and correction", () => {
    const result = parsePipelineDocument("schemaVersion: 1\nid: x\nstages: []\n", {
      sourcePath: "p.yaml",
    });
    const text = renderPipelineDiagnostics(result.diagnostics);
    expect(text).toContain("p.yaml:3:9");
    expect(text).toContain("error");
    expect(text).toContain("configuration.schema-violation");
    expect(text).toContain("at /stages");
    expect(text).toContain("→ ");
  });

  it("says so plainly when there is nothing to report", () => {
    expect(renderPipelineDiagnostics([])).toBe("No diagnostics.\n");
  });

  /**
   * Redaction happens where values become text, so a credential that somehow
   * reached a graph cannot leave through the artefact people paste into
   * issues. The YAML layer refuses these documents outright, which is why
   * this asserts on the renderer directly rather than through a parse.
   */
  it("redacts credential-shaped values on the way out", () => {
    const text = renderPipelineGraph({
      schemaVersion: 1,
      pipelineId: "leaky",
      mode: "autonomous",
      limits: {},
      context: {},
      stages: [
        {
          id: "only",
          type: "command",
          mode: "autonomous",
          optional: false,
          command: { argv: ["deploy"], env: { token: "ghp_0123456789abcdefghijklmnopqrstuvwxyz" } },
          reads: [],
          writes: [],
          overridable: [],
        },
      ],
      edges: [],
    } as never);
    expect(text).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
  });
});

describe("suggestions", () => {
  it("walks up to the nearest ancestor with advice", () => {
    expect(suggestionForPointer("/stages/3/completion/require/1/artifact")).toBe(
      suggestionForPointer("/stages/0/completion/require/0"),
    );
  });

  it("falls back to naming the published schema", () => {
    expect(suggestionForPointer("/nothing/like/this")).toContain("PipelineDefinition/v1");
  });

  it("treats every index the same", () => {
    expect(suggestionForPointer("/stages/0/type")).toBe(suggestionForPointer("/stages/17/type"));
  });

  it("leaves a diagnostic that already carries advice untouched", () => {
    const original = {
      code: "pipeline.cycle",
      severity: "error" as const,
      message: "m",
      suggestion: "keep me",
    };
    expect(withSuggestion(original).suggestion).toBe("keep me");
  });
});
