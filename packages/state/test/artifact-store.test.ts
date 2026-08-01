/**
 * Task 3.3 — `createArtifactStore` / `createArtifactStoreInternal` (plan
 * Phase 3, R5/I7 / design D5a). `createArtifactStoreInternal` mirrors
 * `openStateDatabaseInternal`'s package-private-by-construction discipline:
 * exported from `src/artifact/store.js` but never from `src/index.js`.
 */

import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactStore, createArtifactStoreInternal } from "../src/artifact/store.js";
import { createFakeClock } from "./helpers/determinism.js";
import { createFakeArtifactFileSystem } from "./helpers/fake-artifact-file-system.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "heniek-state-artifact-store-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

let counter = 0;
function ids() {
  return {
    next(prefix: string): string {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  };
}

describe("createArtifactStore (Task 3.3)", () => {
  it("creates incoming/ and blobs/sha256/ idempotently", async () => {
    const root = join(directory, "store");
    const store = createArtifactStore({ root, clock: createFakeClock(), ids: ids() });
    expect(store.root).toBe(root);
    expect(store.incomingDir).toBe(join(root, "incoming"));
    expect(store.blobsDir).toBe(join(root, "blobs", "sha256"));

    await expect(stat(store.incomingDir)).resolves.toBeDefined();
    await expect(stat(store.blobsDir)).resolves.toBeDefined();

    // Idempotent: calling again on the same root must not throw.
    expect(() => createArtifactStore({ root, clock: createFakeClock(), ids: ids() })).not.toThrow();
  });

  it("`createArtifactStoreInternal` is absent from src/index.ts's public surface", async () => {
    const barrel = await import("../src/index.js");
    expect((barrel as Record<string, unknown>).createArtifactStoreInternal).toBeUndefined();
    expect(typeof (barrel as Record<string, unknown>).createArtifactStore).toBe("function");
  });

  it("with no autoRecover option, does not touch a second, independently-created incoming/ temp file", async () => {
    const rootA = join(directory, "store-a");
    const rootB = join(directory, "store-b");

    createArtifactStore({ root: rootA, clock: createFakeClock(), ids: ids() });
    const storeB = createArtifactStore({ root: rootB, clock: createFakeClock(), ids: ids() });

    const orphanPath = join(storeB.incomingDir, "orphan.tmp");
    await writeFile(orphanPath, "leftover bytes");

    // Re-opening storeA (no autoRecover) must never reach into storeB's
    // incoming/ at all — it is a different root entirely — but the more
    // interesting proof is that opening storeB itself again, still with no
    // autoRecover, leaves its own pre-existing orphan untouched.
    createArtifactStore({ root: rootA, clock: createFakeClock(), ids: ids() });
    createArtifactStore({ root: rootB, clock: createFakeClock(), ids: ids() });

    await expect(stat(orphanPath)).resolves.toBeDefined();
    const entries = await readdir(storeB.incomingDir);
    expect(entries).toEqual(["orphan.tmp"]);
  });

  it("with autoRecover, sweeps only incoming/ entries older than minAgeMs (gated, I7)", () => {
    // Uses the fake fs (not the real one): the gate compares the injected
    // Clock against lstat().mtimeMs, and only a fake fs lets a test control
    // both independently of real wall-clock time (invariant 4 — the store
    // itself must never read Date.now, so a real-fs test could not
    // distinguish "old" from "fresh" without waiting in real time).
    const root = join(directory, "store-gated");
    const clock = createFakeClock();
    const fakeFs = createFakeArtifactFileSystem(0);
    const store = createArtifactStoreInternal({ root, clock, ids: ids() }, fakeFs);

    fakeFs.openExclusive(join(store.incomingDir, "old.tmp"));
    fakeFs.setMtime(join(store.incomingDir, "old.tmp"), Date.parse(clock.nowIso()));
    clock.advance(10_000);
    fakeFs.openExclusive(join(store.incomingDir, "fresh.tmp"));
    fakeFs.setMtime(join(store.incomingDir, "fresh.tmp"), Date.parse(clock.nowIso()));

    createArtifactStoreInternal(
      { root, clock, ids: ids(), autoRecover: { minAgeMs: 5_000 } },
      fakeFs,
    );

    expect(fakeFs.fileExists(join(store.incomingDir, "old.tmp"))).toBe(false);
    expect(fakeFs.fileExists(join(store.incomingDir, "fresh.tmp"))).toBe(true);
  });

  it("an unconditional sweep is not reachable from createArtifactStore at all (I7)", () => {
    // The store's only sweep entry point is the gated `autoRecover` option;
    // there is no way to ask createArtifactStore for an unconditional sweep
    // — that mode is reserved for Task 5.1's explicit operator entry point.
    const root = join(directory, "store-no-unconditional");
    const clock = createFakeClock();
    const fakeFs = createFakeArtifactFileSystem(0);
    const store = createArtifactStoreInternal({ root, clock, ids: ids() }, fakeFs);

    fakeFs.openExclusive(join(store.incomingDir, "ancient.tmp"));
    fakeFs.setMtime(join(store.incomingDir, "ancient.tmp"), -1_000_000_000);

    createArtifactStoreInternal({ root, clock, ids: ids() }, fakeFs);

    expect(fakeFs.fileExists(join(store.incomingDir, "ancient.tmp"))).toBe(true);
  });
});
