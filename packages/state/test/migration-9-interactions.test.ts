import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle } from "../src/database/open.js";
import {
  assignBackendExecution,
  commitStateChange,
  compareInteractionProjectionToJournal,
  createStageExecution,
  openStateDatabase,
  readRunInteractions,
  runMigrations,
  type StateDatabase,
} from "../src/index.js";
import { MIGRATIONS } from "../src/migrations/list.js";
import { runMigrationList } from "../src/migrations/migrate.js";
import type { Migration } from "../src/migrations/migration.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const HASH = "b".repeat(64);
let directory: string;
let db: StateDatabase;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  db = openStateDatabase({
    path: temp.path,
    clock: createFakeClock(Date.parse("2026-08-08T12:00:00.000Z")),
    ids: createDeterministicIds(1),
  });
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function migrateToV8AndSeed(): void {
  runMigrationList(db, MIGRATIONS, 8);
  commitStateChange(db, {
    type: "codebase.registration_committed",
    payload: {
      registration: {
        codebaseId: "codebase-m9",
        configurationSha256: HASH,
        instructionSnapshot: {},
        name: "migration-9",
        repositories: [
          {
            defaultBranch: "main",
            defaultRemote: "origin",
            gitCommonDirectory: "/tmp/m9/.git",
            name: "migration-9",
            path: "/tmp/m9",
            remotes: [],
            repositoryId: "repository-m9",
          },
        ],
        rootPath: "/tmp/m9",
        topologySha256: HASH,
      },
    },
  });
  commitStateChange(db, {
    type: "workspace.registered",
    payload: { workspaceId: "workspace-m9", codebaseId: "codebase-m9" },
  });
  commitStateChange(db, {
    runId: "run-m9",
    type: "run.created",
    payload: { runId: "run-m9", codebaseId: "codebase-m9" },
  });
  createStageExecution(db, {
    runId: "run-m9",
    stageId: "stage-m9",
    codebaseId: "codebase-m9",
    repositoryId: "repository-m9",
    workspaceId: "workspace-m9",
    backendKind: "claudexor-v2",
    prompt: "Migrate interactions.",
    artifactPath: "artifacts/migration.md",
    limits: {},
  });
  assignBackendExecution(db, "run-m9", "thread-m9");

  const insert = internalHandle(db).prepare(
    `INSERT INTO execution_interaction
      (run_id, interaction_id, payload_json, answer_json, state, updated_at)
     VALUES ('run-m9', ?, ?, ?, ?, ?)`,
  );
  const payload = (id: string, requestedAt: string) =>
    JSON.stringify({
      schemaVersion: 2,
      id,
      questions: [
        { id: `question-${id}`, prompt: `Prompt ${id}`, options: [], multiSelect: false },
      ],
      requestedAt,
    });
  insert.run(
    "interaction-pending",
    payload("interaction-pending", "2026-08-08T10:00:00.000Z"),
    null,
    "pending",
    "2026-08-08T10:00:01.000Z",
  );
  insert.run(
    "interaction-answered",
    payload("interaction-answered", "2026-08-08T10:00:02.000Z"),
    JSON.stringify({
      schemaVersion: 1,
      interactionId: "interaction-answered",
      answers: [
        {
          questionId: "question-interaction-answered",
          selectedLabels: [],
          freeText: "Legacy answer",
        },
      ],
    }),
    "answered",
    "2026-08-08T10:00:03.000Z",
  );
  insert.run(
    "interaction-unresolved",
    payload("interaction-unresolved", "2026-08-08T10:00:04.000Z"),
    null,
    "resolved",
    "2026-08-08T10:00:05.000Z",
  );
}

describe("Q020 migration 9", () => {
  it("losslessly upgrades v8 pending, answered, and unresolved interaction rows", () => {
    migrateToV8AndSeed();
    runMigrations(db);

    expect(readRunInteractions(db, "run-m9")).toMatchObject([
      {
        interactionId: "interaction-pending",
        status: "pending",
        revision: 1,
        deliveryState: "not_applicable",
      },
      {
        interactionId: "interaction-answered",
        status: "answered",
        revision: 2,
        deliveryState: "delivered",
      },
      {
        interactionId: "interaction-unresolved",
        status: "cancelled",
        revision: 2,
        cancellationReason: "migration_unresolved",
      },
    ]);
    const handle = internalHandle(db);
    expect(
      handle
        .prepare(
          `SELECT source_answer_json, canonical_answer_json, answered_by_key_id
             FROM interaction_answer_record WHERE interaction_id = 'interaction-answered'`,
        )
        .get(),
    ).toMatchObject({
      source_answer_json: expect.stringContaining("Legacy answer"),
      canonical_answer_json: null,
      answered_by_key_id: "legacy-migration",
    });
    expect(
      handle
        .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'execution_interaction'")
        .get()?.count,
    ).toBe(0);
    expect(compareInteractionProjectionToJournal(db)).toEqual({
      status: "exact",
      divergences: [],
    });
  });

  it("rolls an interrupted v9 step back completely and retries cleanly", () => {
    migrateToV8AndSeed();
    const migration9 = MIGRATIONS.find((migration) => migration.version === 9);
    if (migration9 === undefined) throw new Error("migration 9 is missing");
    const interrupted: Migration = {
      ...migration9,
      statements: [
        ...migration9.statements.slice(0, 8),
        "INSERT INTO table_that_does_not_exist VALUES (1)",
        ...migration9.statements.slice(8),
      ],
    };
    expect(() => runMigrationList(db, [...MIGRATIONS.slice(0, 8), interrupted])).toThrow(
      'migration "durable-interactions" failed',
    );
    expect(db.schemaVersion).toBe(8);
    expect(
      internalHandle(db)
        .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'interaction_record'")
        .get()?.count,
    ).toBe(0);
    expect(
      internalHandle(db).prepare("SELECT count(*) AS count FROM execution_interaction").get()
        ?.count,
    ).toBe(3);

    runMigrations(db);
    expect(db.schemaVersion).toBe(10);
    expect(readRunInteractions(db, "run-m9")).toHaveLength(3);
    expect(compareInteractionProjectionToJournal(db).status).toBe("exact");
  });
});
