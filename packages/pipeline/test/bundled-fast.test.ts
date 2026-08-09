import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConditionExpression } from "../src/expression/parse.js";
import {
  getBundledPipeline,
  initialStageSnapshots,
  listBundledPipelines,
  loadBundledPipeline,
  type PipelineGraph,
  parsePipelineDocument,
  renderPipelineGraph,
  tickScheduler,
} from "../src/index.js";

const packageRoot = resolvePackageRoot();
const yamlPath = join(packageRoot, "bundled", "fast.v1.yaml");

function resolvePackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expression(source: string) {
  const parsed = parseConditionExpression(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return { kind: "expression" as const, nodes: parsed.nodes, root: parsed.root };
}

function succeedStage(
  base: Parameters<typeof tickScheduler>[0],
  stages: Parameters<typeof tickScheduler>[0]["stages"],
  scheduleRevision: number,
  stageId: string,
  attemptId: string,
  canonicalState: unknown,
) {
  const afterStart = tickScheduler({
    ...base,
    scheduleRevision,
    stages,
    observations: [
      {
        schemaVersion: 1,
        observationId: `${stageId}-start-${scheduleRevision}`,
        kind: "attempt_started",
        stageId,
        attemptId,
        recordedAt: "2026-08-10T00:00:01.000Z",
      },
    ],
    canonicalState,
  });
  return tickScheduler({
    ...base,
    scheduleRevision: scheduleRevision + 1,
    stages: afterStart.stagePatches,
    observations: [
      {
        schemaVersion: 1,
        observationId: `${stageId}-ok-${scheduleRevision}`,
        kind: "attempt_succeeded",
        stageId,
        attemptId,
        recordedAt: "2026-08-10T00:00:02.000Z",
      },
    ],
    canonicalState,
  });
}

describe("bundled fast.v1", () => {
  it("is listed and loadable with pinned hashes", async () => {
    expect(listBundledPipelines()).toContain("fast.v1");
    const disk = await readFile(yamlPath, "utf8");
    const entry = getBundledPipeline("fast", 1);
    expect(entry).toBeDefined();
    expect(entry!.sourceSha256).toBe(sha256(disk));
    expect(entry!.source).toBe(disk);

    const loaded = loadBundledPipeline("fast", 1);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.normalizedGraphSha256).toBe(entry!.normalizedGraphSha256);
    expect(sha256(renderPipelineGraph(loaded.graph))).toBe(entry!.normalizedGraphSha256);
  });

  it("parses with public profiles and pins normalized graph JSON", () => {
    const entry = getBundledPipeline("fast", 1)!;
    const parsed = parsePipelineDocument(entry.source, {
      sourcePath: "fast.v1.yaml",
      knownProfileIds: ["task-owner", "reviewer"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.graph.pipelineId).toBe("fast");
    expect(parsed.graph.stages.map((stage) => stage.id)).toEqual([
      "build",
      "deliberate",
      "publish",
      "risk-review",
      "verify",
    ]);
    expect(renderPipelineGraph(parsed.graph)).toMatchSnapshot();
  });

  it("routes risk-review when risk.requiresFreshReview is true", () => {
    const loaded = loadBundledPipeline("fast", 1);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const graph = loaded.graph as PipelineGraph;
    const now = "2026-08-10T00:00:00.000Z";
    const base = {
      schemaVersion: 1 as const,
      runId: "run_fast",
      pipelineId: "fast",
      graphRevision: 1,
      scheduleRevision: 1,
      now,
      graph,
      stages: initialStageSnapshots({ runId: "run_fast", graphRevision: 1, graph, now }),
      observations: [],
      intents: [],
      evaluatorDecisions: [],
      pendingEvaluatorEdgeKeys: [],
      canonicalState: { risk: { requiresFreshReview: true } },
    };
    const first = tickScheduler(base);
    const deliberateAttempt = first.attempts.find((a) => a.stageId === "deliberate");
    expect(deliberateAttempt).toBeDefined();
    const afterDeliberate = succeedStage(
      base,
      first.stagePatches,
      2,
      "deliberate",
      deliberateAttempt!.attemptId,
      {
        risk: { requiresFreshReview: true },
        artifacts: { understanding: true, design: true, plan: true },
      },
    );
    expect(afterDeliberate.stagePatches.find((s) => s.stageId === "build")?.state).toBe("queued");
    const buildAttempt = afterDeliberate.attempts.find((a) => a.stageId === "build");
    expect(buildAttempt).toBeDefined();
    const afterBuild = succeedStage(
      base,
      afterDeliberate.stagePatches,
      4,
      "build",
      buildAttempt!.attemptId,
      {
        risk: { requiresFreshReview: true },
        artifacts: {
          understanding: true,
          design: true,
          plan: true,
          implementation: true,
        },
      },
    );
    expect(afterBuild.stagePatches.find((s) => s.stageId === "risk-review")?.state).toBe("queued");
  });

  it("skips risk-review when risk.requiresFreshReview is false", () => {
    const loaded = loadBundledPipeline("fast", 1);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const graph = loaded.graph as PipelineGraph;
    const now = "2026-08-10T00:00:00.000Z";
    const base = {
      schemaVersion: 1 as const,
      runId: "run_fast_skip",
      pipelineId: "fast",
      graphRevision: 1,
      scheduleRevision: 1,
      now,
      graph,
      stages: initialStageSnapshots({ runId: "run_fast_skip", graphRevision: 1, graph, now }),
      observations: [],
      intents: [],
      evaluatorDecisions: [],
      pendingEvaluatorEdgeKeys: [],
      canonicalState: { risk: { requiresFreshReview: false } },
    };
    const first = tickScheduler(base);
    const deliberateAttempt = first.attempts.find((a) => a.stageId === "deliberate");
    const afterDeliberate = succeedStage(
      base,
      first.stagePatches,
      2,
      "deliberate",
      deliberateAttempt!.attemptId,
      {
        risk: { requiresFreshReview: false },
        artifacts: { understanding: true, design: true, plan: true },
      },
    );
    const buildAttempt = afterDeliberate.attempts.find((a) => a.stageId === "build");
    const afterBuild = succeedStage(
      base,
      afterDeliberate.stagePatches,
      4,
      "build",
      buildAttempt!.attemptId,
      {
        risk: { requiresFreshReview: false },
        artifacts: {
          understanding: true,
          design: true,
          plan: true,
          implementation: true,
        },
      },
    );
    expect(afterBuild.stagePatches.find((s) => s.stageId === "risk-review")?.state).toBe(
      "cancelled",
    );
    expect(afterBuild.stagePatches.find((s) => s.stageId === "verify")?.state).toBe("queued");
  });

  it("keeps expression AST for the risk-review edge", () => {
    const condition = expression("risk.requiresFreshReview == true");
    expect(condition.nodes.some((node) => node.kind === "path")).toBe(true);
  });
});
