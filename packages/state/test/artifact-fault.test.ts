/**
 * Task 3.5 — fault injection at each of `publishArtifact`'s four durability
 * boundaries (write, fsync, link, dirfsync), immediately before and
 * immediately after each — eight injection points total (plan Phase 3,
 * R4/D14n). For every point: the call throws, no partial or schema-invalid
 * artifact is ever referenceable, and a retry with the same bytes succeeds.
 *
 * Occurrence numbering for the underlying fake fs's `fsync` method: for a
 * single non-adopt `publishArtifact` call, `fsync` is invoked three times —
 * (1) immediately after `write` (R4 step 3), (2) again after `fchmod`/`link`
 * (this module's own extra durability step), (3) on the blobs directory fd
 * (R4 step 7, "dirfsync"). Occurrence 1 is the "fsync" boundary under test
 * here; occurrence 3 is "dirfsync".
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publishArtifact } from "../src/artifact/publish.js";
import { createArtifactStoreInternal } from "../src/artifact/store.js";
import { ArtifactValidationError } from "../src/errors.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { createFakeArtifactFileSystem } from "./helpers/fake-artifact-file-system.js";

const DIRFSYNC_OCCURRENCE = 3;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeStore(root = "/store") {
  const fakeFs = createFakeArtifactFileSystem(1_000);
  const store = createArtifactStoreInternal(
    { root, clock: createFakeClock(), ids: createDeterministicIds(1) },
    fakeFs,
  );
  return { store, fakeFs };
}

const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });

describe("artifact-fault injection at each durability boundary (Task 3.5, R4/D14n)", () => {
  const bytes = new TextEncoder().encode("fault-injected content");
  const expectedHash = sha256Hex(bytes);
  const finalPath = `/store/blobs/sha256/${expectedHash}`;

  function expectSuccessfulRetry(store: ReturnType<typeof makeStore>["store"]) {
    const receipt = publishArtifact(store, { bytes });
    expect(receipt.contentHash).toBe(expectedHash);
    expect(receipt.byteLength).toBe(bytes.length);
    return receipt;
  }

  it("write — before: throws, no blob referenceable, retry succeeds", () => {
    const { store, fakeFs } = makeStore();
    fakeFs.armFaultBefore("write", eio());

    expect(() => publishArtifact(store, { bytes })).toThrowError(ArtifactValidationError);
    expect(fakeFs.fileExists(finalPath)).toBe(false);

    const receipt = expectSuccessfulRetry(store);
    fakeFs.close(receipt.fd);
  });

  it("write — after: throws, no blob referenceable, retry succeeds", () => {
    const { store, fakeFs } = makeStore();
    fakeFs.armFaultAfter("write", eio());

    expect(() => publishArtifact(store, { bytes })).toThrowError(ArtifactValidationError);
    expect(fakeFs.fileExists(finalPath)).toBe(false);

    const receipt = expectSuccessfulRetry(store);
    fakeFs.close(receipt.fd);
  });

  it("fsync (post-write) — before: throws, no blob referenceable, retry succeeds", () => {
    const { store, fakeFs } = makeStore();
    fakeFs.armFaultAtOccurrence("fsync", 1, "before", eio());

    expect(() => publishArtifact(store, { bytes })).toThrowError(ArtifactValidationError);
    expect(fakeFs.fileExists(finalPath)).toBe(false);

    const receipt = expectSuccessfulRetry(store);
    fakeFs.close(receipt.fd);
  });

  it("fsync (post-write) — after: throws, no blob referenceable, retry succeeds", () => {
    const { store, fakeFs } = makeStore();
    fakeFs.armFaultAtOccurrence("fsync", 1, "after", eio());

    expect(() => publishArtifact(store, { bytes })).toThrowError(ArtifactValidationError);
    expect(fakeFs.fileExists(finalPath)).toBe(false);

    const receipt = expectSuccessfulRetry(store);
    fakeFs.close(receipt.fd);
  });

  it("link — before: throws, no blob referenceable, retry succeeds", () => {
    const { store, fakeFs } = makeStore();
    fakeFs.armFaultBefore("link", eio());

    expect(() => publishArtifact(store, { bytes })).toThrowError(ArtifactValidationError);
    expect(fakeFs.fileExists(finalPath)).toBe(false);

    const receipt = expectSuccessfulRetry(store);
    fakeFs.close(receipt.fd);
  });

  it("link — after: throws; the blob already exists (link committed) but is self-consistent, never schema-invalid; retry succeeds via idempotent adopt", () => {
    const { store, fakeFs } = makeStore();
    fakeFs.armFaultAfter("link", eio());

    expect(() => publishArtifact(store, { bytes })).toThrowError(ArtifactValidationError);
    // The link syscall itself already committed before our injected fault
    // fired — this is the D3/D14n-documented reality that link()'s
    // side effect and this module's own post-link bookkeeping are two
    // separate steps. The blob is present, but it is never "partial" or
    // "schema-invalid": its bytes still hash to the address they live at.
    expect(fakeFs.fileExists(finalPath)).toBe(true);
    expect(sha256Hex(fakeFs.readFile(finalPath))).toBe(expectedHash);

    const receipt = expectSuccessfulRetry(store);
    fakeFs.close(receipt.fd);
  });

  it("dirfsync — before: throws; the already-linked blob is self-consistent; retry succeeds via idempotent adopt", () => {
    const { store, fakeFs } = makeStore();
    fakeFs.armFaultAtOccurrence("fsync", DIRFSYNC_OCCURRENCE, "before", eio());

    expect(() => publishArtifact(store, { bytes })).toThrowError(ArtifactValidationError);
    expect(fakeFs.fileExists(finalPath)).toBe(true);
    expect(sha256Hex(fakeFs.readFile(finalPath))).toBe(expectedHash);

    const receipt = expectSuccessfulRetry(store);
    fakeFs.close(receipt.fd);
  });

  it("dirfsync — after: throws; the already-linked blob is self-consistent; retry succeeds via idempotent adopt", () => {
    const { store, fakeFs } = makeStore();
    fakeFs.armFaultAtOccurrence("fsync", DIRFSYNC_OCCURRENCE, "after", eio());

    expect(() => publishArtifact(store, { bytes })).toThrowError(ArtifactValidationError);
    expect(fakeFs.fileExists(finalPath)).toBe(true);
    expect(sha256Hex(fakeFs.readFile(finalPath))).toBe(expectedHash);

    const receipt = expectSuccessfulRetry(store);
    fakeFs.close(receipt.fd);
  });

  it("the incoming/ temp is never removed by any of the eight injected failures (only the success path unlinks it)", () => {
    // A representative sample (write-before, link-after, dirfsync-after) —
    // every failure path leaves its temp in incoming/ for the gated
    // recovery sweep, never unlinking it itself (R4 step 8's ordering).
    for (const arm of [
      (fakeFs: ReturnType<typeof createFakeArtifactFileSystem>) =>
        fakeFs.armFaultBefore("write", eio()),
      (fakeFs: ReturnType<typeof createFakeArtifactFileSystem>) =>
        fakeFs.armFaultAfter("link", eio()),
      (fakeFs: ReturnType<typeof createFakeArtifactFileSystem>) =>
        fakeFs.armFaultAtOccurrence("fsync", DIRFSYNC_OCCURRENCE, "after", eio()),
    ]) {
      const { store, fakeFs } = makeStore();
      arm(fakeFs);
      expect(() => publishArtifact(store, { bytes })).toThrowError(ArtifactValidationError);
      expect(fakeFs.readdir(store.incomingDir)).toHaveLength(1);
    }
  });
});
