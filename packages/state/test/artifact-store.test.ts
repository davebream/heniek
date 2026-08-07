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

  it("never sweeps incoming/, no matter how old an entry's mtime is (H1 — autoRecover removed entirely)", () => {
    // `createArtifactStore` used to accept a gated `autoRecover: { minAgeMs }`
    // option; it was removed (H1, post-Phase-3 adversarial review) because
    // its age gate compared the injected Clock against real lstat().mtimeMs
    // — two different time domains — making it either silently inert or, on
    // clock skew, able to unlink a live writer's in-flight temp. There is no
    // longer any option or code path that removes anything from incoming/ —
    // recovery is Phase 5's explicit `recoverArtifacts` only.
    const root = join(directory, "store-never-sweeps");
    const clock = createFakeClock();
    const fakeFs = createFakeArtifactFileSystem(0);
    const store = createArtifactStoreInternal({ root, clock, ids: ids() }, fakeFs);

    fakeFs.openExclusive(join(store.incomingDir, "ancient.tmp"));
    fakeFs.setMtime(join(store.incomingDir, "ancient.tmp"), -1_000_000_000);

    createArtifactStoreInternal({ root, clock, ids: ids() }, fakeFs);

    expect(fakeFs.fileExists(join(store.incomingDir, "ancient.tmp"))).toBe(true);

    // Also asserts the option no longer exists on the type at all: passing
    // an object with an `autoRecover` key would be excess-property-checked
    // away by TypeScript at the call sites above if it were still declared,
    // but the stronger, always-enforced guarantee is behavioural — verified
    // above.
  });

  it("refuses to open a store whose incoming/ container is a symlink, not a real directory (H2)", () => {
    // mkdir tolerates a pre-existing symlink at its target path (it resolves
    // and finds "something" there) — createArtifactStoreInternal must not
    // silently trust that and must lstat the container itself afterward.
    const root = join(directory, "store-symlinked-incoming");
    const fakeFs = createFakeArtifactFileSystem(0);
    fakeFs.plantSymlink(join(root, "incoming"));

    expect(() =>
      createArtifactStoreInternal({ root, clock: createFakeClock(), ids: ids() }, fakeFs),
    ).toThrowError(/not a real directory/);
  });

  it("refuses to open a store whose blobs/sha256 container is a symlink, not a real directory (H2)", () => {
    const root = join(directory, "store-symlinked-blobs");
    const fakeFs = createFakeArtifactFileSystem(0);
    fakeFs.plantSymlink(join(root, "blobs", "sha256"));

    expect(() =>
      createArtifactStoreInternal({ root, clock: createFakeClock(), ids: ids() }, fakeFs),
    ).toThrowError(/not a real directory/);
  });

  it("a real committed blob under blobs/sha256/ survives createArtifactStore being called again (H4)", async () => {
    // The decisive gap the adversarial review flagged: nothing wrote a real
    // blob and reopened the store to prove it survives. Uses the real
    // filesystem (not the fake) end to end, matching what a genuine
    // publish-then-reopen sequence looks like.
    const root = join(directory, "store-real-blob");
    createArtifactStore({ root, clock: createFakeClock(), ids: ids() });

    const blobPath = join(root, "blobs", "sha256", "deadbeef".repeat(8));
    await writeFile(blobPath, "committed content-addressed bytes");

    createArtifactStore({ root, clock: createFakeClock(), ids: ids() });

    await expect(stat(blobPath)).resolves.toBeDefined();
  });
});
