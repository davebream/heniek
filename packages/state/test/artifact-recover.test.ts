/**
 * `recoverArtifacts` (plan Task 5.1, R5/I7 / design D5, D5a). Mirrors
 * `complete-stage.test.ts`'s fixture shape: a real, migrated `StateDatabase`
 * (temp-file SQLite) paired with a fake, fault-injectable `ArtifactStore`.
 * The REQUIRED probe test (dispatch — "prove the test works") additionally
 * uses the REAL filesystem, matching `artifact-store.test.ts`'s H4 case.
 *
 * **No gated mode.** An earlier revision of `recoverArtifacts` gated
 * `incoming/` removal behind `options.minAgeMs`, comparing the store's
 * `Clock` against `lstat().mtimeMs`. The Phase 4/5 fix cycle removed that
 * mode entirely — the same unsound pattern `store.ts`'s H1 fix already
 * rejected for the on-open sweep, one module over (see `recover.ts`'s
 * docblock for the full argument). `recoverArtifacts` has exactly one mode:
 * unconditional removal, documented as requiring the caller to hold the
 * store's single-writer lock for the duration of the call.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompleteStageArtifactInput } from "../src/artifact/complete-stage.js";
import { completeStage } from "../src/artifact/complete-stage.js";
import { publishArtifact } from "../src/artifact/publish.js";
import { recoverArtifacts } from "../src/artifact/recover.js";
import {
  type ArtifactStore,
  createArtifactStore,
  createArtifactStoreInternal,
} from "../src/artifact/store.js";
import { commitStateChange } from "../src/command/commit.js";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { ArtifactRecoveryError } from "../src/errors.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import {
  createFakeArtifactFileSystem,
  type FakeArtifactFileSystem,
} from "./helpers/fake-artifact-file-system.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function countRows(db: StateDatabase, table: string): number {
  const row = internalHandle(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.n ?? -1);
}

let directory: string;
let db: StateDatabase;
let store: ArtifactStore;
let fakeFs: FakeArtifactFileSystem;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  db = openStateDatabase({
    path: temp.path,
    clock: createFakeClock(),
    ids: createDeterministicIds(1),
  });
  runMigrations(db);
  commitStateChange(db, { type: "codebase.registered", payload: { codebaseId: "cb-1" } });
  commitStateChange(db, {
    runId: "run-1",
    type: "run.created",
    payload: { runId: "run-1", codebaseId: "cb-1" },
  });

  fakeFs = createFakeArtifactFileSystem(1_000);
  store = createArtifactStoreInternal(
    { root: "/store", clock: createFakeClock(), ids: createDeterministicIds(1) },
    fakeFs,
  );
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function publishFor(bytes: Uint8Array, name: string): CompleteStageArtifactInput {
  const receipt = publishArtifact(store, { bytes });
  return {
    receipt,
    name,
    mediaType: "text/markdown",
    contentSchemaId: "heniek://contract/Report/v1",
    producer: "reviewer",
    sourceLineage: [],
  };
}

describe("recoverArtifacts — the required cases (plan Task 5.1 done-when, adapted post-Phase-4/5 fix cycle: no gated mode)", () => {
  it("committed data survives an unconditional recovery pass", () => {
    const artifact = publishFor(new TextEncoder().encode("committed content"), "a.md");
    completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] });
    const finalPath = `/store/${artifact.receipt.relativePath}`;
    expect(fakeFs.fileExists(finalPath)).toBe(true);

    const report = recoverArtifacts(store, db);

    expect(fakeFs.fileExists(finalPath)).toBe(true);
    expect(sha256Hex(fakeFs.readFile(finalPath))).toBe(artifact.receipt.contentHash);
    expect(countRows(db, "artifact")).toBe(1);
    expect(report.unreferencedBlobs).toEqual([]);
  });

  it("an orphan incoming/ temp is removed", () => {
    // A temp that never got linked anywhere — models a crashed publisher
    // that died between openExclusive and link (R4 steps 1-6).
    fakeFs.openExclusive("/store/incoming/orphan.tmp");
    expect(fakeFs.readdir(store.incomingDir)).toEqual(["orphan.tmp"]);

    const report = recoverArtifacts(store, db);

    expect(report.removedIncoming).toEqual(["orphan.tmp"]);
    expect(fakeFs.fileExists("/store/incoming/orphan.tmp")).toBe(false);
  });

  it("a publish-then-rollback orphan (AC-3) is classified unreferenced and NEVER removed", () => {
    // Mirrors complete-stage.test.ts's own AC-3 case: publish succeeds, then
    // the transaction that would have completed the stage never runs (or
    // rolls back) — the blob is durable with no artifact row.
    // recoverArtifacts must classify it exactly like any other unreferenced
    // blob: retained, never removed.
    const artifact = publishFor(new TextEncoder().encode("orphaned but never lost"), "a.md");
    const finalPath = `/store/${artifact.receipt.relativePath}`;
    expect(fakeFs.fileExists(finalPath)).toBe(true);
    expect(countRows(db, "artifact")).toBe(0); // never completed — no row exists

    const report = recoverArtifacts(store, db);

    expect(fakeFs.fileExists(finalPath)).toBe(true);
    expect(sha256Hex(fakeFs.readFile(finalPath))).toBe(artifact.receipt.contentHash);
    expect(report.unreferencedBlobs).toEqual([artifact.receipt.relativePath]);
  });

  it("a blob with no referencing artifact row is classified unreferenced and NEVER removed", () => {
    // Directly plants a blob with no artifact row — a second, more direct
    // model of the same unreferenced-blob classification (no publish call
    // involved at all, e.g. a blob whose only artifact row was never
    // written for reasons unrelated to publication).
    const bytes = new TextEncoder().encode("unreferenced content");
    const hash = sha256Hex(bytes);
    const finalPath = `/store/blobs/sha256/${hash}`;
    const fd = fakeFs.openExclusive(finalPath);
    fakeFs.write(fd, bytes);
    fakeFs.close(fd);

    const report = recoverArtifacts(store, db);

    expect(report.unreferencedBlobs).toEqual([`blobs/sha256/${hash}`]);
    expect(fakeFs.fileExists(finalPath)).toBe(true);
  });

  it("recovery never calls unlink on anything under blobs/ — classification is read-only", () => {
    const bytes = new TextEncoder().encode("never touched");
    const hash = sha256Hex(bytes);
    const finalPath = `/store/blobs/sha256/${hash}`;
    const fd = fakeFs.openExclusive(finalPath);
    fakeFs.write(fd, bytes);
    fakeFs.close(fd);
    fakeFs.openExclusive("/store/incoming/leftover.tmp");

    recoverArtifacts(store, db);

    const unlinkCallsUnderBlobs = fakeFs.calls.filter(
      (call) => call.method === "unlink" && String(call.args[0]).startsWith("/store/blobs/"),
    );
    expect(unlinkCallsUnderBlobs).toEqual([]);
  });

  it("recovery is idempotent — a second pass over the same, already-clean state is a no-op", () => {
    const artifact = publishFor(new TextEncoder().encode("stable content"), "a.md");
    completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] });
    fakeFs.openExclusive("/store/incoming/leftover.tmp");

    const first = recoverArtifacts(store, db);
    expect(first.removedIncoming).toEqual(["leftover.tmp"]);

    const second = recoverArtifacts(store, db);
    expect(second.removedIncoming).toEqual([]);
    expect(second.unreferencedBlobs).toEqual(first.unreferencedBlobs);
  });
});

describe("recoverArtifacts — container discipline (mirrors store.ts's H2)", () => {
  it("refuses when incoming/ is a symlink, not a real directory", () => {
    const symlinkFs = createFakeArtifactFileSystem(0);
    const symlinkStore = createArtifactStoreInternal(
      { root: "/sym-store", clock: createFakeClock(), ids: createDeterministicIds(1) },
      symlinkFs,
    );
    symlinkFs.plantSymlink(symlinkStore.incomingDir);
    expect(() => recoverArtifacts(symlinkStore, db)).toThrowError(ArtifactRecoveryError);
  });
});

describe("recoverArtifacts — the no-loss proof is pinned, not merely asserted in prose", () => {
  it("SQLite itself refuses a committed row whose relative_path names an incoming/ path (migration 4's CHECK)", () => {
    const handle = internalHandle(db);
    const sequenceRow = internalHandle(db).prepare("SELECT MAX(sequence) AS s FROM state_event").get();
    const sequence = Number(sequenceRow?.s ?? 0);
    let caught: unknown;
    try {
      handle
        .prepare(
          "INSERT INTO artifact (artifact_id, run_id, stage_id, name, content_hash, byte_length," +
            " media_type, content_schema_id, producer, source_lineage, relative_path, created_at," +
            " revision, last_event_sequence)" +
            " VALUES ('artifact-escapes-to-incoming', 'run-1', 'stage-1', 'a.md'," +
            ` '${"a".repeat(64)}', 0, 'text/plain', 'heniek://contract/Example/v1', 'test',` +
            " '[]', 'incoming/should-be-impossible.tmp', '2026-01-01T00:00:00.000Z', 1, ?)",
        )
        .run(sequence);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/CHECK constraint failed/i);
    expect(countRows(db, "artifact")).toBe(0);
  });
});

describe("recoverArtifacts — REQUIRED PROBE (dispatch): real blob survives, and the test is proven to actually catch a regression", () => {
  it("a real blob written under blobs/sha256/ on the real filesystem survives an unconditional recovery pass", async () => {
    const realDirectory = await mkdtemp(join(tmpdir(), "heniek-state-recover-probe-"));
    try {
      const realStore = createArtifactStore({
        root: realDirectory,
        clock: createFakeClock(),
        ids: createDeterministicIds(1),
      });
      const bytes = new TextEncoder().encode("a real blob, real bytes, real disk");
      const hash = sha256Hex(bytes);
      const blobPath = join(realDirectory, "blobs", "sha256", hash);
      await writeFile(blobPath, bytes);

      const probeTemp = await makeTempDbPath();
      const probeDb = openStateDatabase({
        path: probeTemp.path,
        clock: createFakeClock(),
        ids: createDeterministicIds(1),
      });
      try {
        runMigrations(probeDb);

        const report = recoverArtifacts(realStore, probeDb);

        await expect(stat(blobPath)).resolves.toBeDefined();
        expect(new Uint8Array(await readFile(blobPath))).toEqual(bytes);
        expect(report.unreferencedBlobs).toEqual([`blobs/sha256/${hash}`]);
      } finally {
        probeDb.close();
        await rm(probeTemp.directory, { recursive: true, force: true });
      }
    } finally {
      await rm(realDirectory, { recursive: true, force: true });
    }
  });
});
