/**
 * `listArtifacts` (plan Task 5.2, design D5). Same fixture shape as
 * `complete-stage.test.ts`/`artifact-recover.test.ts`: a real, migrated
 * `StateDatabase` paired with a fake, fault-injectable `ArtifactStore`.
 */

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompleteStageArtifactInput } from "../src/artifact/complete-stage.js";
import { completeStage } from "../src/artifact/complete-stage.js";
import { listArtifacts } from "../src/artifact/inventory.js";
import { publishArtifact } from "../src/artifact/publish.js";
import { type ArtifactStore, createArtifactStoreInternal } from "../src/artifact/store.js";
import { commitStateChange } from "../src/command/commit.js";
import { openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import {
  createFakeArtifactFileSystem,
  type FakeArtifactFileSystem,
} from "./helpers/fake-artifact-file-system.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

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

describe("listArtifacts (plan Task 5.2)", () => {
  it("lists no rows against an empty database", () => {
    expect(listArtifacts(db, store)).toEqual([]);
  });

  it("reports an untampered artifact as verified: true, with every field carried through", () => {
    const artifact = publishFor(new TextEncoder().encode("clean bytes"), "report.md");
    completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] });

    const rows = listArtifacts(db, store);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.verified).toBe(true);
    expect(row?.artifactId).toBe(artifact.receipt.artifactId);
    expect(row?.runId).toBe("run-1");
    expect(row?.stageId).toBe("stage-1");
    expect(row?.name).toBe("report.md");
    expect(row?.contentHash).toBe(artifact.receipt.contentHash);
    expect(row?.byteLength).toBe(artifact.receipt.byteLength);
    expect(row?.relativePath).toBe(artifact.receipt.relativePath);
  });

  it("REQUIRED (plan Task 5.2 failing-test-first case): a tampered blob is reported verified: false, and the row is still listed", () => {
    const original = new TextEncoder().encode("original, hashed bytes");
    const artifact = publishFor(original, "a.md");
    completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] });

    // Same-length corruption so nlink/size/ino/dev-style checks (not run by
    // listArtifacts at all) would stay silent even if they were — only a
    // full re-hash catches this, which is exactly what this pass exists for.
    const tampered = new Uint8Array(original.length).fill("X".charCodeAt(0));
    expect(tampered.length).toBe(original.length);
    fakeFs.corruptFile(`/store/${artifact.receipt.relativePath}`, tampered);

    const rows = listArtifacts(db, store);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.artifactId).toBe(artifact.receipt.artifactId);
    expect(row?.contentHash).toBe(artifact.receipt.contentHash); // the row's own claim is untouched
    expect(row?.verified).toBe(false); // but re-verification against current bytes fails
  });

  it("a vanished blob (removed after commit, the S2 TOCTOU window J2 documents) is reported verified: false, row still listed", () => {
    const artifact = publishFor(new TextEncoder().encode("will be removed"), "a.md");
    completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] });
    fakeFs.unlink(`/store/${artifact.receipt.relativePath}`);

    const rows = listArtifacts(db, store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verified).toBe(false);
  });

  it("lists every row in artifactId order, deterministically", () => {
    const a = publishFor(new TextEncoder().encode("first"), "a.md");
    const b = publishFor(new TextEncoder().encode("second"), "b.md");
    completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [a, b] });

    const rows = listArtifacts(db, store);
    expect(rows).toHaveLength(2);
    const sortedIds = [...rows].map((row) => row.artifactId).sort((x, y) => x.localeCompare(y));
    expect(rows.map((row) => row.artifactId)).toEqual(sortedIds);
  });

  it("REQUIRED (K5, Phase 5 fix cycle): never mutates the filesystem — even with an unreferenced blob and a stray incoming/ entry present", () => {
    // Mirrors artifact-recover.test.ts's own "classification is read-only"
    // call-log assertion (line ~160 there). Before this test, non-mutation
    // was guaranteed only by reading inventory.ts's source (it never calls
    // unlink/link/write/mkdir/fchmod) — nothing in the suite pinned it, so a
    // mutation that made listArtifacts unlink an unreferenced blob, or
    // anything not named by an artifact row, would have left every other
    // case in this file green.
    const artifact = publishFor(new TextEncoder().encode("referenced"), "a.md");
    completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] });

    const bytes = new TextEncoder().encode("unreferenced content, never named by any row");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const unreferencedFd = fakeFs.openExclusive(`/store/blobs/sha256/${hash}`);
    fakeFs.write(unreferencedFd, bytes);
    fakeFs.close(unreferencedFd);
    fakeFs.openExclusive("/store/incoming/leftover.tmp");

    // Snapshot the call count now — setup above (publishFor/completeStage)
    // legitimately makes write/link/fchmod calls of its own; only calls made
    // BY listArtifacts itself must be free of mutation.
    const callsBeforeListArtifacts = fakeFs.calls.length;
    const rows = listArtifacts(db, store);
    expect(rows).toHaveLength(1);

    const mutatingMethods = new Set(["unlink", "link", "write", "mkdir", "fchmod"]);
    const mutatingCalls = fakeFs.calls
      .slice(callsBeforeListArtifacts)
      .filter((call) => mutatingMethods.has(call.method));
    expect(mutatingCalls).toEqual([]);
  });
});
