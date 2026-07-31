import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SEED } from "../src/kernel/seed.js";
import { buildConformanceMatrix, renderConformanceMatrixMarkdown } from "../src/matrix.js";
import { recordFailureReplay } from "../src/replay.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedRoot = resolve(packageRoot, "generated");
const checkOnly = process.argv.includes("--check");

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const matrix = buildConformanceMatrix();
const replay = await recordFailureReplay(DEFAULT_SEED);

const outputs = new Map<string, string>([
  [resolve(generatedRoot, "conformance-matrix.json"), canonicalJson(matrix)],
  [resolve(generatedRoot, "conformance-matrix.md"), renderConformanceMatrixMarkdown(matrix)],
  [resolve(generatedRoot, "failure-replay.json"), canonicalJson(replay)],
]);

for (const [path, content] of outputs) {
  if (checkOnly) {
    const existing = await readFile(path, "utf8").catch(() => "");
    if (existing !== content) {
      throw new Error(`Generated conformance artifact is stale: ${path}`);
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}
