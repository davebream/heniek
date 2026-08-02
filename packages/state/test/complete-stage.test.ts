/**
 * `completeStage` (plan Tasks 4.3/4.4/4.5, design D4) — §16.6 steps 4-6 as
 * one transaction, over a real `StateDatabase` (temp-file SQLite, migrated)
 * paired with a fake, fault-injectable `ArtifactStore` (the same
 * `createArtifactStoreInternal`/`createFakeArtifactFileSystem` combination
 * `artifact-publish.test.ts` and `artifact-fault.test.ts` use).
 */

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CompleteStageArtifactInput, completeStage } from "../src/artifact/complete-stage.js";
import { publishArtifact } from "../src/artifact/publish.js";
import { type ArtifactStore, createArtifactStoreInternal } from "../src/artifact/store.js";
import { commitStateChange } from "../src/command/commit.js";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { StageAssertionFailedError } from "../src/errors.js";
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

/** Builds a `CompleteStageArtifactInput` from a fresh publish. */
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

function artifactRow(artifactId: string): Record<string, unknown> | undefined {
  return internalHandle(db)
    .prepare("SELECT * FROM artifact WHERE artifact_id = ?")
    .get(artifactId) as Record<string, unknown> | undefined;
}

function aliasRow(
  runId: string,
  stageId: string,
  name: string,
): Record<string, unknown> | undefined {
  return internalHandle(db)
    .prepare("SELECT * FROM stage_artifact_alias WHERE run_id = ? AND stage_id = ? AND name = ?")
    .get(runId, stageId, name) as Record<string, unknown> | undefined;
}

describe("completeStage — end-to-end (plan Task 4.4 done-when)", () => {
  it("publishes, completes, and reads back the alias", () => {
    const artifact = publishFor(new TextEncoder().encode("report content"), "report.md");
    const report = completeStage(db, store, {
      runId: "run-1",
      stageId: "stage-1",
      artifacts: [artifact],
    });

    expect(report.revision).toBe(1); // the alias's revision (primaryTable), not the artifact's by coincidence
    const storedArtifact = artifactRow(artifact.receipt.artifactId);
    expect(storedArtifact?.relative_path).toBe(artifact.receipt.relativePath);
    expect(storedArtifact?.content_hash).toBe(artifact.receipt.contentHash);

    const alias = aliasRow("run-1", "stage-1", "report.md");
    expect(alias?.artifact_id).toBe(artifact.receipt.artifactId);
    expect(alias?.revision).toBe(1);
  });

  it("a stage that produces no outputs completes with an empty artifacts array (F8)", () => {
    const report = completeStage(db, store, {
      runId: "run-1",
      stageId: "stage-empty",
      artifacts: [],
    });
    expect(report.revision).toBe(0);
    expect(countRows(db, "artifact")).toBe(0);
    expect(countRows(db, "stage_artifact_alias")).toBe(0);
  });

  it("closes every receipt fd it was handed, on success", () => {
    const artifact = publishFor(new TextEncoder().encode("closed on success"), "a.md");
    completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] });
    expect(() => fakeFs.fstat(artifact.receipt.fd)).toThrow();
  });
});

describe("completeStage — S2 under-lock assertion (plan Task 4.3)", () => {
  it("fstat reporting nlink === 0 (full unlink) is refused, and nothing is written", () => {
    const artifact = publishFor(new TextEncoder().encode("will be unlinked"), "a.md");
    const finalPath = `/store/${artifact.receipt.relativePath}`;
    // Simulates the blob vanishing from under the receipt between publish
    // and completeStage — the fd stays open (kernel keeps the inode alive),
    // but its only directory entry is gone.
    fakeFs.unlink(finalPath);

    expect(() =>
      completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] }),
    ).toThrow(/nlink/);
    expect(countRows(db, "artifact")).toBe(0);
    expect(countRows(db, "stage_artifact_alias")).toBe(0);
  });

  it("fstat reporting nlink === 2 (a crashed publisher's incoming/ residue) is ACCEPTED, never refused", () => {
    const artifact = publishFor(new TextEncoder().encode("legitimately double-linked"), "a.md");
    const finalPath = `/store/${artifact.receipt.relativePath}`;
    // A second hard link to the SAME inode — models a crashed publisher's
    // own incoming/ temp that never got unlinked (R4 step 8).
    fakeFs.link(finalPath, "/store/incoming/leftover.tmp");
    expect(fakeFs.linkCountOf(finalPath)).toBe(2);

    const report = completeStage(db, store, {
      runId: "run-1",
      stageId: "stage-1",
      artifacts: [artifact],
    });
    expect(report.revision).toBe(1);
    expect(artifactRow(artifact.receipt.artifactId)).toBeDefined();
  });

  it("a name->inode binding mismatch (the blob path now names a DIFFERENT file) is refused, and nothing is written", () => {
    const artifact = publishFor(new TextEncoder().encode("original bytes"), "a.md");
    const finalPath = `/store/${artifact.receipt.relativePath}`;

    // Keep the original inode alive via a second name so unlinking
    // `finalPath` does not itself trip the nlink>=1 check below — this test
    // is isolating the ino/dev binding check, not the nlink check.
    fakeFs.link(finalPath, "/store/blobs/sha256/decoy-keepalive");
    fakeFs.unlink(finalPath);
    // A different file now occupies the same path — a distinct inode.
    const otherFd = fakeFs.openExclusive(finalPath);
    fakeFs.write(otherFd, new TextEncoder().encode("different bytes entirely"));
    fakeFs.close(otherFd);

    expect(() =>
      completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] }),
    ).toThrow(/inode/);
    expect(countRows(db, "artifact")).toBe(0);
    expect(countRows(db, "stage_artifact_alias")).toBe(0);
  });

  it("a size mismatch under the pinned fd is refused", () => {
    const artifact = publishFor(new TextEncoder().encode("twelve bytes"), "a.md");
    // Forge a receipt claiming a byteLength the actual blob does not have —
    // models the pinned fd's underlying file having changed size.
    const forged: CompleteStageArtifactInput = {
      ...artifact,
      receipt: { ...artifact.receipt, byteLength: artifact.receipt.byteLength + 1 },
    };
    expect(() =>
      completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [forged] }),
    ).toThrow(/size/);
    expect(countRows(db, "artifact")).toBe(0);
  });
});

describe("completeStage — transaction atomicity and fault injection (plan Task 4.5)", () => {
  /**
   * Arms `fstat` to fail on the FIRST call `completeStage`'s own S2
   * assertion makes — i.e. immediately before `COMMIT`, after every
   * projection row this command would write has already been written
   * in-transaction (see `command/commit.ts`'s step 9c). `armFaultAtOccurrence`
   * (an explicit occurrence number) is required here, not the auto-advancing
   * `armFaultBefore`, because `publishArtifact` itself already consumed
   * `fstat` occurrences before this point.
   */
  function armFstatFailureForCompleteStagesOwnAssertion(error: unknown): void {
    const priorFstatCalls = fakeFs.calls.filter((call) => call.method === "fstat").length;
    fakeFs.armFaultAtOccurrence("fstat", priorFstatCalls + 1, "before", error);
  }

  it("a failure in the post-write, pre-COMMIT assertion rolls back BOTH the event and every projection row — none land", () => {
    const artifact = publishFor(new TextEncoder().encode("atomic or nothing"), "a.md");
    const eventsBefore = countRows(db, "state_event");
    armFstatFailureForCompleteStagesOwnAssertion(Object.assign(new Error("EIO"), { code: "EIO" }));

    expect(() =>
      completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] }),
    ).toThrow();

    expect(countRows(db, "state_event")).toBe(eventsBefore);
    expect(countRows(db, "artifact")).toBe(0);
    expect(countRows(db, "stage_artifact_alias")).toBe(0);
  });

  /**
   * AC-3's no-loss claim (dispatch requirement 7): a crash or rollback
   * between publish and commit must leave the blob durable in `blobs/` with
   * no metadata row — an orphan Phase 5 classifies, never silently adopted
   * and never lost.
   */
  it("AC-3: rolling back the transaction after a successful publish leaves the blob durable with no artifact row", () => {
    const artifact = publishFor(new TextEncoder().encode("orphaned but never lost"), "a.md");
    const finalPath = `/store/${artifact.receipt.relativePath}`;
    expect(fakeFs.fileExists(finalPath)).toBe(true);

    armFstatFailureForCompleteStagesOwnAssertion(Object.assign(new Error("EIO"), { code: "EIO" }));
    expect(() =>
      completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] }),
    ).toThrow();

    // The blob is still exactly where publishArtifact left it, byte-for-byte.
    expect(fakeFs.fileExists(finalPath)).toBe(true);
    expect(sha256Hex(fakeFs.readFile(finalPath))).toBe(artifact.receipt.contentHash);
    // No metadata row references it.
    expect(countRows(db, "artifact")).toBe(0);
  });

  it("closes the receipt fd even when the transaction rolls back", () => {
    const artifact = publishFor(new TextEncoder().encode("closed on failure too"), "a.md");
    armFstatFailureForCompleteStagesOwnAssertion(Object.assign(new Error("EIO"), { code: "EIO" }));
    expect(() =>
      completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] }),
    ).toThrow();
    expect(() => fakeFs.fstat(artifact.receipt.fd)).toThrow();
  });
});

describe("completeStage — multiple artifacts, adopt, and dedup (regression coverage)", () => {
  it("completes a stage with two distinct artifacts in one transaction", () => {
    const a = publishFor(new TextEncoder().encode("first"), "a.md");
    const b = publishFor(new TextEncoder().encode("second"), "b.md");
    const report = completeStage(db, store, {
      runId: "run-1",
      stageId: "stage-1",
      artifacts: [a, b],
    });
    expect(report.writes.filter((write) => write.table === "artifact")).toHaveLength(2);
    expect(aliasRow("run-1", "stage-1", "a.md")?.artifact_id).toBe(a.receipt.artifactId);
    expect(aliasRow("run-1", "stage-1", "b.md")?.artifact_id).toBe(b.receipt.artifactId);
  });

  it("idempotently adopts an artifact already published under the same artifactId (F2) — no duplicate row, alias still advances", () => {
    const first = publishFor(new TextEncoder().encode("shared content"), "a.md");
    completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [first] });

    // Re-publish identical bytes (idempotent adopt at the filesystem layer —
    // publishArtifact's own EEXIST handling — reusing the SAME artifactId
    // would require a caller-side cache; here we simulate the F2 reducer
    // path directly by re-citing the same artifactId/content against a
    // freshly re-opened receipt for the same bytes).
    const reopened = publishArtifact(store, { bytes: new TextEncoder().encode("shared content") });
    const secondInput: CompleteStageArtifactInput = {
      receipt: { ...reopened, artifactId: first.receipt.artifactId },
      name: "a.md",
      mediaType: "text/markdown",
      contentSchemaId: "heniek://contract/Report/v1",
      producer: "reviewer",
      sourceLineage: [],
    };
    const report = completeStage(db, store, {
      runId: "run-1",
      stageId: "stage-1",
      artifacts: [secondInput],
    });
    expect(countRows(db, "artifact")).toBe(1);
    expect(report.writes.some((write) => write.table === "artifact")).toBe(false);
    expect(aliasRow("run-1", "stage-1", "a.md")?.revision).toBe(2);
  });
});

describe("completeStage — AC-2: a retry creates a NEW immutable attempt (dispatch requirement 7)", () => {
  /*
   * Every `publishArtifact` call mints its own fresh `artifactId`
   * (`ids.next("art")`), including on the idempotent-adopt path — so two
   * genuinely separate retries that happen to produce byte-identical
   * content still carry two DISTINCT artifactIds, even though they
   * legitimately collapse to the SAME content address and share one blob
   * on disk. This is the real "retry" shape (distinct from the F2
   * same-artifactId-reused adoption test above): two separate
   * `completeStage` calls for the same (run, stage, name), each citing a
   * different artifactId, must leave TWO immutable `artifact` rows behind
   * and move only the alias.
   */
  it("two retries with identical bytes share one blob but leave two distinct, immutable artifact rows — only the alias moves", () => {
    const bytes = new TextEncoder().encode("byte-identical retry content");

    const firstReceipt = publishArtifact(store, { bytes });
    const firstInput: CompleteStageArtifactInput = {
      receipt: firstReceipt,
      name: "output.txt",
      mediaType: "text/plain",
      contentSchemaId: "heniek://contract/Report/v1",
      producer: "reviewer",
      sourceLineage: [],
    };
    completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [firstInput] });

    // The retry: identical bytes, a fresh publishArtifact call. Adopts the
    // SAME blob on disk (shared content address) but mints a NEW artifactId.
    const secondReceipt = publishArtifact(store, { bytes });
    expect(secondReceipt.relativePath).toBe(firstReceipt.relativePath);
    expect(secondReceipt.adopted).toBe(true);
    expect(secondReceipt.artifactId).not.toBe(firstReceipt.artifactId);

    const secondInput: CompleteStageArtifactInput = {
      receipt: secondReceipt,
      name: "output.txt",
      mediaType: "text/plain",
      contentSchemaId: "heniek://contract/Report/v1",
      producer: "reviewer",
      sourceLineage: [],
    };
    completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [secondInput] });

    // Two distinct rows — never one row mutated in place.
    expect(countRows(db, "artifact")).toBe(2);
    const firstRow = artifactRow(firstReceipt.artifactId);
    const secondRow = artifactRow(secondReceipt.artifactId);
    expect(firstRow?.revision).toBe(1);
    expect(secondRow?.revision).toBe(1);
    expect(firstRow?.content_hash).toBe(secondRow?.content_hash);
    expect(firstRow?.relative_path).toBe(secondRow?.relative_path);

    // Only the alias moved: still exactly one alias row, now at revision 2,
    // re-pointed at the later attempt's artifact.
    expect(countRows(db, "stage_artifact_alias")).toBe(1);
    const alias = aliasRow("run-1", "stage-1", "output.txt");
    expect(alias?.artifact_id).toBe(secondReceipt.artifactId);
    expect(alias?.revision).toBe(2);

    // The earlier attempt's row is not merely unread — it is provably
    // un-updatable: migration 4's `artifact_immutable_update` trigger
    // RAISE(ABORT)s on ANY update, regardless of who attempts it or why.
    let caught: unknown;
    try {
      internalHandle(db)
        .prepare("UPDATE artifact SET byte_length = byte_length + 1 WHERE artifact_id = ?")
        .run(firstReceipt.artifactId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("artifact is append-only");

    // Untouched: still readable at its original values after the rejected
    // UPDATE attempt.
    const firstRowAfter = artifactRow(firstReceipt.artifactId);
    expect(firstRowAfter?.content_hash).toBe(firstReceipt.contentHash);
    expect(firstRowAfter?.revision).toBe(1);
    expect(firstRowAfter?.byte_length).toBe(firstReceipt.byteLength);
  });
});

describe("completeStage — J1 (Phase 4 fix cycle): S2's fstat/lstat never leak a raw errno", () => {
  it("fstat EBADF on an already-closed receipt fd is wrapped as StageAssertionFailedError, not a raw errno", () => {
    const artifact = publishFor(new TextEncoder().encode("closed before completeStage"), "a.md");
    // Simulates a receipt whose fd was already closed — e.g. reused across
    // two completeStage calls — so the S2 assertion's own fstat(fd) hits a
    // real, no-tolerance EBADF rather than any semantic nlink/size check.
    fakeFs.close(artifact.receipt.fd);

    let caught: unknown;
    try {
      completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StageAssertionFailedError);
    expect((caught as Error).message).not.toMatch(/EBADF/);
    expect((caught as { cause?: unknown }).cause).toBeDefined();
    expect(((caught as { cause?: unknown }).cause as { code?: string } | undefined)?.code).toBe(
      "EBADF",
    );
    expect(countRows(db, "artifact")).toBe(0);
  });

  it("lstat ENOENT on a vanished blob path is wrapped as StageAssertionFailedError, not a raw errno — the nlink===1 case the >= 1 relaxation admits, where that one remaining link is incoming/ residue, not the blob address itself", () => {
    const artifact = publishFor(new TextEncoder().encode("blob address vacated"), "a.md");
    const finalPath = `/store/${artifact.receipt.relativePath}`;

    // A crashed publisher's incoming/ residue keeps the pinned fd's inode
    // alive through a SECOND name, then the blob's own address is removed —
    // leaving nlink === 1 (admitted by the S2 `>= 1` relaxation) but the
    // ONE remaining link is the incoming/ leftover, not
    // `relativePath` itself.
    fakeFs.link(finalPath, "/store/incoming/leftover.tmp");
    fakeFs.unlink(finalPath);
    expect(fakeFs.linkCountOf("/store/incoming/leftover.tmp")).toBe(1);

    let caught: unknown;
    try {
      completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [artifact] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StageAssertionFailedError);
    expect((caught as Error).message).not.toMatch(/ENOENT/);
    expect((caught as { cause?: unknown }).cause).toBeDefined();
    expect(((caught as { cause?: unknown }).cause as { code?: string } | undefined)?.code).toBe(
      "ENOENT",
    );
    expect(countRows(db, "artifact")).toBe(0);
  });
});

describe("completeStage — J4 (Phase 4 fix cycle): the finally guards fs resolution and payload/assertion construction too", () => {
  it("closes every receipt fd even when a throw happens before commitStateChangeInternal is ever called", () => {
    const artifact = publishFor(new TextEncoder().encode("throws before the write lock"), "a.md");
    const originalReceipt = artifact.receipt;
    // A receipt whose `relativePath` throws on access — models any failure
    // during the assertions/artifactRelativePaths/payload construction that
    // (pre-fix) ran BEFORE completeStage's try block began, so it could
    // leak this artifact's fd past the finally entirely.
    const brokenReceipt = new Proxy(originalReceipt, {
      get(target, prop, receiver) {
        if (prop === "relativePath") {
          throw new Error("simulated failure while building assertions/payload");
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const broken: CompleteStageArtifactInput = { ...artifact, receipt: brokenReceipt };

    expect(() =>
      completeStage(db, store, { runId: "run-1", stageId: "stage-1", artifacts: [broken] }),
    ).toThrow("simulated failure while building assertions/payload");

    // The fd is closed despite commitStateChangeInternal never having run.
    expect(() => fakeFs.fstat(originalReceipt.fd)).toThrow();
    expect(countRows(db, "artifact")).toBe(0);
  });
});
