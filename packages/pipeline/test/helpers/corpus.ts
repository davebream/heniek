/**
 * Locating and reading the golden corpus.
 *
 * The corpus is a directory of YAML files with a checked-in expected result
 * beside each one, rather than inline fixtures: adding a case is adding a
 * file, and a reviewer reads the case as a pipeline author would write it
 * instead of as an escaped string inside a test.
 *
 * `sourcePath` is deliberately the *repository-relative* path, not the
 * absolute one. Diagnostics carry it, the expected files record it, and an
 * absolute path would make every expected file machine-specific — the corpus
 * would then pass only on the machine that generated it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const corpusRoot = join(packageRoot, "test", "corpus");
export const expectedRoot = join(packageRoot, "test", "expected");

export interface CorpusCase {
  readonly name: string;
  readonly source: string;
  /** Stable across machines: `packages/pipeline/test/corpus/<kind>/<name>.yaml`. */
  readonly sourcePath: string;
  readonly expectedPath: string;
}

export function listCorpus(kind: "valid" | "invalid"): readonly CorpusCase[] {
  const directory = join(corpusRoot, kind);
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".yaml"))
    .sort()
    .map((entry) => {
      const name = entry.replace(/\.yaml$/, "");
      return {
        name,
        source: readFileSync(join(directory, entry), "utf8"),
        sourcePath: `packages/pipeline/test/corpus/${kind}/${entry}`,
        expectedPath: join(expectedRoot, kind, `${name}.json`),
      };
    });
}

export interface EquivalenceGroup {
  readonly name: string;
  readonly variants: readonly CorpusCase[];
}

export function listEquivalenceGroups(): readonly EquivalenceGroup[] {
  const directory = join(corpusRoot, "equivalent");
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      variants: readdirSync(join(directory, name))
        .filter((entry) => entry.endsWith(".yaml"))
        .sort()
        .map((entry) => ({
          name: `${name}/${entry.replace(/\.yaml$/, "")}`,
          source: readFileSync(join(directory, name, entry), "utf8"),
          sourcePath: `packages/pipeline/test/corpus/equivalent/${name}/${entry}`,
          expectedPath: join(expectedRoot, "equivalent", `${name}.json`),
        })),
    }));
}

export function readExpected(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
