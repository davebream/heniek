/**
 * Durable pipeline admission store — snapshots and ad-hoc attachment (Q032).
 */

import { rm } from "node:fs/promises";
import type { PipelineAttachRequestV1, PipelineRunSnapshotV1 } from "@heniek/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle } from "../src/database/open.js";
import { StateStoreError } from "../src/errors.js";
import {
  attachAdHocStage,
  createPipelineSchedule,
  openStateDatabase,
  type PipelineGraph,
  readCanonicalRunState,
  readPipelineAttachment,
  readPipelineGraph,
  readPipelineRunSnapshot,
  readPipelineSchedule,
  readPipelineStageProjections,
  runMigrations,
  type StateDatabase,
  upsertCanonicalRunState,
  writePipelineRunSnapshot,
} from "../src/index.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const NOW = "2026-08-10T10:00:00.000Z";
const DIGEST = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function baseGraph(limits?: PipelineGraph["limits"]): PipelineGraph {
  return {
    schemaVersion: 1,
    pipelineId: "linear",
    mode: "autonomous",
    limits: limits ?? { maxRepairAttempts: 1, maxGraphRevisions: 5 },
    context: {},
    stages: [
      {
        id: "design",
        type: "agent",
        mode: "autonomous",
        optional: false,
        profile: "designer",
        reads: ["task.current"],
        writes: ["artifacts.design"],
        overridable: [],
      },
      {
        id: "build",
        type: "command",
        mode: "autonomous",
        optional: false,
        command: { argv: ["echo", "ok"], cwd: "." },
        reads: ["artifacts.design"],
        writes: ["artifacts.build"],
        overridable: [],
      },
    ],
    edges: [{ from: "design", to: "build" }],
  } as never;
}

function augmentedGraph(): PipelineGraph {
  const graph = baseGraph();
  return {
    ...graph,
    stages: [
      ...graph.stages,
      {
        id: "adhoc-fix",
        type: "agent",
        mode: "autonomous",
        optional: false,
        profile: "fixer",
        reads: ["artifacts.design"],
        writes: ["artifacts.fix"],
        overridable: [],
      } as never,
    ],
    edges: [...graph.edges, { from: "adhoc-fix", to: "build" }],
  } as never;
}

function snapshotFor(runId: string): PipelineRunSnapshotV1 {
  const graph = baseGraph();
  return {
    schemaVersion: 1,
    runId: runId as never,
    pipelineId: "linear" as never,
    source: {
      schemaVersion: 1,
      kind: "bundled",
      identity: "linear",
      digest: DIGEST,
    },
    baseGraph: graph,
    effectiveGraph: graph,
    baseGraphDigest: DIGEST,
    effectiveGraphDigest: DIGEST,
    resolvedProfiles: [],
    requestedOverrides: [],
    appliedOverrides: [],
    effectiveLimits: { maxRepairAttempts: 1, maxGraphRevisions: 5 },
    recordedAt: NOW,
  };
}

function attachRequest(overrides: Partial<PipelineAttachRequestV1> = {}): PipelineAttachRequestV1 {
  return {
    schemaVersion: 1,
    attachmentId: "attach-1",
    sourceRunId: "run-source" as never,
    sourceStageId: "fix" as never,
    targetRunId: "run-1" as never,
    stage: {
      schemaVersion: 1,
      id: "adhoc-fix" as never,
      type: "agent",
      profile: "fixer",
      mode: "autonomous",
      optional: false,
      reads: ["artifacts.design"],
      writes: ["artifacts.fix"],
      overridable: [],
    },
    dependantStageIds: ["build" as never],
    expectedRunRevision: 1,
    expectedGraphRevision: 1,
    expectedScheduleRevision: 1,
    ...overrides,
  };
}

let directory: string;
let db: StateDatabase;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  db = openStateDatabase({
    path: temp.path,
    clock: createFakeClock(Date.parse(NOW)),
    ids: createDeterministicIds(1),
  });
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function seedTargetRun(graph: PipelineGraph = baseGraph()): void {
  createPipelineSchedule(db, {
    runId: "run-1",
    pipelineId: "linear",
    graph,
    now: NOW,
  });
  const result = upsertCanonicalRunState(db, {
    runId: "run-1",
    state: { task: { current: "x" } },
    now: NOW,
  });
  expect(result.status).toBe("applied");
  expect(result.revision).toBe(1);
}

describe("pipeline admission store — run snapshots", () => {
  it("writes and reads an immutable snapshot", () => {
    const snapshot = snapshotFor("run-snap");
    writePipelineRunSnapshot(db, snapshot);
    expect(readPipelineRunSnapshot(db, "run-snap")).toEqual(snapshot);
  });

  it("rejects a second write for the same run_id", () => {
    const snapshot = snapshotFor("run-snap");
    writePipelineRunSnapshot(db, snapshot);
    expect(() =>
      writePipelineRunSnapshot(db, { ...snapshot, recordedAt: "2026-08-10T11:00:00.000Z" }),
    ).toThrow(StateStoreError);
    expect(readPipelineRunSnapshot(db, "run-snap")?.recordedAt).toBe(NOW);
  });
});

describe("pipeline admission store — attachAdHocStage", () => {
  it("attaches a stage, bumps graph revision, and marks the attached stage succeeded", () => {
    seedTargetRun();
    const request = attachRequest();
    const result = attachAdHocStage(db, {
      request,
      requestDigest: DIGEST,
      now: NOW,
      augmentedGraph: augmentedGraph(),
      sourceArtifactLinks: [],
      validationEvidence: { ok: true },
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") {
      throw new Error("expected committed");
    }
    expect(result.lifecycle.phase).toBe("committed");
    expect(result.lifecycle.graphRevisionBefore).toBe(1);
    expect(result.lifecycle.graphRevisionAfter).toBe(2);
    expect(result.lifecycle.scheduleRevisionAfter).toBe(2);
    expect(result.lifecycle.runRevisionAfter).toBe(2);

    const schedule = readPipelineSchedule(db, "run-1");
    expect(schedule?.graphRevision).toBe(2);
    expect(schedule?.scheduleRevision).toBe(2);

    const graph = readPipelineGraph(db, "run-1", 2);
    expect(graph.stages.some((stage) => stage.id === "adhoc-fix")).toBe(true);

    const stages = readPipelineStageProjections(db, "run-1");
    expect(stages).toHaveLength(3);
    const attached = stages.find((stage) => stage.stageId === "adhoc-fix");
    expect(attached).toMatchObject({
      state: "succeeded",
      generation: 1,
      attemptOrdinal: 1,
      selected: true,
      graphRevision: 2,
      lastTransitionReason: "attempt_succeeded",
    });
    expect(stages.every((stage) => stage.graphRevision === 2)).toBe(true);

    expect(readCanonicalRunState(db, "run-1")?.revision).toBe(2);
    expect(readPipelineAttachment(db, "attach-1")?.lifecycle.phase).toBe("committed");
  });

  it("rejects stale schedule revisions", () => {
    seedTargetRun();
    const result = attachAdHocStage(db, {
      request: attachRequest({ expectedScheduleRevision: 99 }),
      requestDigest: DIGEST,
      now: NOW,
      augmentedGraph: augmentedGraph(),
      sourceArtifactLinks: [],
      validationEvidence: {},
    });
    expect(result).toEqual({ status: "rejected", code: "stale-schedule" });
    expect(readPipelineSchedule(db, "run-1")?.graphRevision).toBe(1);
  });

  it("returns idempotent-replay for the same attachment id and digest", () => {
    seedTargetRun();
    const request = attachRequest();
    const first = attachAdHocStage(db, {
      request,
      requestDigest: DIGEST,
      now: NOW,
      augmentedGraph: augmentedGraph(),
      sourceArtifactLinks: [],
      validationEvidence: { n: 1 },
    });
    expect(first.status).toBe("committed");

    const second = attachAdHocStage(db, {
      request,
      requestDigest: DIGEST,
      now: NOW,
      augmentedGraph: augmentedGraph(),
      sourceArtifactLinks: [],
      validationEvidence: { n: 2 },
    });
    expect(second.status).toBe("idempotent-replay");
    if (second.status !== "idempotent-replay") {
      throw new Error("expected idempotent-replay");
    }
    expect(second.lifecycle.phase).toBe("idempotent-replay");
    expect(second.lifecycle.graphRevisionAfter).toBe(2);
    expect(readPipelineSchedule(db, "run-1")?.graphRevision).toBe(2);
    expect(readCanonicalRunState(db, "run-1")?.revision).toBe(2);
  });

  it("rejects a conflicting attachment id with a different digest", () => {
    seedTargetRun();
    const request = attachRequest();
    expect(
      attachAdHocStage(db, {
        request,
        requestDigest: DIGEST,
        now: NOW,
        augmentedGraph: augmentedGraph(),
        sourceArtifactLinks: [],
        validationEvidence: {},
      }).status,
    ).toBe("committed");

    const conflict = attachAdHocStage(db, {
      request: attachRequest({
        // Same attachment id; different digest and stage would still conflict on id.
        dependantStageIds: [],
      }),
      requestDigest: DIGEST_B,
      now: NOW,
      augmentedGraph: augmentedGraph(),
      sourceArtifactLinks: [],
      validationEvidence: {},
    });
    expect(conflict).toEqual({ status: "rejected", code: "attachment-id-conflict" });
  });

  it("rejects attachment when the target run is not quiescent", () => {
    seedTargetRun();
    internalHandle(db)
      .prepare(
        `UPDATE pipeline_stage_projection
            SET state = 'running', attempt_ordinal = 1, updated_at = ?
          WHERE run_id = 'run-1' AND stage_id = 'design'`,
      )
      .run(NOW);

    const result = attachAdHocStage(db, {
      request: attachRequest(),
      requestDigest: DIGEST,
      now: NOW,
      augmentedGraph: augmentedGraph(),
      sourceArtifactLinks: [],
      validationEvidence: {},
    });
    expect(result).toEqual({ status: "rejected", code: "not-quiescent" });
    expect(readPipelineSchedule(db, "run-1")?.graphRevision).toBe(1);
  });
});
