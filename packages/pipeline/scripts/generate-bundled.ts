/**
 * Generate the pure-ESM bundled-pipeline manifest from YAML sources.
 *
 * Drift checks: YAML bytes, embedded source string, and normalized graph
 * SHA-256 must agree. `--check` fails if generated output differs.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePipelineDocument } from "../src/parse.js";
import { renderPipelineGraph } from "../src/render.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundledRoot = join(packageRoot, "bundled");
const generatedPath = join(packageRoot, "src", "bundled", "manifest.generated.ts");
const checkOnly = process.argv.includes("--check");

const PUBLIC_FAST_PROFILES = ["task-owner", "reviewer"] as const;

interface BundledTemplateSpec {
  readonly id: string;
  readonly version: number;
  readonly yamlFile: string;
  readonly knownProfileIds: readonly string[];
}

const TEMPLATES: readonly BundledTemplateSpec[] = [
  {
    id: "fast",
    version: 1,
    yamlFile: "fast.v1.yaml",
    knownProfileIds: PUBLIC_FAST_PROFILES,
  },
];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function escapeForTemplateLiteral(source: string): string {
  return source.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

async function buildManifest(): Promise<string> {
  const entries: string[] = [];

  for (const template of TEMPLATES) {
    const yamlPath = join(bundledRoot, template.yamlFile);
    const source = await readFile(yamlPath, "utf8");
    const sourceSha256 = sha256(source);
    const parsed = parsePipelineDocument(source, {
      sourcePath: template.yamlFile,
      knownProfileIds: template.knownProfileIds,
    });
    if (!parsed.ok) {
      const codes = parsed.diagnostics.map((d) => d.code).join(", ");
      throw new Error(
        `Bundled template ${template.id}.v${template.version} failed to parse: ${codes}`,
      );
    }
    const graphJson = renderPipelineGraph(parsed.graph);
    const normalizedGraphSha256 = sha256(graphJson);
    const key = `${template.id}.v${template.version}`;

    entries.push(`  ${JSON.stringify(key)}: {
    id: ${JSON.stringify(template.id)},
    version: ${template.version},
    sourceSha256: ${JSON.stringify(sourceSha256)},
    normalizedGraphSha256: ${JSON.stringify(normalizedGraphSha256)},
    source: \`${escapeForTemplateLiteral(source)}\`,
  }`);
  }

  return `/* eslint-disable */
/**
 * GENERATED FILE — do not edit by hand.
 * Source: packages/pipeline/bundled/*.yaml
 * Regenerate: pnpm --filter @heniek/pipeline generate
 */
export interface BundledPipelineManifestEntry {
  readonly id: string;
  readonly version: number;
  readonly sourceSha256: string;
  readonly normalizedGraphSha256: string;
  readonly source: string;
}

export const BUNDLED_PIPELINE_MANIFEST = {
${entries.join(",\n")}
} as const satisfies Record<string, BundledPipelineManifestEntry>;

export type BundledPipelineId = keyof typeof BUNDLED_PIPELINE_MANIFEST;
`;
}

const next = await buildManifest();

if (checkOnly) {
  let current = "";
  try {
    current = await readFile(generatedPath, "utf8");
  } catch {
    throw new Error(`Missing generated bundled manifest at ${generatedPath}`);
  }
  if (current !== next) {
    throw new Error(
      "Bundled pipeline manifest is out of date. Run: pnpm --filter @heniek/pipeline generate",
    );
  }
  process.stdout.write("bundled pipeline manifest up to date\n");
} else {
  await mkdir(dirname(generatedPath), { recursive: true });
  await writeFile(generatedPath, next, "utf8");
  process.stdout.write(`wrote ${generatedPath}\n`);
}
