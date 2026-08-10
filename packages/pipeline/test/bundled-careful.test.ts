import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getBundledPipeline,
  listBundledPipelines,
  loadBundledPipeline,
  renderPipelineGraph,
} from "../src/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("bundled careful.v1", () => {
  it("is generated, loadable, and integrity pinned", async () => {
    expect(listBundledPipelines()).toContain("careful.v1");
    const disk = await readFile(join(packageRoot, "bundled", "careful.v1.yaml"), "utf8");
    const entry = getBundledPipeline("careful", 1);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.source).toBe(disk);
    expect(entry.sourceSha256).toBe(sha256(disk));
    const loaded = loadBundledPipeline("careful", 1);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(sha256(renderPipelineGraph(loaded.graph))).toBe(entry.normalizedGraphSha256);
  });

  it("pins stages, fresh reviewers, repair budget, and conditional gates", () => {
    const loaded = loadBundledPipeline("careful", 1);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const stages = new Map<string, (typeof loaded.graph.stages)[number]>(
      loaded.graph.stages.map((stage) => [stage.id, stage]),
    );
    expect([...stages.keys()].sort()).toEqual([
      "build",
      "code-review",
      "critique",
      "final-verification",
      "plan-review",
      "publish",
      "repair",
      "revise-plan",
      "understand-design",
      "verify",
    ]);
    for (const id of ["critique", "plan-review", "code-review", "final-verification"]) {
      expect(stages.get(id)?.session?.policy).toBe("fresh");
    }
    expect(stages.get("revise-plan")?.session?.policy).toBe("resume");
    expect(stages.get("repair")?.session?.policy).toBe("resume");
    expect(stages.get("repair")?.onValidationFailure?.maxAttempts).toBe(2);
    expect(loaded.graph.limits.maxRepairAttempts).toBe(2);
    expect(loaded.graph.edges.filter((edge) => edge.condition !== undefined)).toHaveLength(2);
    expect(renderPipelineGraph(loaded.graph)).toMatchSnapshot();
  });
});
