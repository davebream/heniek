/**
 * The golden corpus (AC1, AC2, AC3).
 *
 * Three properties are pinned here and nowhere else:
 *
 * - every file under `corpus/valid` parses, and produces exactly the bytes in
 *   `expected/valid`;
 * - every file under `corpus/invalid` is rejected, with exactly the
 *   diagnostics in `expected/invalid` — including their positions, rules, and
 *   suggested corrections;
 * - every variant in an `corpus/equivalent` group produces byte-identical
 *   graph JSON, which is the acceptance criterion "equivalent YAML normalizes
 *   to byte-identical graph JSON" stated as an executable claim.
 *
 * Expected files are regenerated with
 * `tsx test/helpers/refresh-expected.ts` and reviewed as a diff; see that
 * file's header for why it is a separate command rather than a flag on this
 * suite.
 */

import { createRequire } from "node:module";
import {
  PipelineDefinitionV1,
  PipelineGraphV1,
  PipelineValidationResultV1,
} from "@heniek/contracts";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { parsePipelineDocument } from "../src/parse.js";
import { renderPipelineGraph, renderPipelineValidationResult } from "../src/render.js";
import { listCorpus, listEquivalenceGroups, readExpected } from "./helpers/corpus.js";

// See packages/contracts/scripts/generate.ts for why ajv-formats is loaded
// through createRequire rather than a static import.
const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(PipelineDefinitionV1);
ajv.addSchema(PipelineGraphV1);
ajv.addSchema(PipelineValidationResultV1);

const validateGraph = ajv.getSchema("heniek://contract/PipelineGraph/v1");
const validateResult = ajv.getSchema("heniek://contract/PipelineValidationResult/v1");

if (validateGraph === undefined || validateResult === undefined) {
  throw new Error("Pipeline contracts did not compile.");
}

describe("valid corpus", () => {
  for (const entry of listCorpus("valid")) {
    describe(entry.name, () => {
      const result = parsePipelineDocument(entry.source, { sourcePath: entry.sourcePath });

      it("parses", () => {
        expect(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
      });

      it("normalizes to the recorded bytes", () => {
        if (!result.ok) {
          return;
        }
        expect(renderPipelineGraph(result.graph)).toBe(readExpected(entry.expectedPath));
      });

      it("produces a graph that validates against PipelineGraph/v1", () => {
        if (!result.ok) {
          return;
        }
        expect(validateGraph(result.graph), JSON.stringify(validateGraph.errors)).toBe(true);
      });

      /**
       * Parsing is a pure function of its inputs, so the second call must
       * agree with the first in every byte. Cheap to assert, and it is the
       * one property a hidden `Date.now()`, a `Math.random()`, or a
       * module-level cache would break.
       */
      it("is stable across repeated parses", () => {
        if (!result.ok) {
          return;
        }
        const again = parsePipelineDocument(entry.source, { sourcePath: entry.sourcePath });
        expect(again.ok).toBe(true);
        if (again.ok) {
          expect(renderPipelineGraph(again.graph)).toBe(renderPipelineGraph(result.graph));
        }
      });
    });
  }
});

describe("invalid corpus", () => {
  for (const entry of listCorpus("invalid")) {
    describe(entry.name, () => {
      const result = parsePipelineDocument(entry.source, { sourcePath: entry.sourcePath });

      it("is rejected", () => {
        expect(result.ok).toBe(false);
      });

      it("produces the recorded diagnostics", () => {
        expect(renderPipelineValidationResult(result, entry.sourcePath)).toBe(
          readExpected(entry.expectedPath),
        );
      });

      it("produces a result that validates against PipelineValidationResult/v1", () => {
        const payload = JSON.parse(renderPipelineValidationResult(result, entry.sourcePath));
        expect(validateResult(payload), JSON.stringify(validateResult.errors)).toBe(true);
      });

      /**
       * The guarantee that makes a diagnostic actionable rather than merely
       * correct. Asserted over the whole corpus rather than per rule, so a
       * new rule cannot ship without one.
       */
      it("names the file, the path, the rule, and the correction for every diagnostic", () => {
        for (const diagnostic of result.diagnostics) {
          expect(diagnostic.sourcePath, diagnostic.code).toBe(entry.sourcePath);
          expect(diagnostic.code.length, diagnostic.code).toBeGreaterThan(0);
          expect(diagnostic.suggestion, `${diagnostic.code} has no suggestion`).toBeDefined();
          expect((diagnostic.suggestion ?? "").length).toBeGreaterThan(0);
        }
      });
    });
  }

  /**
   * A position is omitted in exactly two places, and both are honest: a
   * whole-source refusal from the YAML layer ("this stream holds two
   * documents") carries no pointer at all, and a violation at the document
   * root of a source with no nodes — an empty file — has no node to point at.
   * Every diagnostic that names a path inside the document points at a line,
   * because "somewhere in this file" is not a location.
   */
  it("locates every diagnostic that names a path", () => {
    for (const entry of listCorpus("invalid")) {
      const result = parsePipelineDocument(entry.source, { sourcePath: entry.sourcePath });
      for (const diagnostic of result.diagnostics) {
        if (diagnostic.pointer === undefined || diagnostic.pointer === "") {
          continue;
        }
        expect(diagnostic.line, `${entry.name}: ${diagnostic.code}`).toBeDefined();
        expect(diagnostic.column, `${entry.name}: ${diagnostic.code}`).toBeDefined();
      }
    }
  });
});

describe("equivalent documents normalize to identical bytes (AC3)", () => {
  for (const group of listEquivalenceGroups()) {
    it(`${group.name}: every spelling produces the same graph`, () => {
      expect(group.variants.length).toBeGreaterThan(1);

      const rendered = group.variants.map((variant) => {
        const result = parsePipelineDocument(variant.source, { sourcePath: variant.sourcePath });
        expect(result.ok, `${variant.name}: ${JSON.stringify(result.diagnostics)}`).toBe(true);
        return result.ok ? renderPipelineGraph(result.graph) : "";
      });

      const expected = readExpected(group.variants[0]?.expectedPath ?? "");
      for (const [index, text] of rendered.entries()) {
        expect(text, group.variants[index]?.name).toBe(expected);
      }
    });
  }
});
