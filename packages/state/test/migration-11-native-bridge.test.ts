/**
 * Migration 11 (Q023, ADR 0021). Two witnesses — fresh and upgrade-from-10 —
 * plus the schema-level invariants the native bridge's fencing rests on.
 *
 * The constraint cases here deliberately test the *DDL*, not a store
 * function: the store must be free to be rewritten, and these guarantees
 * must survive that. If a future refactor drops the partial unique index or
 * an immutability trigger, the store's own tests could still pass — nothing
 * in JavaScript would notice — while the guarantee the acceptance criterion
 * rests on quietly disappeared.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle } from "../src/database/open.js";
import {
  commitStateChange,
  openStateDatabase,
  runMigrations,
  type StateDatabase,
} from "../src/index.js";
import { MIGRATIONS } from "../src/migrations/list.js";
import { currentSchemaVersion, runMigrationList } from "../src/migrations/migrate.js";
import type { Migration } from "../src/migrations/migration.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const HASH = "d".repeat(64);
const NOW = "2026-08-08T12:00:00.000Z";
const LATER = "2026-08-08T12:01:30.000Z";

const NATIVE_TABLES = [
  "parent_session",
  "native_stage",
  "native_stage_attempt",
  "native_dispatch",
  "native_stage_question",
  "native_question_projection",
] as const;

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
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function tableNames(): readonly string[] {
  return internalHandle(db)
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

function countOf(table: string): number {
  return Number(
    internalHandle(db).prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? -1,
  );
}

/** Registers the identity a native stage needs before it can reference one. */
function seedIdentity(): void {
  commitStateChange(db, {
    type: "codebase.registration_committed",
    payload: {
      registration: {
        codebaseId: "codebase-m11",
        configurationSha256: HASH,
        instructionSnapshot: {},
        name: "migration-11",
        repositories: [
          {
            defaultBranch: "main",
            defaultRemote: "origin",
            gitCommonDirectory: "/managed/m11/.git",
            name: "migration-11",
            path: "/managed/m11",
            remotes: [],
            repositoryId: "repository-m11",
          },
        ],
        rootPath: "/managed/m11",
        topologySha256: HASH,
      },
    },
  });
  commitStateChange(db, {
    runId: "run-m11",
    type: "run.created",
    payload: { runId: "run-m11", codebaseId: "codebase-m11" },
  });
}

function insertStage(): void {
  internalHandle(db)
    .prepare(
      `INSERT INTO native_stage
        (run_id, stage_id, codebase_id, repository_id, profile_id, profile_json,
         permissions_json, limits_json, prompt, artifact_path, instructions_path,
         artifact_contract, model, effort, focus, questions, base_sha, hard_deadline_at,
         state, current_attempt_id, attempt_count, revision, waiting_since, created_at, updated_at)
       VALUES ('run-m11', 'stage-m11', 'codebase-m11', 'repository-m11', 'opus-native', '{}',
         '{}', '{}', 'Do the thing.', 'out/result.json', 'docs/instructions.md',
         'heniek://contract/ExternalStageResult/v1', 'opus', 'high', NULL, 'parent-mediated',
         ?, NULL, 'dispatched', 'attempt-1', 1, 1, NULL, ?, ?)`,
    )
    .run("0".repeat(40), NOW, NOW);
}

function insertSession(sessionId = "session-1"): void {
  internalHandle(db)
    .prepare(
      `INSERT INTO parent_session
        (session_id, codebase_id, state, revision, boot_witness, process_witness_json,
         attached_at, renewed_at, expires_at, released_at, superseded_by, updated_at)
       VALUES (?, 'codebase-m11', 'attached', 1, NULL, NULL, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(sessionId, NOW, NOW, LATER, NOW);
}

function insertAttempt(attemptId: string, ordinal: number): void {
  internalHandle(db)
    .prepare(
      `INSERT INTO native_stage_attempt
        (attempt_id, run_id, stage_id, attempt_ordinal, workspace_id, readonly_baseline_json,
         status, result_json, failure_json, started_at, finished_at, created_at, updated_at)
       VALUES (?, 'run-m11', 'stage-m11', ?, NULL, NULL, 'running', NULL, NULL, ?, NULL, ?, ?)`,
    )
    .run(attemptId, ordinal, NOW, NOW, NOW);
}

function insertDispatch(dispatchId: string, attemptId: string, sessionId = "session-1"): void {
  internalHandle(db)
    .prepare(
      `INSERT INTO native_dispatch
        (dispatch_id, run_id, stage_id, attempt_id, session_id, state, revision,
         terminal_reason, outcome, submission_id, submission_digest, result_json,
         issued_at, expires_at, settled_at, updated_at)
       VALUES (?, 'run-m11', 'stage-m11', ?, ?, 'dispatched', 1,
         NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?)`,
    )
    .run(dispatchId, attemptId, sessionId, NOW, LATER, NOW);
}

describe("Q023 migration 11 — fresh and upgraded witnesses", () => {
  it("creates every native bridge table on a fresh database", () => {
    runMigrations(db);

    expect(db.schemaVersion).toBe(currentSchemaVersion());
    const names = new Set(tableNames());
    for (const table of NATIVE_TABLES) {
      expect(names.has(table), `expected table ${table}`).toBe(true);
    }
  });

  /**
   * Migration 11 is pure `CREATE` — no `ALTER`, no backfill, no rewrite of an
   * existing table. Upgrading therefore has to leave every migration-10 row
   * exactly as it was and leave the new tables empty, which is what makes
   * this the cheapest possible migration to reason about after a failure.
   */
  it("upgrades a populated v10 database without backfilling or touching existing rows", () => {
    runMigrationList(db, MIGRATIONS, 10);
    seedIdentity();
    const before = internalHandle(db)
      .prepare("SELECT run_id, status, revision FROM run_projection ORDER BY run_id")
      .all();
    const journalBefore = countOf("state_event");

    expect(runMigrations(db)).toMatchObject({
      fromVersion: 10,
      toVersion: currentSchemaVersion(),
    });

    expect(
      internalHandle(db)
        .prepare("SELECT run_id, status, revision FROM run_projection ORDER BY run_id")
        .all(),
    ).toEqual(before);
    expect(countOf("state_event")).toBe(journalBefore);
    for (const table of NATIVE_TABLES) {
      expect(countOf(table), `expected ${table} to start empty`).toBe(0);
    }
  });

  it("rolls an interrupted v11 step back completely and retries cleanly", () => {
    runMigrationList(db, MIGRATIONS, 10);
    const migration11 = MIGRATIONS.find((migration) => migration.version === 11);
    if (migration11 === undefined) throw new Error("migration 11 is missing");
    const interrupted: Migration = {
      ...migration11,
      statements: [
        ...migration11.statements.slice(0, 3),
        "INSERT INTO table_that_does_not_exist VALUES (1)",
        ...migration11.statements.slice(3),
      ],
    };

    expect(() => runMigrationList(db, [...MIGRATIONS.slice(0, 10), interrupted])).toThrow(
      'migration "native-bridge" failed',
    );
    expect(db.schemaVersion).toBe(10);
    expect(new Set(tableNames()).has("parent_session")).toBe(false);

    runMigrations(db);
    expect(db.schemaVersion).toBe(currentSchemaVersion());
    expect(new Set(tableNames()).has("parent_session")).toBe(true);
  });
});

describe("Q023 migration 11 — the fencing invariants live in the schema", () => {
  beforeEach(() => {
    runMigrations(db);
    seedIdentity();
    insertSession();
    insertStage();
    insertAttempt("attempt-1", 1);
  });

  /**
   * At most one open dispatch per attempt. Without this, a second poll could
   * hand the same attempt to a second session and both could submit.
   */
  it("permits only one open dispatch per attempt", () => {
    insertDispatch("dispatch-1", "attempt-1");
    expect(() => insertDispatch("dispatch-2", "attempt-1")).toThrow(
      /UNIQUE constraint failed: native_dispatch\.attempt_id/,
    );

    internalHandle(db)
      .prepare(
        `UPDATE native_dispatch
            SET state = 'abandoned', terminal_reason = 'lease_expired',
                settled_at = ?, revision = revision + 1, updated_at = ?
          WHERE dispatch_id = 'dispatch-1'`,
      )
      .run(LATER, LATER);

    // Only once the first is settled does the attempt become dispatchable
    // again — which is what makes a redispatch after expiry legal.
    expect(() => insertDispatch("dispatch-2", "attempt-1")).not.toThrow();
  });

  /**
   * The acceptance criterion is "rebinding cannot submit a result to the
   * wrong run/stage/attempt". If the binding columns were mutable, a rebind
   * could quietly retarget an existing dispatch at a different attempt and
   * every subsequent check would faithfully validate the wrong thing.
   */
  it("refuses to retarget a dispatch at a different run, stage or attempt", () => {
    insertDispatch("dispatch-1", "attempt-1");
    insertAttempt("attempt-2", 2);

    for (const [column, value] of [
      ["attempt_id", "attempt-2"],
      ["run_id", "run-other"],
      ["stage_id", "stage-other"],
    ] as const) {
      expect(
        () =>
          internalHandle(db)
            .prepare(`UPDATE native_dispatch SET ${column} = ? WHERE dispatch_id = 'dispatch-1'`)
            .run(value),
        `expected ${column} to be immutable`,
      ).toThrow(/immutable/);
    }
  });

  it("refuses to move a settled dispatch back out of its terminal state", () => {
    insertDispatch("dispatch-1", "attempt-1");
    internalHandle(db)
      .prepare(
        `UPDATE native_dispatch
            SET state = 'revoked', terminal_reason = 'run_cancelled',
                settled_at = ?, revision = revision + 1, updated_at = ?
          WHERE dispatch_id = 'dispatch-1'`,
      )
      .run(LATER, LATER);

    expect(() =>
      internalHandle(db)
        .prepare(
          `UPDATE native_dispatch SET state = 'dispatched', terminal_reason = NULL,
              settled_at = NULL, revision = revision + 1 WHERE dispatch_id = 'dispatch-1'`,
        )
        .run(),
    ).toThrow(/terminal/);
  });

  /**
   * Expiry bumps the revision precisely so a woken parent's in-flight submit
   * cannot match. A revision that could move backwards would hand that
   * capability straight back.
   */
  it("refuses to move a dispatch revision backwards", () => {
    insertDispatch("dispatch-1", "attempt-1");
    internalHandle(db)
      .prepare("UPDATE native_dispatch SET revision = 5 WHERE dispatch_id = 'dispatch-1'")
      .run();

    expect(() =>
      internalHandle(db)
        .prepare("UPDATE native_dispatch SET revision = 4 WHERE dispatch_id = 'dispatch-1'")
        .run(),
    ).toThrow(/backwards/);
  });

  it("requires a submitted dispatch to carry its outcome, submission id and digest", () => {
    insertDispatch("dispatch-1", "attempt-1");
    expect(() =>
      internalHandle(db)
        .prepare(
          `UPDATE native_dispatch SET state = 'submitted', settled_at = ?, revision = revision + 1
            WHERE dispatch_id = 'dispatch-1'`,
        )
        .run(LATER),
    ).toThrow(/CHECK constraint failed: \(state = 'submitted'\) = \(outcome IS NOT NULL\)/);
  });

  it("keeps one attempt ordinal per run and rejects a zeroth attempt", () => {
    expect(() => insertAttempt("attempt-duplicate", 1)).toThrow(
      /UNIQUE constraint failed: .*attempt_ordinal/,
    );
    expect(() => insertAttempt("attempt-zero", 0)).toThrow(
      /CHECK constraint failed: attempt_ordinal >= 1/,
    );
    expect(() => insertAttempt("attempt-2", 2)).not.toThrow();
  });

  it("requires waiting_since exactly when the stage is waiting for a parent", () => {
    expect(() =>
      internalHandle(db)
        .prepare(
          `UPDATE native_stage SET state = 'waiting_for_parent', revision = revision + 1
            WHERE run_id = 'run-m11'`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed: \(state = 'waiting_for_parent'\)/);

    expect(() =>
      internalHandle(db)
        .prepare(
          `UPDATE native_stage SET state = 'waiting_for_parent', waiting_since = ?,
              revision = revision + 1 WHERE run_id = 'run-m11'`,
        )
        .run(LATER),
    ).not.toThrow();
  });

  it("refuses a native stage identity change", () => {
    expect(() =>
      internalHandle(db)
        .prepare(
          `UPDATE native_stage SET artifact_path = 'elsewhere.json', revision = revision + 1
            WHERE run_id = 'run-m11'`,
        )
        .run(),
    ).toThrow(/immutable/);
  });

  it("refuses a parent session that supersedes itself", () => {
    expect(() =>
      internalHandle(db)
        .prepare(
          "UPDATE parent_session SET superseded_by = session_id WHERE session_id = 'session-1'",
        )
        .run(),
    ).toThrow(/CHECK constraint failed: superseded_by IS NULL/);
  });
});
