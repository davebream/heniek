import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionTaskId, ParentHandoff, SourceWorkItemId } from "@heniek/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { recoverArtifacts } from "../src/artifact/recover.js";
import { createArtifactStore } from "../src/artifact/store.js";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { runMigrations } from "../src/migrations/migrate.js";
import {
  createTaskIngestionSource,
  TaskSourceConflictError,
  TaskSourceInputError,
} from "../src/task-source/ingest.js";
import { applyTaskRevisionPatch, TaskRevisionPatchError } from "../src/task-source/json-patch.js";
import { createTaskSourceStateStore } from "../src/task-source/store.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

let directory = "";
let db: StateDatabase | undefined;

afterEach(async () => {
  db?.close();
  db = undefined;
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

function handoff(objective = "Implement Q039."): ParentHandoff {
  return {
    schemaVersion: 1,
    objective,
    constraints: ["Preserve this requirement verbatim."],
    decisions: [
      { statement: "Use JSON Patch.", author: "maintainer", rationale: "It is standard." },
    ],
    openQuestions: [],
    repositoryReferences: ["davebream/heniek"],
    requirements: [
      { requirementId: "R-1", text: "Keep **Markdown** exactly.", sourcePointer: "/body/1" },
    ],
  };
}

async function fixture() {
  const temporary = await makeTempDbPath();
  directory = temporary.directory;
  const clock = createFakeClock();
  const ids = createDeterministicIds(1);
  db = openStateDatabase({ path: temporary.path, clock, ids });
  runMigrations(db);
  const artifacts = createArtifactStore({ root: join(directory, "artifacts"), clock, ids });
  const state = createTaskSourceStateStore(db);
  return {
    artifacts,
    clock,
    path: temporary.path,
    state,
    source: createTaskIngestionSource({ artifacts, clock, ids, state }),
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    sourceWorkItemId: "source-1" as SourceWorkItemId,
    sourceKind: "parent_conversation",
    sourceUri: "heniek-parent://session/source-1",
    observedVersion: "turn-1",
    rawContent: "# Exact source\n",
    handoff: handoff(),
    attachments: [
      {
        uri: "heniek-parent://session/source-1/attachment/spec.md",
        name: "spec.md",
        mediaType: "text/markdown",
        observedVersion: "1",
        content: "attachment bytes",
      },
    ],
    hierarchy: {
      trackerEdges: [
        {
          parentSourceWorkItemId: "source-1" as SourceWorkItemId,
          childSourceWorkItemId: "source-2" as SourceWorkItemId,
        },
      ],
      executionMappings: [
        {
          sourceWorkItemId: "source-1" as SourceWorkItemId,
          executionTaskIds: ["execution-1" as ExecutionTaskId],
        },
      ],
    },
    author: "maintainer",
    reason: "Initial ingestion.",
    ...overrides,
  };
}

describe("Q039 task-source ingestion and persistence", () => {
  it("publishes immutable snapshots, is idempotent, and persists across restart", async () => {
    const { source, state, path, artifacts } = await fixture();
    const first = await source.load(input());
    const repeated = await source.load(input());
    expect(repeated).toEqual(first);
    expect(first.snapshot.requirements[0]?.text).toBe("Keep **Markdown** exactly.");
    expect(first.snapshot.attachments).toHaveLength(1);
    expect(first.hierarchy.trackerEdges).toHaveLength(1);
    expect(first.hierarchy.executionMappings[0]?.executionTaskIds).toEqual(["execution-1"]);
    expect(state.revisions("source-1" as SourceWorkItemId)).toHaveLength(1);
    expect(recoverArtifacts(artifacts, db as StateDatabase).unreferencedBlobs).toEqual([]);

    expect(() =>
      internalHandle(db as StateDatabase)
        .prepare("UPDATE task_source_snapshot SET observed_version = 'mutated'")
        .run(),
    ).toThrow(/immutable/);

    db?.close();
    db = openStateDatabase({
      path,
      clock: createFakeClock(),
      ids: createDeterministicIds(100),
    });
    runMigrations(db);
    expect(createTaskSourceStateStore(db).load("source-1" as SourceWorkItemId)).toEqual(first);
  });

  it("creates an exact revision chain and supersedes only the prior active revision", async () => {
    const { source, state, clock } = await fixture();
    const first = await source.load(input());
    clock.advance(1_000);
    const second = await source.load(
      input({
        observedVersion: "turn-2",
        rawContent: "# Revised source\n",
        handoff: handoff("Implement Q039 with durable revisions."),
        reason: "Accepted source update.",
      }),
    );
    expect(second.activeRevision.ordinal).toBe(2);
    expect(second.activeRevision.predecessorRevisionId).toBe(first.activeRevision.revisionId);
    expect(
      applyTaskRevisionPatch(first.activeRevision.document, second.activeRevision.patch),
    ).toEqual(second.activeRevision.document);
    expect(
      state.revisions("source-1" as SourceWorkItemId).map((revision) => revision.supersessionState),
    ).toEqual(["superseded", "active"]);
  });

  it("rejects conflicting observed versions, hierarchy cycles, and failed JSON Patch tests", async () => {
    const { source } = await fixture();
    await source.load(input());
    await expect(source.load(input({ rawContent: "different" }))).rejects.toBeInstanceOf(
      TaskSourceConflictError,
    );
    await expect(
      source.load(
        input({
          observedVersion: "turn-2",
          hierarchy: {
            trackerEdges: [
              {
                parentSourceWorkItemId: "source-1" as SourceWorkItemId,
                childSourceWorkItemId: "source-2" as SourceWorkItemId,
              },
              {
                parentSourceWorkItemId: "source-2" as SourceWorkItemId,
                childSourceWorkItemId: "source-1" as SourceWorkItemId,
              },
            ],
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TaskSourceInputError);
    expect(() =>
      applyTaskRevisionPatch(handoff() as never, [
        { op: "test", path: "/objective", value: "wrong" },
      ]),
    ).toThrow(TaskRevisionPatchError);
  });

  it("replays seeded revision chains without forks or digest drift", async () => {
    const { source, state, clock } = await fixture();
    let previous = await source.load(input({ attachments: [] }));
    for (let ordinal = 2; ordinal <= 25; ordinal += 1) {
      clock.advance(1);
      const current = await source.load(
        input({
          observedVersion: `turn-${ordinal}`,
          rawContent: `source-${ordinal}`,
          attachments: [],
          handoff: handoff(`Objective ${ordinal}`),
          reason: `Revision ${ordinal}.`,
        }),
      );
      expect(current.activeRevision.predecessorRevisionId).toBe(previous.activeRevision.revisionId);
      expect(
        applyTaskRevisionPatch(previous.activeRevision.document, current.activeRevision.patch),
      ).toEqual(current.activeRevision.document);
      previous = current;
    }
    const revisions = state.revisions("source-1" as SourceWorkItemId);
    expect(revisions).toHaveLength(25);
    expect(revisions.filter((revision) => revision.supersessionState === "active")).toHaveLength(1);
  });
});
