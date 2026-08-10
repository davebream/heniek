/**
 * Read-only lookup for immutable bundled pipeline templates.
 */

import { createHash } from "node:crypto";
import { type ParsePipelineResult, parsePipelineDocument } from "../parse.js";
import { renderPipelineGraph } from "../render.js";
import {
  BUNDLED_PIPELINE_MANIFEST,
  type BundledPipelineId,
  type BundledPipelineManifestEntry,
} from "./manifest.generated.js";

export type { BundledPipelineId, BundledPipelineManifestEntry };

const PUBLIC_PROFILE_IDS_BY_TEMPLATE: Readonly<Record<string, readonly string[]>> = {
  "fast.v1": ["task-owner", "reviewer"],
  "careful.v1": ["designer", "critic", "plan-reviewer", "builder", "code-reviewer", "verifier"],
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function listBundledPipelines(): readonly BundledPipelineId[] {
  return Object.keys(BUNDLED_PIPELINE_MANIFEST) as BundledPipelineId[];
}

export function getBundledPipeline(
  id: string,
  version = 1,
): BundledPipelineManifestEntry | undefined {
  const key = `${id}.v${version}` as BundledPipelineId;
  return BUNDLED_PIPELINE_MANIFEST[key];
}

export function requireBundledPipeline(id: string, version = 1): BundledPipelineManifestEntry {
  const entry = getBundledPipeline(id, version);
  if (entry === undefined) {
    throw new Error(`Unknown bundled pipeline template: ${id}.v${version}`);
  }
  return entry;
}

/**
 * Parse a bundled template and assert YAML / embedded source / normalized
 * graph hashes have not drifted from the generation-time pins.
 */
export function loadBundledPipeline(
  id: string,
  version = 1,
): ParsePipelineResult & {
  readonly entry: BundledPipelineManifestEntry;
  readonly normalizedGraphSha256: string;
} {
  const entry = requireBundledPipeline(id, version);
  const key = `${id}.v${version}`;
  const knownProfileIds = PUBLIC_PROFILE_IDS_BY_TEMPLATE[key];
  const sourceSha256 = sha256(entry.source);
  if (sourceSha256 !== entry.sourceSha256) {
    throw new Error(
      `Bundled pipeline ${key} embedded source SHA-256 drifted (expected ${entry.sourceSha256}, got ${sourceSha256})`,
    );
  }
  const parsed = parsePipelineDocument(entry.source, {
    sourcePath: `${key}.yaml`,
    ...(knownProfileIds === undefined ? {} : { knownProfileIds }),
  });
  if (!parsed.ok) {
    return { ...parsed, entry, normalizedGraphSha256: entry.normalizedGraphSha256 };
  }
  const normalizedGraphSha256 = sha256(renderPipelineGraph(parsed.graph));
  if (normalizedGraphSha256 !== entry.normalizedGraphSha256) {
    throw new Error(
      `Bundled pipeline ${key} normalized graph SHA-256 drifted (expected ${entry.normalizedGraphSha256}, got ${normalizedGraphSha256})`,
    );
  }
  return { ...parsed, entry, normalizedGraphSha256 };
}
