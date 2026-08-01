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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitStateChange } from "../src/command/commit.js";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { latestSequence } from "../src/journal/read.js";
import { runMigrations } from "../src/migrations/migrate.js";
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

describe("converged", () => {
  it("a journal touching all four tables replays to exactly the stored projection", () => {
    seedAllFourTables();
    const report = compareProjectionToReplay(db);

    expect(report.status).toBe("converged");
    expect(report.divergences).toEqual([]);
    expect(report.projectionDigest.stored).toBe(report.projectionDigest.replayed);
    expect(report.eventsReplayed).toBe(6);
    expect(report.throughSequence).toBe(latestSequence(db));
    expect(report.schemaFingerprint.userVersion).toBe(3);
  });

  it("an empty journal converges on empty state", () => {
    const report = compareProjectionToReplay(db);
    expect(report.status).toBe("converged");
    expect(report.eventsReplayed).toBe(0);
    expect(report.throughSequence).toBe(0);
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
