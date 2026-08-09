/**
 * Seeded property and fuzz suite.
 *
 * Hand-rolled on `@heniek/conformance`'s splitmix32 generator, and **the
 * seeds are fixed constants in this file, never chosen at run time** — a
 * property test that picks its own seed is a flaky test with extra steps.
 * The same rejection of `fast-check` applies here as in
 * `packages/state/test/replay-properties.test.ts`: shrinking earns its keep
 * when counterexamples are large and opaque, and here a failure is "this
 * seed, this document", printed in full.
 *
 * Three properties, in order of how much they are worth:
 *
 * 1. **Canonicalization.** Reordering the parts of a document that carry no
 *    meaning — stage order, key order, `needs` versus `edges`, whitespace
 *    inside a condition — never changes a byte of the graph. This is
 *    acceptance criterion 3 stated over generated input rather than over the
 *    handful of documents someone thought to write down.
 * 2. **Totality.** The parser is a total function: random bytes, mutated
 *    corpus files, and truncated documents all return a result. It never
 *    throws, and it never reports failure without saying why.
 * 3. **Determinism.** Parsing the same text twice produces the same bytes,
 *    which is what a hidden clock, a random id, or a shared mutable cache
 *    would break.
 */

import { createDeterministicRandom, type DeterministicRandom, seed } from "@heniek/conformance";
import { describe, expect, it } from "vitest";
import { parseConditionExpression } from "../src/expression/parse.js";
import { parsePipelineDocument } from "../src/parse.js";
import { renderPipelineGraph, renderPipelineValidationResult } from "../src/render.js";
import { listCorpus } from "./helpers/corpus.js";

/** Fixed, hand-chosen, and never regenerated — see this file's header. */
const SEEDS: readonly number[] = [0x9a17_0001, 0x9a17_0002, 0x9a17_0003, 0x9a17_0004];

const STAGE_TYPES = ["agent", "verify", "publish", "integration"] as const;

interface GeneratedStage {
  readonly id: string;
  readonly type: (typeof STAGE_TYPES)[number];
  readonly needs: readonly string[];
  readonly writes: readonly string[];
  readonly reads: readonly string[];
}

/**
 * Builds a random *valid* pipeline: stage `i` may only depend on stages
 * before it, so the graph is acyclic by construction and every read is
 * satisfied by an ancestor. The generator's job is to vary the surface, not
 * to produce rejects — the fuzz section below covers those.
 */
function generatePipeline(random: DeterministicRandom): readonly GeneratedStage[] {
  const count = random.nextInt(2, 7);
  const stages: GeneratedStage[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidates = stages.map((stage) => stage.id);
    const needs: string[] = [];
    for (const candidate of candidates) {
      if (random.nextInt(0, 3) === 0) {
        needs.push(candidate);
      }
    }
    // Stage 0 has no candidates; every later stage keeps at least one edge so
    // the graph stays connected and the reachability rule has nothing to say.
    if (needs.length === 0 && candidates.length > 0) {
      needs.push(candidates[random.nextInt(0, candidates.length)] ?? "");
    }
    const ancestors = collectAncestors(stages, needs);
    const readable = stages
      .filter((stage) => ancestors.has(stage.id))
      .flatMap((stage) => stage.writes);
    const reads = readable.filter(() => random.nextInt(0, 2) === 0);
    stages.push({
      id: `stage_${index}`,
      type: STAGE_TYPES[random.nextInt(0, STAGE_TYPES.length)] ?? "agent",
      needs,
      writes: [`artifacts.out_${index}`],
      reads: random.nextInt(0, 4) === 0 ? [...reads, "task.current"] : reads,
    });
  }
  return stages;
}

function collectAncestors(
  stages: readonly GeneratedStage[],
  direct: readonly string[],
): ReadonlySet<string> {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const collected = new Set<string>();
  const queue = [...direct];
  while (queue.length > 0) {
    const current = queue.shift() ?? "";
    if (collected.has(current)) {
      continue;
    }
    collected.add(current);
    queue.push(...(byId.get(current)?.needs ?? []));
  }
  return collected;
}

/** Renders the generated pipeline with `needs`, stages in declaration order. */
function renderWithNeeds(stages: readonly GeneratedStage[]): string {
  const lines = ["schemaVersion: 1", "id: generated", "stages:"];
  for (const stage of stages) {
    lines.push(`  - id: ${stage.id}`);
    lines.push(`    type: ${stage.type}`);
    if (stage.type === "agent" || stage.type === "verify") {
      lines.push("    profile: opus-planner");
    }
    if (stage.needs.length > 0) {
      lines.push(`    needs: [${stage.needs.join(", ")}]`);
    }
    if (stage.reads.length > 0) {
      lines.push(`    reads: [${[...stage.reads].join(", ")}]`);
    }
    lines.push(`    writes: [${stage.writes.join(", ")}]`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The same pipeline with every meaning-preserving difference applied at once:
 * stages emitted in reverse, dependencies moved to a top-level `edges` list
 * in shuffled order, keys reordered, values quoted, `mode`/`optional` spelled
 * out rather than inherited.
 */
function renderWithEdges(stages: readonly GeneratedStage[], random: DeterministicRandom): string {
  const lines = ["id: 'generated'", "stages:"];
  for (const stage of [...stages].reverse()) {
    lines.push(`  - type: "${stage.type}"`);
    lines.push(`    optional: false`);
    if (stage.reads.length > 0) {
      lines.push(`    reads: [${[...stage.reads].reverse().join(", ")}]`);
    }
    lines.push(`    writes: [${stage.writes.join(", ")}]`);
    lines.push(`    mode: autonomous`);
    if (stage.type === "agent" || stage.type === "verify") {
      lines.push("    profile: 'opus-planner'");
    }
    lines.push(`    id: "${stage.id}"`);
  }

  const edges = stages.flatMap((stage) =>
    stage.needs.map((dependency) => `  - to: ${stage.id}\n    from: ${dependency}`),
  );
  if (edges.length > 0) {
    lines.push("edges:");
    lines.push(...shuffle(edges, random));
  }
  lines.push("mode: autonomous");
  lines.push("schemaVersion: 1");
  return `${lines.join("\n")}\n`;
}

function shuffle<T>(values: readonly T[], random: DeterministicRandom): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = random.nextInt(0, index + 1);
    const left = copy[index];
    const right = copy[swap];
    /* c8 ignore next 3 -- both indices are in range by construction */
    if (left === undefined || right === undefined) {
      continue;
    }
    copy[index] = right;
    copy[swap] = left;
  }
  return copy;
}

describe("canonicalization", () => {
  for (const value of SEEDS) {
    it(`seed ${value.toString(16)}: every spelling of one pipeline renders identically`, () => {
      const random = createDeterministicRandom(seed(value));
      for (let round = 0; round < 25; round += 1) {
        const stages = generatePipeline(random.fork(`pipeline-${round}`));
        const withNeeds = renderWithNeeds(stages);
        const withEdges = renderWithEdges(stages, random.fork(`shuffle-${round}`));

        const first = parsePipelineDocument(withNeeds, { sourcePath: "a.yaml" });
        const second = parsePipelineDocument(withEdges, { sourcePath: "b.yaml" });

        expect(
          first.ok,
          `needs form rejected:\n${withNeeds}\n${JSON.stringify(first.diagnostics)}`,
        ).toBe(true);
        expect(
          second.ok,
          `edges form rejected:\n${withEdges}\n${JSON.stringify(second.diagnostics)}`,
        ).toBe(true);
        if (first.ok && second.ok) {
          expect(
            renderPipelineGraph(second.graph),
            `\n--- needs ---\n${withNeeds}\n--- edges ---\n${withEdges}`,
          ).toBe(renderPipelineGraph(first.graph));
        }
      }
    });
  }

  it("does not depend on the source path", () => {
    const random = createDeterministicRandom(seed(SEEDS[0] ?? 1));
    const stages = generatePipeline(random);
    const source = renderWithNeeds(stages);
    const here = parsePipelineDocument(source, { sourcePath: "/one/place.yaml" });
    const there = parsePipelineDocument(source, { sourcePath: "/somewhere/else.yaml" });
    expect(here.ok && there.ok).toBe(true);
    if (here.ok && there.ok) {
      expect(renderPipelineGraph(here.graph)).toBe(renderPipelineGraph(there.graph));
    }
  });
});

describe("totality", () => {
  const PRINTABLE = " \n\t-:[]{}#\"'|>&!*.,0123456789abcdefghijklmnopqrstuvwxyzABC_";

  it("never throws on random bytes, and always explains a rejection", () => {
    for (const value of SEEDS) {
      const random = createDeterministicRandom(seed(value));
      for (let round = 0; round < 400; round += 1) {
        const length = random.nextInt(0, 120);
        let source = "";
        for (let index = 0; index < length; index += 1) {
          source += PRINTABLE[random.nextInt(0, PRINTABLE.length)] ?? " ";
        }
        const result = parsePipelineDocument(source, { sourcePath: "fuzz.yaml" });
        if (!result.ok) {
          expect(result.diagnostics.length, JSON.stringify(source)).toBeGreaterThan(0);
          expect(
            result.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
            JSON.stringify(source),
          ).toBe(true);
          for (const diagnostic of result.diagnostics) {
            expect(
              diagnostic.suggestion,
              `${diagnostic.code}: ${JSON.stringify(source)}`,
            ).toBeDefined();
          }
        }
      }
    }
  });

  /**
   * Mutating a *valid* document is the higher-yield fuzz: it reaches the
   * semantic rules, which random bytes almost never do, because random bytes
   * rarely survive the YAML layer.
   */
  it("never throws on mutated corpus documents", () => {
    const corpus = [...listCorpus("valid"), ...listCorpus("invalid")];
    for (const value of SEEDS) {
      const random = createDeterministicRandom(seed(value));
      for (let round = 0; round < 150; round += 1) {
        const entry = corpus[random.nextInt(0, corpus.length)];
        /* c8 ignore next 3 -- the corpus is never empty */
        if (entry === undefined) {
          continue;
        }
        const mutated = mutate(entry.source, random);
        const result = parsePipelineDocument(mutated, { sourcePath: entry.sourcePath });
        // Rendering is part of the surface under test: a graph the renderer
        // cannot serialise is as broken as a parser that throws.
        expect(() => renderPipelineValidationResult(result, entry.sourcePath)).not.toThrow();
      }
    }
  });

  function mutate(source: string, random: DeterministicRandom): string {
    const choice = random.nextInt(0, 5);
    if (choice === 0) {
      return source.slice(0, random.nextInt(0, source.length + 1));
    }
    if (choice === 1) {
      const at = random.nextInt(0, source.length + 1);
      return `${source.slice(0, at)}${PRINTABLE[random.nextInt(0, PRINTABLE.length)] ?? " "}${source.slice(at)}`;
    }
    if (choice === 2) {
      const at = random.nextInt(0, Math.max(1, source.length));
      return source.slice(0, at) + source.slice(at + 1);
    }
    if (choice === 3) {
      return source.split("\n").reverse().join("\n");
    }
    return `${source}\n${source}`;
  }
});

describe("expression parsing is total", () => {
  const EXPRESSION_ALPHABET = "abc.01 ()!&|<>=\"'*+-/%,[]";

  it("never throws on random token soup, and always locates the failure", () => {
    for (const value of SEEDS) {
      const random = createDeterministicRandom(seed(value));
      for (let round = 0; round < 800; round += 1) {
        const length = random.nextInt(0, 40);
        let source = "";
        for (let index = 0; index < length; index += 1) {
          source += EXPRESSION_ALPHABET[random.nextInt(0, EXPRESSION_ALPHABET.length)] ?? " ";
        }
        const result = parseConditionExpression(source);
        if (!result.ok) {
          expect(result.error.message.length, JSON.stringify(source)).toBeGreaterThan(0);
          expect(result.error.offset, JSON.stringify(source)).toBeGreaterThanOrEqual(0);
        } else {
          // Anything that parses must be well-formed: every child index
          // points backwards at a node that exists, and the root is in range.
          expect(result.root).toBeLessThan(result.nodes.length);
          for (const [index, node] of result.nodes.entries()) {
            if (node.kind === "compare" || node.kind === "logical") {
              expect(node.left).toBeLessThan(index);
              expect(node.right).toBeLessThan(index);
            }
            if (node.kind === "not") {
              expect(node.operand).toBeLessThan(index);
            }
          }
        }
      }
    }
  });
});
