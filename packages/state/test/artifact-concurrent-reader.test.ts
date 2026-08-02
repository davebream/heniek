/**
 * Concurrent-reader tests (issue #8 "Required tests"; plan Task 6.2, R9).
 * Content-hash correctness and immutability are covered elsewhere
 * (`artifact-publish.test.ts`, `schema-constraints.test.ts`'s `artifact`
 * rows) — this file is the one piece of that requirement still missing:
 * proof that a reader holding an open fd on the real filesystem observes
 * stable, complete bytes while a second writer is concurrently active
 * against the same store, whether that writer is publishing (this store's
 * own single-connection filesystem operations, matching R9's "cannot hit
 * SQLITE_BUSY" framing — no second `StateDatabase` connection is opened
 * here) or sweeping via `recoverArtifacts`.
 *
 * Deterministic throughout: real `mkdtemp` directories and real fd
 * operations via `createArtifactStore`'s production `node:fs` adapter
 * (reached through the module-private `internalArtifactFileSystem`
 * accessor already used by `artifact-store.test.ts`'s H4 case and by
 * `complete-stage.ts`/`inventory.ts`/`recover.ts` themselves), but no
 * ambient clock or randomness: the injected `Clock` and `IdGenerator` are
 * the same fakes every other artifact test suite uses, and "concurrency" is
 * modelled as ordered, synchronous interleaving of two writers' filesystem
 * calls against one open reader fd — not threads, workers, or timers — so
 * these cases can never be timing-flaky.
 */

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishArtifact } from "../src/artifact/publish.js";
import { recoverArtifacts } from "../src/artifact/recover.js";
import { createArtifactStore, internalArtifactFileSystem } from "../src/artifact/store.js";
import { openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let directory: string;
let db: StateDatabase;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  db = openStateDatabase({
    path: temp.path,
    clock: createFakeClock(),
    ids: createDeterministicIds(1),
  });
  runMigrations(db);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("concurrent readers over the real filesystem (Task 6.2, R9)", () => {
  it("a reader's open fd on a committed blob observes stable bytes while a second writer concurrently republishes the identical content (adopt path)", () => {
    const root = join(directory, "store-adopt");
    const store = createArtifactStore({
      root,
      clock: createFakeClock(),
      ids: createDeterministicIds(1),
    });
    const bytes = new TextEncoder().encode("stable content read under a concurrent republish");
    const first = publishArtifact(store, { bytes });
    expect(first.contentHash).toBe(sha256Hex(bytes));

    // The reader: an independent read-only fd on the committed blob, opened
    // through the same production port the store itself uses — modelling a
    // second process that only ever reads and holds its fd open across the
    // next writer's call.
    const fs = internalArtifactFileSystem(store);
    const blobPath = join(store.root, first.relativePath);
    const readerFd = fs.openReadOnly(blobPath);

    // The reader starts reading before the second writer runs.
    const partialRead = new Uint8Array(10);
    fs.readAt(readerFd, partialRead, 0);

    // A second, concurrent writer publishes byte-identical content. `link`
    // returns EEXIST and `publishArtifact` adopts the already-committed
    // blob — D3/D14n's whole point is that this path never overwrites the
    // bytes at an address a reader may already have open.
    const second = publishArtifact(store, { bytes });
    expect(second.adopted).toBe(true);
    expect(second.relativePath).toBe(first.relativePath);

    // The reader continues through its still-open fd, unaffected by the
    // second writer's adopt, and sees the complete original bytes.
    const fullRead = new Uint8Array(bytes.length);
    fs.readAt(readerFd, fullRead, 0);
    expect(fullRead).toEqual(bytes);
    expect(fullRead.subarray(0, 10)).toEqual(partialRead);

    fs.close(readerFd);
    fs.close(first.fd);
    fs.close(second.fd);
  });

  it("a reader's open fd on one committed blob is unaffected by a concurrent writer publishing an entirely different artifact", () => {
    const root = join(directory, "store-independent");
    const store = createArtifactStore({
      root,
      clock: createFakeClock(),
      ids: createDeterministicIds(1),
    });
    const bytesA = new TextEncoder().encode("artifact A's stable bytes, read while B is published");
    const a = publishArtifact(store, { bytes: bytesA });

    const fs = internalArtifactFileSystem(store);
    const blobPathA = join(store.root, a.relativePath);
    const readerFd = fs.openReadOnly(blobPathA);

    // A second, concurrent writer publishes a wholly different artifact into
    // the same store while the reader's fd on A stays open — a distinct
    // content address, so this exercises the normal-publish path rather
    // than adopt, unlike the first case above.
    const bytesB = new TextEncoder().encode("artifact B's different bytes at a different address");
    const b = publishArtifact(store, { bytes: bytesB });
    expect(b.relativePath).not.toBe(a.relativePath);
    expect(b.adopted).toBe(false);

    const readBack = new Uint8Array(bytesA.length);
    fs.readAt(readerFd, readBack, 0);
    expect(readBack).toEqual(bytesA);

    fs.close(readerFd);
    fs.close(a.fd);
    fs.close(b.fd);
  });

  it("a reader's open fd on a committed blob observes complete, non-torn bytes across a concurrent recoverArtifacts sweep (R5/D5a) — recovery never touches blobs/", () => {
    const root = join(directory, "store-recovery");
    const store = createArtifactStore({
      root,
      clock: createFakeClock(),
      ids: createDeterministicIds(1),
    });
    const bytes = new TextEncoder().encode(
      "committed content a reader watches through a concurrent recovery sweep",
    );
    const committed = publishArtifact(store, { bytes });
    const fs = internalArtifactFileSystem(store);
    const blobPath = join(store.root, committed.relativePath);

    // A second, concurrent writer's abandoned in-flight temp — exactly the
    // kind of entry `recoverArtifacts` removes.
    const orphanFd = fs.openExclusive(join(store.incomingDir, "orphan.tmp"));
    fs.write(orphanFd, new TextEncoder().encode("abandoned mid-write bytes from another writer"));
    fs.close(orphanFd);

    // The reader: an independent read-only fd on the already-committed blob,
    // opened before recovery runs and held open across the sweep.
    const readerFd = fs.openReadOnly(blobPath);
    const beforeRecovery = new Uint8Array(bytes.length);
    fs.readAt(readerFd, beforeRecovery, 0);
    expect(beforeRecovery).toEqual(bytes);

    const report = recoverArtifacts(store, db);
    expect(report.removedIncoming).toEqual(["orphan.tmp"]);

    // The reader, still holding the SAME fd it opened before the sweep,
    // reads the identical full byte range again — never truncated, never
    // torn, never redirected to different bytes — because `recoverArtifacts`
    // only ever unlinks `incoming/` entries (migration 4's `CHECK`s make a
    // committed row's `relative_path` schema-disjoint from `incoming/`, see
    // `recover.ts`'s docblock) and never touches `blobs/`.
    const afterRecovery = new Uint8Array(bytes.length);
    fs.readAt(readerFd, afterRecovery, 0);
    expect(afterRecovery).toEqual(bytes);
    expect(afterRecovery).toEqual(beforeRecovery);

    // The committed blob is still present on disk, at its original address
    // and size — recovery neither removed nor truncated it.
    const stat = fs.lstat(blobPath);
    expect(stat.size).toBe(bytes.length);
    expect(stat.isSymbolicLink).toBe(false);

    fs.close(readerFd);
    fs.close(committed.fd);
  });
});
