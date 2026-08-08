/**
 * The defect register (T3; plan Task 6.2).
 *
 * Seeded with the two defects the design stage found before any code existed,
 * so neither can be reintroduced silently. Each case names the finding and
 * says *why* the naive alternative is wrong — a regression pin without that
 * reasoning is just another assertion someone will "simplify" away.
 *
 * Any further defect discovered while implementing belongs here too: T3 says
 * "every defect", and this file is the register.
 */

import { chmodSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitStateChange,
  commitStateChangeInternal,
  type StageArtifactAssertion,
} from "../src/command/commit.js";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { StageAssertionFailedError } from "../src/errors.js";
import { createStageExecution, markExecutionFinalized } from "../src/execution/store.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

function sqliteErrorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "errcode" in error) {
    const errcode = (error as { errcode?: unknown }).errcode;
    return typeof errcode === "number" ? errcode : undefined;
  }
  return undefined;
}

const SQLITE_CONSTRAINT_TRIGGER = 1811;

let directory: string;
let path: string;
let db: StateDatabase;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  path = temp.path;
  db = openStateDatabase({ path, clock: createFakeClock(), ids: createDeterministicIds(1) });
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function seedRun(): number {
  const handle = internalHandle(db);
  const event = handle
    .prepare(
      "INSERT INTO state_event" +
        " (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)" +
        " VALUES ('evt-1', 'run-1', 'cor-1', NULL, 'run.created', '2026-01-01T00:00:00.000Z', '{}')",
    )
    .run();
  const sequence = Number(event.lastInsertRowid);
  handle
    .prepare(
      "INSERT INTO run_projection" +
        " (run_id, status, revision, last_event_sequence, codebase_id, updated_at)" +
        " VALUES ('run-1', 'queued', 1, ?, 'cb-1', '2026-01-01T00:00:00.000Z')",
    )
    .run(sequence);
  const second = handle
    .prepare(
      "INSERT INTO state_event" +
        " (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)" +
        " VALUES ('evt-2', 'run-1', 'cor-1', NULL, 'run.status_changed', '2026-01-01T00:00:00.000Z', '{}')",
    )
    .run();
  return Number(second.lastInsertRowid);
}

describe("R-V9 — an upsert fires BEFORE INSERT even on the UPDATE branch (finding V9/C4)", () => {
  /*
   * Both variants are pinned together, and that pairing is the point.
   *
   * A builder who reaches for the idiomatic upsert — carrying the intended
   * next revision in the VALUES row, variant A — produces a package that
   * cannot advance ANY projection past its first event, and the error it
   * reports points at the wrong thing entirely ("first projection revision
   * must be 1" on what is logically an update). SQLite evaluates BEFORE
   * INSERT triggers *before* conflict resolution, so the guard never sees the
   * DO UPDATE clause at all.
   *
   * A builder who instead writes variant B — revision 1 in VALUES, the real
   * next revision computed in DO UPDATE SET — is not caught by that trap.
   * Pinning only variant A would therefore leave "the upsert is banned"
   * reading as a schema-enforced property, which it is not: it is a rule
   * about which SQL `commitStateChange` may emit. Both facts have to stay
   * true simultaneously, so both are pinned.
   */

  it("variant A is rejected by the first-revision guard, verbatim message and errcode", () => {
    const secondSequence = seedRun();
    let caught: unknown;
    try {
      internalHandle(db)
        .prepare(
          "INSERT INTO run_projection" +
            " (run_id, status, revision, last_event_sequence, codebase_id, updated_at)" +
            " VALUES ('run-1', 'running', 2, ?, 'cb-1', '2026-01-01T00:00:00.000Z')" +
            " ON CONFLICT(run_id) DO UPDATE SET revision = excluded.revision," +
            " status = excluded.status, last_event_sequence = excluded.last_event_sequence," +
            " updated_at = excluded.updated_at",
        )
        .run(secondSequence);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("first projection revision must be 1");
    expect(sqliteErrorCode(caught)).toBe(SQLITE_CONSTRAINT_TRIGGER);

    // Still frozen at its first revision — the visible symptom of the defect.
    const row = internalHandle(db)
      .prepare("SELECT revision FROM run_projection WHERE run_id = 'run-1'")
      .get();
    expect(row?.revision).toBe(1);
  });

  it("variant B succeeds and advances the row — pinned so nobody 'fixes' variant A into it by accident", () => {
    const secondSequence = seedRun();
    const result = internalHandle(db)
      .prepare(
        "INSERT INTO run_projection" +
          " (run_id, status, revision, last_event_sequence, codebase_id, updated_at)" +
          " VALUES ('run-1', 'running', 1, ?, 'cb-1', '2026-01-01T00:00:00.000Z')" +
          " ON CONFLICT(run_id) DO UPDATE SET revision = run_projection.revision + 1," +
          " status = excluded.status, last_event_sequence = excluded.last_event_sequence," +
          " updated_at = excluded.updated_at",
      )
      .run(secondSequence);
    expect(result.changes).toBe(1);

    const row = internalHandle(db)
      .prepare("SELECT revision FROM run_projection WHERE run_id = 'run-1'")
      .get();
    expect(row?.revision).toBe(2);
  });
});

describe("R-V6 — opening first and chmod-ing afterwards leaves the sidecars exposed (finding V6/D13)", () => {
  /*
   * The `-wal` sidecar can hold committed rows that have not been
   * checkpointed into the main file yet, so a world-readable `-wal` is a real
   * exposure of real state, not a cosmetic permissions nit. That is why
   * `openStateDatabase` pre-creates the main file at 0o600 *before* handing
   * the path to `DatabaseSync` — the ordering cannot be refactored into a
   * tidier "open, then fix up the modes" shape.
   */

  it("the defective ordering: SQLite creates the files, and a later chmod does not reach the sidecars", () => {
    const defectivePath = join(directory, "defective.sqlite");
    const raw = new DatabaseSync(defectivePath);
    try {
      raw.exec("PRAGMA journal_mode = WAL");
      raw.exec("CREATE TABLE probe (a INTEGER) STRICT");
      raw.exec("INSERT INTO probe (a) VALUES (1)");

      // The mode SQLite itself gave these files, captured BEFORE the repair.
      // Anchoring on this rather than on a hand-computed `0o666 & ~umask`
      // avoids encoding SQLite's own base mode (it creates database files
      // from 0o644, not 0o666) and keeps the case correct under any umask.
      const createdMode = statSync(defectivePath).mode & 0o777;

      // The naive repair: fix up the main file after the fact.
      chmodSync(defectivePath, 0o600);
      expect(statSync(defectivePath).mode & 0o777).toBe(0o600);

      // ...which provably does not reach the sidecars. They still carry the
      // exact mode SQLite created them with.
      const walMode = statSync(`${defectivePath}-wal`).mode & 0o777;
      const shmMode = statSync(`${defectivePath}-shm`).mode & 0o777;
      expect(walMode).toBe(createdMode);
      expect(shmMode).toBe(createdMode);
      if (createdMode !== 0o600) {
        // The exposure is only observable when the ambient umask does not
        // already produce private files. Under a umask strict enough to yield
        // 0o600 the defective ordering coincidentally looks fine — the
        // ordering is still wrong, it just cannot be caught by inspecting
        // modes, which is exactly why openStateDatabase does not rely on the
        // umask being helpful.
        expect(walMode).not.toBe(0o600);
        expect(shmMode).not.toBe(0o600);
      }
    } finally {
      raw.close();
    }
  });

  it("openStateDatabase's pre-creation ordering yields 0o600 on the main file and both sidecars", () => {
    // `db` is already open and migrated from the shared beforeEach, so the
    // WAL sidecars exist.
    internalHandle(db).exec("PRAGMA wal_checkpoint(PASSIVE)");
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      expect(statSync(candidate).mode & 0o777).toBe(0o600);
    }
  });
});

function registerCodebaseAndRun(): void {
  commitStateChange(db, { type: "codebase.registered", payload: { codebaseId: "cb-1" } });
  commitStateChange(db, {
    runId: "run-1",
    type: "run.created",
    payload: { runId: "run-1", codebaseId: "cb-1" },
  });
}

function stageArtifactRef(artifactId: string, name: string, hashByte: string) {
  return {
    artifactId,
    name,
    contentHash: hashByte.repeat(64),
    byteLength: 1,
    mediaType: "text/markdown",
    contentSchemaId: "heniek://contract/Report/v1",
    producer: "reviewer",
    sourceLineage: [] as readonly string[],
    path: `blobs/sha256/${hashByte.repeat(64)}`,
  };
}

function noop(relativePath: string): StageArtifactAssertion {
  return { relativePath, assert: () => {} };
}

describe("R-Q007-P4a — reported[0] reports whichever table TABLE_ORDER sorts first, not the row the command advanced (design open item, plan Task 4.1)", () => {
  /*
   * `stage.completed` is the first (and, in this vocabulary, only) command
   * that writes two tables in one transaction — a new `artifact` row plus
   * the `stage_artifact_alias` row that re-points a name at it.
   * `TABLE_ORDER` (`projection/state.ts`) is alphabetical, so `artifact`
   * always sorts before `stage_artifact_alias`. A naive `CommitReport.revision
   * = reported[0]?.revision` therefore reports the *new artifact row's*
   * revision — always `1` — even when the caller actually wants to know how
   * far the *alias* has advanced. Both facts are pinned together, exactly as
   * R-V9 above pins both the defective and the corrected SQL: the
   * `primaryTable`-omitted call is not itself wrong (it is documented,
   * unchanged pre-Q007 behaviour), but a caller who mistakes it for "the
   * alias's revision" would be silently misled.
   */
  it("primaryTable omitted: revision is the artifact row's (1), not the alias's (which has since advanced to 2)", () => {
    registerCodebaseAndRun();
    const first = stageArtifactRef("art-1", "report.md", "a");
    commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "stage.completed",
        payload: { runId: "run-1", stageId: "stage-1", artifacts: [first] },
      },
      { artifactRelativePaths: [first.path], assertions: [noop(first.path)] },
    );
    const second = stageArtifactRef("art-2", "report.md", "b");
    const report = commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "stage.completed",
        payload: { runId: "run-1", stageId: "stage-1", artifacts: [second] },
      },
      { artifactRelativePaths: [second.path], assertions: [noop(second.path)] },
    );
    expect(report.writes.find((write) => write.table === "stage_artifact_alias")?.revision).toBe(2);
    expect(report.revision).toBe(1); // the (documented) pre-Q007 default, not the alias's real revision
  });

  it("primaryTable: 'stage_artifact_alias' reports the alias's real revision (2) — this is what completeStage always passes", () => {
    registerCodebaseAndRun();
    const first = stageArtifactRef("art-1", "report.md", "a");
    commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "stage.completed",
        payload: { runId: "run-1", stageId: "stage-1", artifacts: [first] },
      },
      {
        primaryTable: "stage_artifact_alias",
        artifactRelativePaths: [first.path],
        assertions: [noop(first.path)],
      },
    );
    const second = stageArtifactRef("art-2", "report.md", "b");
    const report = commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "stage.completed",
        payload: { runId: "run-1", stageId: "stage-1", artifacts: [second] },
      },
      {
        primaryTable: "stage_artifact_alias",
        artifactRelativePaths: [second.path],
        assertions: [noop(second.path)],
      },
    );
    expect(report.revision).toBe(2);
  });
});

describe("R-Q007-P4b — a plain commitStateChange call can mint an artifact row for a blob never written to disk (AC-1)", () => {
  /*
   * Before this phase, `StateCommand.type` is an unconstrained `string` and
   * `artifact`/`stage_artifact_alias` are ordinary projection tables like
   * any other — nothing stopped a caller from committing an `artifact.
   * published` or `stage.completed` event whose `relativePath` passes the
   * migration-4 `CHECK` (`'blobs/sha256/' || content_hash`) while naming a
   * blob address `publishArtifact` never wrote. The fix
   * (`assertGuardedWritesAreVerified`, `command/commit.ts`) refuses any
   * write into either table unless the caller supplies a verified
   * assertion for its relativePath — keyed on the TABLE a write touches,
   * never on `event.type`, so the refusal is structural rather than a
   * blacklist a future seventh event type could reopen. See
   * `command.test.ts`'s "AC-1" describe block for the full 8-event-type
   * enumeration; this entry pins the specific minimal repro.
   */
  it("commitStateChange refuses to mint an artifact row for a relativePath nothing ever published", () => {
    registerCodebaseAndRun();
    const forged = stageArtifactRef("art-forged", "forged.md", "f");
    let caught: unknown;
    try {
      commitStateChange(db, {
        runId: "run-1",
        type: "artifact.published",
        payload: { runId: "run-1", stageId: "stage-1", ...forged },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StageAssertionFailedError);
    expect(internalHandle(db).prepare("SELECT COUNT(*) AS n FROM artifact").get()?.n).toBe(0);
  });
});

describe("R-Q023-F1 — markExecutionFinalized let two completions overwrite each other", () => {
  /*
   * Found while implementing Q023. The `UPDATE stage_execution … WHERE
   * run_id = ?` carried no `finalized` guard and asserted nothing about
   * `changes`, so finalization was last-writer-wins: a run already reported
   * `succeeded` could be silently rewritten to `failed`, or the reverse,
   * with no trace that it had ever held the other value.
   *
   * The ordering is reachable, not theoretical — `ExecutionService.observe`
   * finalizes as `failed` in the catch block around `finalizeSuccess`, and
   * `finalizeSuccess` finalizes as `succeeded` before its own last
   * statements run. Nothing in between guaranteed the first write had not
   * already landed.
   *
   * The guard belongs in the `WHERE` rather than in a read-then-write in
   * JavaScript: a JS-side `if (row.finalized) return` is correct only
   * because this process happens to be single-threaded today, and it would
   * be silently wrong the moment anything else holds the handle. `finalized
   * = 0` in the predicate plus a `changes` assertion makes it atomic in
   * SQLite and loud at the call site that got it wrong.
   */
  it("refuses a second finalization instead of overwriting the first", () => {
    registerCodebaseAndRun();
    commitStateChange(db, {
      type: "repository.registered",
      payload: { repositoryId: "repository-1", codebaseId: "cb-1" },
    });
    commitStateChange(db, {
      type: "workspace.registered",
      payload: { workspaceId: "workspace-1", codebaseId: "cb-1" },
    });
    createStageExecution(db, {
      runId: "run-1",
      stageId: "stage-1",
      codebaseId: "cb-1",
      repositoryId: "repository-1",
      workspaceId: "workspace-1",
      backendKind: "claudexor-v2",
      prompt: "Finalize once.",
      artifactPath: "artifacts/result.md",
      limits: {},
    });

    markExecutionFinalized(db, "run-1", { status: "succeeded", summary: "First and only." });

    expect(() =>
      markExecutionFinalized(db, "run-1", { status: "failed", summary: "Second." }),
    ).toThrow(/already finalized/);

    expect(
      internalHandle(db)
        .prepare("SELECT status, summary FROM stage_execution WHERE run_id = 'run-1'")
        .get(),
    ).toMatchObject({ status: "succeeded", summary: "First and only." });
  });

  it("reports a missing run through the same guard rather than succeeding silently", () => {
    registerCodebaseAndRun();
    expect(() =>
      markExecutionFinalized(db, "run-absent", { status: "succeeded", summary: "Nothing here." }),
    ).toThrow(/already finalized or missing/);
  });
});
