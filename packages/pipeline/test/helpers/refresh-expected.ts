/**
 * Regenerates every checked-in expected file from the current parser.
 *
 *     pnpm --filter @heniek/pipeline exec tsx test/helpers/refresh-expected.ts
 *
 * Run it, then **read the diff**. The expected files are the review surface
 * for this package: a change that rewrites them is a change to what a
 * pipeline author sees, and the only thing standing between an accidental
 * regression and a green suite is someone looking at what moved. It is
 * deliberately a separate command rather than an environment variable the
 * test suite honours, so a corpus file can never be silently rewritten by the
 * same command that is supposed to be checking it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parsePipelineDocument,
  renderPipelineGraph,
  renderPipelineValidationResult,
} from "../../src/index.js";
import { expectedRoot, listCorpus, listEquivalenceGroups } from "./corpus.js";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  process.stdout.write(`wrote ${path}\n`);
}

for (const entry of listCorpus("valid")) {
  const result = parsePipelineDocument(entry.source, { sourcePath: entry.sourcePath });
  if (!result.ok) {
    process.stdout.write(
      `SKIPPED ${entry.name}: a file in corpus/valid did not parse — fix the file, not the expectation.\n`,
    );
    continue;
  }
  write(entry.expectedPath, renderPipelineGraph(result.graph));
}

for (const entry of listCorpus("invalid")) {
  const result = parsePipelineDocument(entry.source, { sourcePath: entry.sourcePath });
  if (result.ok) {
    process.stdout.write(
      `SKIPPED ${entry.name}: a file in corpus/invalid parsed cleanly — fix the file, not the expectation.\n`,
    );
    continue;
  }
  write(entry.expectedPath, renderPipelineValidationResult(result, entry.sourcePath));
}

for (const group of listEquivalenceGroups()) {
  const first = group.variants[0];
  if (first === undefined) {
    continue;
  }
  const result = parsePipelineDocument(first.source, { sourcePath: first.sourcePath });
  if (!result.ok) {
    process.stdout.write(`SKIPPED ${group.name}: the first variant did not parse.\n`);
    continue;
  }
  write(join(expectedRoot, "equivalent", `${group.name}.json`), renderPipelineGraph(result.graph));
}
