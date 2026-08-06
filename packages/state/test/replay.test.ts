/**
 * Replay and divergence (design §8 suite 6; plan Task 5.3) — AC3, including
 * its *detects* half.
 *
 * A suite that only ever asserts `converged` proves the comparison runs, not
 * that it discriminates. **The two injection cases below are not optional**:
 * one models a reducer bug shipped in a later version, the other models
 * operator surgery or a bad restore.
 */

import { copyFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactId, ArtifactRefV1 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitStateChange,
  commitStateChangeInternal,
  type StageArtifactAssertion,
} from "../src/command/commit.js";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { latestSequence } from "../src/journal/read.js";
import { currentSchemaVersion, runMigrations } from "../src/migrations/migrate.js";
import { applyEvent } from "../src/projection/reducer.js";
import type { ProjectionState } from "../src/projection/state.js";
import { compareProjectionToReplay } from "../src/replay/compare.js";
import { replayJournal } from "../src/replay/replay.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

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

/** Six commands touching all four tables — the shared fixture for the cases below. */
function seedAllFourTables(): void {
  commitStateChange(db, { type: "codebase.registered", payload: { codebaseId: "cb-1" } });
  commitStateChange(db, {
    type: "repository.registered",
    payload: { repositoryId: "repo-1", codebaseId: "cb-1" },
  });
  commitStateChange(db, {
    type: "workspace.registered",
    payload: { workspaceId: "ws-1", codebaseId: "cb-1" },
  });
  commitStateChange(db, {
    runId: "run-1",
    type: "run.created",
    payload: { runId: "run-1", codebaseId: "cb-1" },
  });
  commitStateChange(db, {
    runId: "run-1",
    type: "run.workspace_assigned",
    payload: { runId: "run-1", workspaceId: "ws-1" },
  });
  commitStateChange(db, {
    runId: "run-1",
    type: "run.status_changed",
    payload: { runId: "run-1", status: "succeeded" },
  });
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/**
 * `artifact.published` and `stage.completed` now reach `artifact`/
 * `stage_artifact_alias` only through `commitStateChangeInternal`'s verified
 * assertion machinery (AC-1, `command/commit.ts`'s
 * `assertGuardedWritesAreVerified`) — the public `commitStateChange` refuses
 * both unconditionally. This file exercises the **reducer's** and
 * **replay's** behaviour, not filesystem publication (that is Phase 3/4's
 * own `artifact-publish.test.ts`/`complete-stage` suites), so — mirroring
 * `command.test.ts`'s identical `noopAssertion` — every case below drives
 * the same internal entry point `completeStage` (the production wrapper)
 * uses, with an always-succeeding assertion standing in for a real
 * filesystem receipt.
 */
function noopAssertion(relativePath: string): StageArtifactAssertion {
  return { relativePath, assert: () => {} };
}

/**
 * `artifact.run_id REFERENCES run_projection(run_id)` (issue #8, Phase 2 fix
 * cycle G1, finding F4): every case below that publishes or completes an
 * artifact without going through the full `seedAllFourTables` fixture still
 * needs a real `run_projection` row to reference. This is the minimal path
 * to one — `codebase.registered` then `run.created`, the same two commands
 * `seedAllFourTables` opens with — for tests that only care about the
 * artifact/stage-completion behaviour under test, not the full four-table
 * fixture.
 */
function seedMinimalRun(): void {
  commitStateChange(db, { type: "codebase.registered", payload: { codebaseId: "cb-1" } });
  commitStateChange(db, {
    runId: "run-1",
    type: "run.created",
    payload: { runId: "run-1", codebaseId: "cb-1" },
  });
}

/**
 * One `artifact.published` event, publishing `artifact-1` under
 * `run-1`/`stage-1`/`plan.md` — the standalone-publish half of Q007's two new
 * event types (plan Task 2.2).
 */
function publishArtifact(): void {
  const path = `blobs/sha256/${HASH_A}`;
  commitStateChangeInternal(
    db,
    {
      runId: "run-1",
      type: "artifact.published",
      payload: {
        runId: "run-1",
        stageId: "stage-1",
        artifactId: "artifact-1",
        name: "plan.md",
        contentHash: HASH_A,
        byteLength: 42,
        mediaType: "text/markdown",
        contentSchemaId: "heniek://contract/Plan/v1",
        producer: "planner",
        sourceLineage: [],
        path,
      },
    },
    { artifactRelativePaths: [path], assertions: [noopAssertion(path)] },
  );
}

/**
 * One `stage.completed` event, publishing `artifact-2` under
 * `run-1`/`stage-1`/`report.md` and pointing that name's active alias at it —
 * the transactional-completion half of Q007's two new event types (design
 * §16.6, plan Task 2.2).
 */
function completeStage(): void {
  const path = `blobs/sha256/${HASH_B}`;
  commitStateChangeInternal(
    db,
    {
      runId: "run-1",
      type: "stage.completed",
      payload: {
        runId: "run-1",
        stageId: "stage-1",
        artifacts: [
          {
            artifactId: "artifact-2",
            name: "report.md",
            contentHash: HASH_B,
            byteLength: 7,
            mediaType: "text/markdown",
            contentSchemaId: "heniek://contract/Report/v1",
            producer: "reviewer",
            sourceLineage: ["artifact-1"],
            path,
          },
        ],
      },
    },
    { artifactRelativePaths: [path], assertions: [noopAssertion(path)] },
  );
}

describe("converged", () => {
  it("a journal touching all four tables replays to exactly the stored projection", () => {
    seedAllFourTables();
    const report = compareProjectionToReplay(db);

    expect(report.status).toBe("converged");
    expect(report.divergences).toEqual([]);
    expect(report.projectionDigest.stored).toBe(report.projectionDigest.replayed);
    expect(report.eventsReplayed).toBe(6);
    expect(report.throughSequence).toBe(latestSequence(db));
    // Derived, not a literal (plan Task 2.4/B8a): `schemaFingerprint()` reads
    // `PRAGMA user_version` live, so a future migration would otherwise make
    // this assertion silently stale rather than force an edit here.
    expect(report.schemaFingerprint.userVersion).toBe(currentSchemaVersion());
  });

  it("an empty journal converges on empty state", () => {
    const report = compareProjectionToReplay(db);
    expect(report.status).toBe("converged");
    expect(report.eventsReplayed).toBe(0);
    expect(report.throughSequence).toBe(0);
  });

  it("a journal touching all six tables (Q007's artifact and stage_artifact_alias) replays to exactly the stored projection", () => {
    seedAllFourTables();
    publishArtifact();
    completeStage();

    const handle = internalHandle(db);
    expect(handle.prepare("SELECT COUNT(*) AS c FROM artifact").get()?.c).toBe(2);
    expect(handle.prepare("SELECT COUNT(*) AS c FROM stage_artifact_alias").get()?.c).toBe(1);

    const report = compareProjectionToReplay(db);
    expect(report.status).toBe("converged");
    expect(report.divergences).toEqual([]);
    expect(report.projectionDigest.stored).toBe(report.projectionDigest.replayed);
    expect(report.eventsReplayed).toBe(8);
  });
});

describe("reducer — artifact.published and stage.completed (design D11a, §16.2, §16.6)", () => {
  /**
   * Issue #8, Phase 2 fix cycle G1, finding F8: the shipped validation
   * rejected a zero-length `artifacts` array, which made "this stage
   * legitimately produced no outputs" unrepresentable. `stage.completed`
   * must still be a valid, committable event with an empty `artifacts` list
   * — it writes no `artifact` or `stage_artifact_alias` row, but the
   * `run_id`/`stage_id` existence check still runs.
   */
  it("stage.completed with an empty artifacts array is accepted and writes no artifact or alias row", () => {
    seedMinimalRun();
    const report = commitStateChange(db, {
      runId: "run-1",
      type: "stage.completed",
      payload: {
        runId: "run-1",
        stageId: "stage-1",
        artifacts: [],
      },
    });
    expect(report.writes).toEqual([]);
    const handle = internalHandle(db);
    expect(handle.prepare("SELECT COUNT(*) AS c FROM artifact").get()?.c).toBe(0);
    expect(handle.prepare("SELECT COUNT(*) AS c FROM stage_artifact_alias").get()?.c).toBe(0);

    const replayed = compareProjectionToReplay(db);
    expect(replayed.status).toBe("converged");
  });

  it("artifact.published then a second publish under the same artifactId is rejected as a duplicate — artifact rows are append-only", () => {
    seedMinimalRun();
    publishArtifact();
    expect(() => publishArtifact()).toThrow(/artifact already exists: artifact-1/);
  });

  it("stage.completed with two artifacts sharing a name in one payload is rejected", () => {
    seedMinimalRun();
    expect(() =>
      commitStateChange(db, {
        runId: "run-1",
        type: "stage.completed",
        payload: {
          runId: "run-1",
          stageId: "stage-1",
          artifacts: [
            {
              artifactId: "artifact-a",
              name: "dup.md",
              contentHash: HASH_A,
              byteLength: 1,
              mediaType: "text/markdown",
              contentSchemaId: "heniek://contract/Report/v1",
              producer: "reviewer",
              sourceLineage: [],
              path: `blobs/sha256/${HASH_A}`,
            },
            {
              artifactId: "artifact-b",
              name: "dup.md",
              contentHash: HASH_B,
              byteLength: 1,
              mediaType: "text/markdown",
              contentSchemaId: "heniek://contract/Report/v1",
              producer: "reviewer",
              sourceLineage: [],
              path: `blobs/sha256/${HASH_B}`,
            },
          ],
        },
      }),
    ).toThrow(/more than one entry named "dup\.md"/);
  });

  it("a second stage.completed for the same run/stage/name re-points the alias and advances its revision — the mutable half of §16.2", () => {
    seedMinimalRun();
    completeStage();
    const handle = internalHandle(db);
    const first = handle
      .prepare(
        "SELECT artifact_id, revision FROM stage_artifact_alias" +
          " WHERE run_id = 'run-1' AND stage_id = 'stage-1' AND name = 'report.md'",
      )
      .get();
    expect(first?.artifact_id).toBe("artifact-2");
    expect(first?.revision).toBe(1);

    const secondPath = `blobs/sha256/${HASH_A}`;
    commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "stage.completed",
        payload: {
          runId: "run-1",
          stageId: "stage-1",
          artifacts: [
            {
              artifactId: "artifact-3",
              name: "report.md",
              contentHash: HASH_A,
              byteLength: 9,
              mediaType: "text/markdown",
              contentSchemaId: "heniek://contract/Report/v1",
              producer: "reviewer",
              sourceLineage: [],
              path: secondPath,
            },
          ],
        },
      },
      { artifactRelativePaths: [secondPath], assertions: [noopAssertion(secondPath)] },
    );

    const second = handle
      .prepare(
        "SELECT artifact_id, revision FROM stage_artifact_alias" +
          " WHERE run_id = 'run-1' AND stage_id = 'stage-1' AND name = 'report.md'",
      )
      .get();
    expect(second?.artifact_id).toBe("artifact-3");
    expect(second?.revision).toBe(2);
    // The superseded alias target is still a durable, immutable artifact row
    // — re-pointing the alias never touches the artifact it used to name.
    expect(handle.prepare("SELECT COUNT(*) AS c FROM artifact").get()?.c).toBe(2);

    const report = compareProjectionToReplay(db);
    expect(report.status).toBe("converged");
  });
});

/**
 * Phase 2 fix cycle G2/G4 (issue #8): the reducer must bind to
 * `ArtifactRefV1`'s own field names, proven here by constructing the
 * `stage.completed` payload FROM a real, type-checked `ArtifactRefV1`
 * value — not a hand-written literal that could silently drift from the
 * contract the way the pre-fix `relativePath`/`path` mismatch did.
 */
describe("reducer binds to ArtifactRefV1's field names (G2, G4)", () => {
  it("a payload built from a real ArtifactRefV1 (including its own createdAt) is accepted, and createdAt is overridden by event.recordedAt", () => {
    // Typed against `Static<typeof ArtifactRefV1>` (not re-derived field
    // names) — if the contract ever renames a field, this object literal
    // fails to compile instead of silently drifting from the reducer.
    seedMinimalRun();
    const ref: Static<typeof ArtifactRefV1> = {
      schemaVersion: 1,
      artifactId: "artifact-from-contract" as ArtifactId,
      path: `blobs/sha256/${HASH_A}`,
      contentHash: HASH_A,
      // Deliberately distant from the fake clock's epoch (G4) — proves the
      // reducer overrides it rather than merely never validating it.
      createdAt: "2020-01-01T00:00:00.000Z",
      name: "from-contract.md",
      byteLength: 4,
      mediaType: "text/markdown",
      contentSchemaId: "heniek://contract/Report/v1",
      producer: "reviewer",
      sourceLineage: [],
    };

    commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "stage.completed",
        payload: {
          runId: "run-1",
          stageId: "stage-1",
          artifacts: [ref],
        },
      },
      { artifactRelativePaths: [ref.path], assertions: [noopAssertion(ref.path)] },
    );

    const handle = internalHandle(db);
    const row = handle
      .prepare("SELECT relative_path, created_at FROM artifact WHERE artifact_id = ?")
      .get("artifact-from-contract");
    expect(row?.relative_path).toBe(ref.path);
    expect(row?.created_at).not.toBe(ref.createdAt);

    const report = compareProjectionToReplay(db);
    expect(report.status).toBe("converged");
  });
});

/**
 * Phase 2 fix cycle G3 (issue #8): `ArtifactRefV1.sourceLineage` bounds
 * `maxItems: 64`/`uniqueItems: true`, but the write path previously did not
 * enforce either bound.
 */
describe("sourceLineage bounds (G3)", () => {
  function publishWithLineage(sourceLineage: readonly string[]): void {
    const path = `blobs/sha256/${HASH_A}`;
    commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "artifact.published",
        payload: {
          runId: "run-1",
          stageId: "stage-1",
          artifactId: "artifact-lineage",
          name: "lineage.md",
          contentHash: HASH_A,
          byteLength: 1,
          mediaType: "text/markdown",
          contentSchemaId: "heniek://contract/Plan/v1",
          producer: "planner",
          sourceLineage,
          path,
        },
      },
      { artifactRelativePaths: [path], assertions: [noopAssertion(path)] },
    );
  }

  it("accepts sourceLineage at the 64-entry boundary", () => {
    seedMinimalRun();
    const lineage = Array.from({ length: 64 }, (_, index) => `artifact-src-${index}`);
    expect(() => publishWithLineage(lineage)).not.toThrow();
  });

  it("rejects sourceLineage one entry past the 64-entry boundary", () => {
    seedMinimalRun();
    const lineage = Array.from({ length: 65 }, (_, index) => `artifact-src-${index}`);
    expect(() => publishWithLineage(lineage)).toThrow(
      /payload\.sourceLineage must not exceed 64 entries \(got 65\)/,
    );
  });

  it("rejects a sourceLineage containing a duplicate entry", () => {
    seedMinimalRun();
    expect(() => publishWithLineage(["artifact-src-0", "artifact-src-0"])).toThrow(
      /payload\.sourceLineage must not contain duplicate entries/,
    );
  });
});

/**
 * Phase 2 fix cycle G5 (issue #8): the `stage_artifact_alias -> artifact`
 * foreign key proves the referenced `artifact_id` exists, but nothing at
 * the schema level requires that row's `(run_id, stage_id, name)` to match
 * the alias's own. This pins the coupling the reducer maintains by
 * construction (`stage.completed` always writes an alias for the same
 * `(runId, stageId, ref.name)` triple it just wrote the artifact row
 * under) — a schema-level composite FK was considered and rejected as not
 * "cheap" for this table (see the fix commit body for why).
 */
describe("stage_artifact_alias/artifact (run_id, stage_id, name) coupling (G5)", () => {
  it("the alias's (run_id, stage_id, name) always matches its target artifact row's own", () => {
    seedMinimalRun();
    completeStage();
    const handle = internalHandle(db);
    const alias = handle
      .prepare(
        "SELECT run_id, stage_id, name, artifact_id FROM stage_artifact_alias" +
          " WHERE run_id = 'run-1' AND stage_id = 'stage-1' AND name = 'report.md'",
      )
      .get();
    expect(alias).toBeDefined();
    const aliasArtifactId = alias?.artifact_id;
    if (typeof aliasArtifactId !== "string") {
      throw new Error("expected alias.artifact_id to be a string");
    }
    const artifact = handle
      .prepare("SELECT run_id, stage_id, name FROM artifact WHERE artifact_id = ?")
      .get(aliasArtifactId);
    expect(artifact).toBeDefined();
    expect(artifact?.run_id).toBe(alias?.run_id);
    expect(artifact?.stage_id).toBe(alias?.stage_id);
    expect(artifact?.name).toBe(alias?.name);
  });
});

/**
 * `commit.ts`'s `stage_artifact_alias` UPDATE binds `run_id`/`stage_id`/
 * `name` as three separate parameters against three separate `WHERE`
 * clauses, rather than comparing a `run_id || char(0) || stage_id || char(0)
 * || name` expression against `write.key` (issue #8, Phase 2 fix cycle G1,
 * F5). Every other case in this file only ever has one alias row live at a
 * time, so a wrong-row match in the old join-based `WHERE` clause could not
 * have shown up — this seeds three, two sharing `stage_id` and differing
 * only by `name`, two sharing `name` and differing only by `stage_id`, then
 * re-points one and asserts the other two are untouched.
 */
describe("commit.ts binds stage_artifact_alias's composite key by column (F5)", () => {
  it("re-pointing one (run_id, stage_id, name) alias leaves rows differing only by name or only by stage_id byte-identical", () => {
    seedMinimalRun();

    function complete(
      stageId: string,
      name: string,
      artifactId: string,
      contentHash: string,
    ): void {
      const path = `blobs/sha256/${contentHash}`;
      commitStateChangeInternal(
        db,
        {
          runId: "run-1",
          type: "stage.completed",
          payload: {
            runId: "run-1",
            stageId,
            artifacts: [
              {
                artifactId,
                name,
                contentHash,
                byteLength: 1,
                mediaType: "text/markdown",
                contentSchemaId: "heniek://contract/Report/v1",
                producer: "reviewer",
                sourceLineage: [],
                path,
              },
            ],
          },
        },
        { artifactRelativePaths: [path], assertions: [noopAssertion(path)] },
      );
    }

    function readAlias(stageId: string, name: string): unknown {
      return internalHandle(db)
        .prepare(
          "SELECT artifact_id, revision, last_event_sequence, updated_at" +
            " FROM stage_artifact_alias WHERE run_id = 'run-1' AND stage_id = ? AND name = ?",
        )
        .get(stageId, name);
    }

    // Three alias rows under one run_id: the target, one differing only by
    // `name`, and one differing only by `stage_id`.
    complete("stage-1", "foo.md", "artifact-foo", HASH_A);
    complete("stage-1", "bar.md", "artifact-bar", HASH_B);
    complete("stage-2", "foo.md", "artifact-foo-2", HASH_A);

    const beforeBar = readAlias("stage-1", "bar.md");
    const beforeStage2 = readAlias("stage-2", "foo.md");

    // Re-point only the target alias.
    complete("stage-1", "foo.md", "artifact-foo-repointed", HASH_B);

    const target = readAlias("stage-1", "foo.md") as { artifact_id: string; revision: number };
    expect(target.artifact_id).toBe("artifact-foo-repointed");
    expect(target.revision).toBe(2);

    // The other two rows must be byte-identical to before the re-point — a
    // wrong-row UPDATE match would have advanced one of these instead of (or
    // as well as) the target.
    expect(readAlias("stage-1", "bar.md")).toEqual(beforeBar);
    expect(readAlias("stage-2", "foo.md")).toEqual(beforeStage2);

    const report = compareProjectionToReplay(db);
    expect(report.status).toBe("converged");
  });
});

describe("injected divergence — out-of-band surgery on the two new tables (Q007, design D11a)", () => {
  it("detects an artifact row edited behind the journal's back, after dropping its immutability trigger", () => {
    seedMinimalRun();
    publishArtifact();
    const handle = internalHandle(db);
    // D5's named, deliberate escape hatch, mirrored for `artifact`'s own
    // append-only trigger (migration 4) — the layered answer to tampering is
    // this divergence checker, not a trigger that cannot be dropped.
    handle.exec("DROP TRIGGER artifact_immutable_update");
    handle.exec(
      "UPDATE artifact SET media_type = 'application/octet-stream' WHERE artifact_id = 'artifact-1'",
    );

    const report = compareProjectionToReplay(db);
    expect(report.status).toBe("diverged");
    expect(report.divergences).toEqual([
      {
        table: "artifact",
        key: "artifact-1",
        field: "mediaType",
        stored: "application/octet-stream",
        replayed: "text/markdown",
      },
    ]);
  });

  it("detects a stage_artifact_alias row edited behind the journal's back, after dropping its causal-update trigger", () => {
    // `artifact-1` (published, not just completed-stage) is the tamper
    // target below — the alias's FK to `artifact` means the tampered value
    // must name a real, already-published row.
    seedMinimalRun();
    publishArtifact();
    completeStage();
    const handle = internalHandle(db);
    handle.exec("DROP TRIGGER stage_artifact_alias_causal_update");
    handle.exec(
      "UPDATE stage_artifact_alias SET artifact_id = 'artifact-1'" +
        " WHERE run_id = 'run-1' AND stage_id = 'stage-1' AND name = 'report.md'",
    );

    const report = compareProjectionToReplay(db);
    expect(report.status).toBe("diverged");
    expect(report.divergences).toEqual([
      {
        table: "stage_artifact_alias",
        key: "run-1\u0000stage-1\u0000report.md",
        field: "artifactId",
        stored: "artifact-1",
        replayed: "artifact-2",
      },
    ]);
  });
});

describe("injected divergence — a wrong reducer (D11.4)", () => {
  it("reports the exact offending field, not merely a digest mismatch", () => {
    seedAllFourTables();

    // Models the realistic production case: a reducer bug shipped in a later
    // version, inflating every revision it writes.
    const inflateRevision = (state: ProjectionState, event: Parameters<typeof applyEvent>[1]) => {
      const next = applyEvent(state, event);
      const runs: Record<string, (typeof next.runs)[string]> = {};
      for (const [key, row] of Object.entries(next.runs)) {
        runs[key] = { ...row, revision: row.revision * 11 };
      }
      return { ...next, runs };
    };

    const report = compareProjectionToReplay(db, { reducer: inflateRevision });

    expect(report.status).toBe("diverged");
    expect(report.projectionDigest.stored).not.toBe(report.projectionDigest.replayed);
    // The inflation COMPOUNDS across the fold, which plan Task 5.3's
    // illustrative "stored: 3, replayed: 33" does not account for: 33 is what
    // a single application would give, but replay applies the doctored
    // reducer to every event in turn. run.created writes 1 → 11;
    // run.workspace_assigned reads 11, increments to 12, inflates to 132;
    // run.status_changed reads 132, increments to 133, inflates to 1463.
    // Asserting the real number keeps this a genuine exact-value assertion
    // rather than one loosened until it passed.
    expect(1 * 11).toBe(11);
    expect((11 + 1) * 11).toBe(132);
    expect((132 + 1) * 11).toBe(1463);
    expect(report.divergences).toEqual([
      {
        table: "run_projection",
        key: "run-1",
        field: "revision",
        stored: 3,
        replayed: 1463,
      },
    ]);
  });
});

describe("injected divergence — out-of-band surgery", () => {
  it("detects a projection row edited behind the journal's back", () => {
    seedAllFourTables();

    // Close the source FIRST (finding C3). Closing checkpoints the WAL and
    // removes the -wal sidecar; copying the main file while the source is
    // still open in WAL mode copies only the checkpointed portion, and the
    // copy then opens with "no such table: run_projection" — a case that
    // would test nothing at all.
    db.close();
    const copyPath = join(directory, "copy.sqlite");
    copyFileSync(path, copyPath);

    const copy = openStateDatabase({
      path: copyPath,
      clock: createFakeClock(),
      ids: createDeterministicIds(1),
    });
    try {
      const handle = internalHandle(copy);
      // D5's named, deliberate escape hatch — the layered answer to tampering
      // is this divergence checker, not a trigger that cannot be dropped.
      handle.exec("DROP TRIGGER run_projection_causal_update");
      handle.exec("UPDATE run_projection SET status = 'failed' WHERE run_id = 'run-1'");

      const report = compareProjectionToReplay(copy);
      expect(report.status).toBe("diverged");
      expect(report.projectionDigest.stored).not.toBe(report.projectionDigest.replayed);
      expect(report.divergences).toEqual([
        {
          table: "run_projection",
          key: "run-1",
          field: "status",
          stored: "failed",
          replayed: "succeeded",
        },
      ]);
    } finally {
      copy.close();
    }

    // Reopen the original so the shared afterEach's close() has a live handle.
    db = openStateDatabase({ path, clock: createFakeClock(), ids: createDeterministicIds(1) });
  });
});

describe("a row present on one side only", () => {
  it("emits a single field-null divergence carrying the whole stored row", () => {
    seedAllFourTables();
    const sequence = latestSequence(db);

    // A projection row with no `run.created` event behind it — the replay has
    // nothing to construct it from.
    internalHandle(db)
      .prepare(
        "INSERT INTO run_projection" +
          " (run_id, status, revision, last_event_sequence, codebase_id, updated_at, workspace_id)" +
          " VALUES ('run-orphan', 'queued', 1, ?, 'cb-1', '2026-01-01T00:00:00.000Z', NULL)",
      )
      .run(sequence);

    const report = compareProjectionToReplay(db);
    expect(report.status).toBe("diverged");
    expect(report.divergences).toEqual([
      {
        table: "run_projection",
        key: "run-orphan",
        field: null,
        stored: {
          runId: "run-orphan",
          status: "queued",
          revision: 1,
          lastEventSequence: sequence,
          workspaceId: null,
          codebaseId: "cb-1",
          updatedAt: "2026-01-01T00:00:00.000Z",
          instructionSnapshotSha256: null,
          instructionSnapshotJson: null,
        },
        replayed: null,
      },
    ]);
  });
});

describe("determinism (E2)", () => {
  it("the same journal replayed twice yields byte-identical digests", () => {
    seedAllFourTables();
    const first = compareProjectionToReplay(db);
    const second = compareProjectionToReplay(db);
    expect(second.projectionDigest).toEqual(first.projectionDigest);
    expect(second.schemaFingerprint).toEqual(first.schemaFingerprint);
  });

  it("the whole report round-trips through JSON unchanged", () => {
    seedAllFourTables();
    const report = compareProjectionToReplay(db);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("divergence ordering is stable across runs", () => {
    seedAllFourTables();
    const sequence = latestSequence(db);
    const handle = internalHandle(db);
    for (const runId of ["run-z", "run-a", "run-m"]) {
      handle
        .prepare(
          "INSERT INTO run_projection" +
            " (run_id, status, revision, last_event_sequence, codebase_id, updated_at, workspace_id)" +
            " VALUES (?, 'queued', 1, ?, 'cb-1', '2026-01-01T00:00:00.000Z', NULL)",
        )
        .run(runId, sequence);
    }

    const first = compareProjectionToReplay(db);
    const second = compareProjectionToReplay(db);
    expect(first.divergences.map((entry) => entry.key)).toEqual(["run-a", "run-m", "run-z"]);
    expect(second.divergences).toEqual(first.divergences);
  });
});

describe("throughSequence prefix", () => {
  it("replaying a prefix reports the prefix state and says it diverges, rather than throwing", () => {
    seedAllFourTables();
    const latest = latestSequence(db);

    const prefix = replayJournal(db, { throughSequence: latest - 1 });
    expect(prefix.eventsReplayed).toBe(5);
    expect(prefix.throughSequence).toBe(latest - 1);
    // The prefix stops before the final status change, so the run is still at
    // the revision the workspace assignment left it at.
    expect(prefix.state.runs["run-1"]?.revision).toBe(2);

    const report = compareProjectionToReplay(db, { throughSequence: latest - 1 });
    // Legitimately diverged — the report *says so* rather than throwing, which
    // is what makes a prefix replay usable as a diagnostic.
    expect(report.status).toBe("diverged");
    expect(report.throughSequence).toBe(latest - 1);
    expect(report.divergences.map((entry) => entry.field)).toContain("revision");
  });
});
