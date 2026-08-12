import { rm } from "node:fs/promises";
import type { HiddenDependencyFinding, RunId, TaskGraphRevisionProposal } from "@heniek/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { StateStoreError } from "../src/errors.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { createHiddenDependencyReplanStateStore } from "../src/task-graph/replanning-store.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const NOW = "2026-08-12T12:00:00.000Z";
const HASH = "a".repeat(64);
let directory = "";
let db: StateDatabase | undefined;

afterEach(async () => {
  db?.close();
  db = undefined;
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const temporary = await makeTempDbPath();
  directory = temporary.directory;
  const clock = createFakeClock();
  db = openStateDatabase({ path: temporary.path, clock, ids: createDeterministicIds(1) });
  runMigrations(db);
  const handle = internalHandle(db);
  const codebaseEvent = handle
    .prepare(`INSERT INTO state_event
      (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)
      VALUES ('event-codebase', NULL, 'correlation-1', NULL, 'codebase.registered', ?, '{}')`)
    .run(NOW);
  handle
    .prepare(`INSERT INTO codebase (codebase_id, revision, last_event_sequence, updated_at)
      VALUES ('codebase-1', 1, ?, ?)`)
    .run(Number(codebaseEvent.lastInsertRowid), NOW);
  const runEvent = handle
    .prepare(`INSERT INTO state_event
      (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)
      VALUES ('event-run', 'run-1', 'correlation-1', NULL, 'run.created', ?, '{}')`)
    .run(NOW);
  handle
    .prepare(`INSERT INTO run_projection
      (run_id, status, revision, last_event_sequence, codebase_id, updated_at)
      VALUES ('run-1', 'queued', 1, ?, 'codebase-1', ?)`)
    .run(Number(runEvent.lastInsertRowid), NOW);
  return { temporary, clock, store: createHiddenDependencyReplanStateStore(db) };
}

function inputs() {
  const finding = {
    schemaVersion: 1,
    findingId: "finding-1",
    runId: "run-1" as RunId,
    graphId: "graph-1",
    graphRevision: 1,
    revisionSha256: HASH,
    reporterTaskId: "T4",
    prerequisiteTaskIds: ["T2"],
    affectedTaskIds: ["T4"],
    rationale: "T4 requires T2.",
    evidenceArtifactIds: ["artifact-finding"],
    discoveredAt: NOW,
  } as unknown as HiddenDependencyFinding;
  const proposal = {
    schemaVersion: 2,
    runId: finding.runId,
    graphId: finding.graphId,
    expectedGraphRevision: 1,
    expectedRevisionSha256: HASH,
    proposedDag: {
      schemaVersion: 2,
      graphId: "graph-1",
      graphRevision: 2,
      nodes: [],
      createdAt: NOW,
    },
    changes: [],
    requirementMappings: [],
    rationale: "Replace T4.",
    evidenceArtifactIds: ["artifact-finding"],
    proposedAt: NOW,
    trigger: { kind: "hidden_dependency", findingId: "finding-1", interruptedTaskIds: ["T4"] },
  } as unknown as Extract<TaskGraphRevisionProposal, { schemaVersion: 2 }>;
  return { finding, proposal };
}

describe("Q045 hidden-dependency replanning state", () => {
  it("records findings before a causal, idempotent replan lifecycle", async () => {
    const { store } = await fixture();
    const input = { replanId: "replan-1", ...inputs(), replacementTaskIds: ["T4-r"] };
    expect(store.record(input).lifecycle).toBe("quiescing");
    expect(store.record(input)).toEqual(store.replans("run-1" as RunId)[0]);
    expect(store.findings("run-1" as RunId)).toHaveLength(1);
    expect(() =>
      store.advance({
        replanId: "replan-1",
        expectedLifecycle: "quiescing",
        lifecycle: "resumed",
      }),
    ).toThrow(StateStoreError);
    expect(
      store.advance({
        replanId: "replan-1",
        expectedLifecycle: "quiescing",
        lifecycle: "revising",
      }).revision,
    ).toBe(2);
    expect(
      store.advance({
        replanId: "replan-1",
        expectedLifecycle: "revising",
        lifecycle: "resumed",
        decisionId: "decision-1",
        resultingGraphRevision: 2,
      }),
    ).toMatchObject({ lifecycle: "resumed", revision: 3, resultingGraphRevision: 2 });
    expect(store.record(input).lifecycle).toBe("resumed");
  });

  it("rejects conflicting replay and preserves state across database restart", async () => {
    const { temporary, clock, store } = await fixture();
    const input = { replanId: "replan-1", ...inputs(), replacementTaskIds: ["T4-r"] };
    store.record(input);
    expect(() =>
      store.record({
        ...input,
        finding: { ...input.finding, rationale: "Different evidence." },
      }),
    ).toThrow(StateStoreError);
    db?.close();
    db = openStateDatabase({ path: temporary.path, clock, ids: createDeterministicIds(10) });
    runMigrations(db);
    expect(createHiddenDependencyReplanStateStore(db).active("run-1" as RunId)).toMatchObject({
      replanId: "replan-1",
      lifecycle: "quiescing",
    });
  });
});
