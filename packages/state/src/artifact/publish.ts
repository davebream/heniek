/**
 * `publishArtifact` — §16.6 steps 1–3 (plan Task 3.4, R4/D14n / design D3).
 * Publishes content-addressed bytes atomically under `<root>/blobs/sha256/`,
 * via `incoming/<random>.tmp` staging. Uses `link()` — never `rename()` —
 * to move a validated temp file into its immutable final location:
 * `rename` silently clobbers an existing destination, which would mutate an
 * already-committed artifact; `link` fails with `EEXIST` instead, the
 * signal this module's idempotent-adopt logic branches on.
 *
 * Sequence (R4/D14n): openExclusive(O_RDWR|O_CREAT|O_EXCL) → write → fsync
 * → fstat, repeated readAt, fstat (hash + size-stability validation) → fchmod 0o400
 * → link → fsync(fd) again (the mode-bit change from fchmod and the new
 * directory entry from link both need their own durability proof) →
 * fsync(blobsDir) → unlink(temp) only after the directory fsync succeeds.
 * `EEXIST` on link is idempotent adopt (re-hash, `O_NOFOLLOW`); a digest
 * mismatch quarantines the corrupted blob (audit trail, never deleted) and
 * retries once rather than permanently poisoning the address.
 */

import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ArtifactId } from "@heniek/contracts";
import {
  ArtifactDigestMismatchError,
  ArtifactQuarantinedError,
  ArtifactValidationError,
  StageAssertionFailedError,
} from "../errors.js";
import { type ArtifactFileSystem, isErrnoCode } from "./file-system.js";
import { type ArtifactStore, internalArtifactFileSystem, internalArtifactIds } from "./store.js";

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_TEMP_NAME_ATTEMPTS = 3;
const IMMUTABLE_BLOB_MODE = 0o400;
const QUARANTINE_DIR_NAME = "quarantine";

export interface PublishArtifactInput {
  readonly bytes: Uint8Array;
  /** Caller's expected sha256 digest (hex); refused on disagreement against the computed one (design D8). */
  readonly expectedContentHash?: string;
}

/**
 * J3 (Phase 4 fix cycle 2, post-Phase-4 adversarial review) — module-private
 * brand, set only by `publishArtifact`'s own return statement below. Not
 * exported from `src/index.ts`; importable only from within this package
 * (today, only `artifact/complete-stage.ts`), mirroring
 * `internalArtifactFileSystem`'s package-private-by-construction discipline
 * (`store.ts`).
 *
 * `ArtifactPublicationReceipt` is an unbranded structural interface, and
 * `completeStage`'s S2 assertion never re-hashes on the adopt path (Q1 above
 * skips it deliberately — the adopt fd never held write access). Before this
 * brand, a caller could hand-build an object satisfying the interface's
 * declared shape, stage a same-length file at the right content address via
 * `node:fs` directly, and pass every S2 check (isDirectory/nlink/size/ino/
 * dev) without ever having gone through `publishArtifact`.
 * `test/artifact-publish.test.ts` demonstrates exactly this forgery working
 * before this fix.
 *
 * **Honest scope — read this before treating the brand as more than it is.**
 * This closes the *API-surface* hole: a branded receipt can only originate
 * from a call to `publishArtifact` on this same store, which hashed the
 * bytes through the pinned fd it hands back, and `completeStage`'s S2 `ino`/
 * `dev` check pins that receipt to the specific inode `publishArtifact`
 * validated. It does **not** provide integrity against in-process code —
 * anything running in this process can still `import("node:fs")` and write
 * directly into `<store.root>/blobs/sha256/<hex>`, bypassing this package
 * entirely; no brand, no fd pin, and no S2 check can detect that (that
 * residual gap is what `listArtifacts`'s `verified` re-hash, Task 5.2,
 * exists to catch *after the fact*, not prevent). Do not describe this brand
 * as an integrity guarantee — it is a construction-provenance guarantee
 * about this package's own public API, nothing broader.
 */
const PUBLICATION_RECEIPT_BRAND: unique symbol = Symbol("ArtifactPublicationReceipt.brand");

interface BrandedArtifactPublicationReceipt extends ArtifactPublicationReceipt {
  readonly [PUBLICATION_RECEIPT_BRAND]: true;
}

/**
 * J3 — runtime half of the brand check (the compile-time half is that
 * `PUBLICATION_RECEIPT_BRAND` is never exported from `src/index.ts`, so no
 * external caller can *name* the symbol to satisfy it). A same-package
 * caller — or any caller willing to bypass the type system with `as` — could
 * still construct a same-shaped object at runtime; this is what actually
 * refuses it at `completeStage`'s boundary regardless of how the object was
 * built. Never exported from `src/index.ts`.
 */
export function assertReceiptIsBranded(receipt: ArtifactPublicationReceipt): void {
  if ((receipt as Partial<BrandedArtifactPublicationReceipt>)[PUBLICATION_RECEIPT_BRAND] !== true) {
    throw new StageAssertionFailedError(
      receipt.relativePath,
      "receipt did not originate from publishArtifact (missing publication brand) — completeStage " +
        "refuses a hand-built ArtifactPublicationReceipt even when every field matches a genuinely " +
        "staged blob",
    );
  }
}

/**
 * Q5 (Phase 4 fix cycle 1, post-Phase-4 adversarial review) — documentation
 * accuracy, not a defect. A receipt is **content-only**: it attests that
 * `bytes` hashing to `contentHash` were durably published at `relativePath`,
 * and nothing more. It carries no `runId`/`stageId` and is never checked
 * against either — AC-1's guarantee is byte-exactness of the referenced
 * content, not an attestation about which run or stage produced it. Folding
 * one run's receipt into a different run/stage's `completeStage` call is
 * therefore accepted, not refused: this is inherent to content addressing
 * (two identical byte sequences share one address regardless of who
 * produced them) and is exactly what AC-2's dedup/adopt behaviour depends
 * on. Do not read `fd`'s pinning (below) as identity/ownership proof — it
 * proves only that the bytes at `relativePath` have not changed since this
 * receipt was minted.
 */
export interface ArtifactPublicationReceipt {
  readonly artifactId: ArtifactId;
  /** `blobs/sha256/<hex>` — relative to the store's root. */
  readonly relativePath: string;
  readonly contentHash: string;
  readonly byteLength: number;
  /**
   * On the normal-publish path (`adopted === false`): the same `O_RDWR` fd
   * the validated bytes were written through (S1) — never a re-open. On the
   * EEXIST/idempotent-adopt path (`adopted === true`): an `O_RDONLY`
   * re-open of the already-committed blob (P1, post-Phase-3 adversarial
   * review, fix cycle 1) — S1's re-open ban applies only to the writer's
   * own bytes, and the adopt path never wrote any; the fd it hands back was
   * opened purely to re-verify the existing blob's digest, through that
   * same fd, before adoption. A caller that needs a writable fd must branch
   * on `adopted` and treat an adopted fd as read-only. Either way the
   * caller is responsible for closing it.
   */
  readonly fd: number;
  /** `true` when `link`'s `EEXIST` resolved via idempotent adopt of an already-committed blob rather than this call's own write (P1). See `fd`'s docs for what that means for the fd's mode. */
  readonly adopted: boolean;
}

const INCOMING_DIR_LABEL = "incoming";

function randomTempFileName(): string {
  return `${randomBytes(16).toString("hex")}.tmp`;
}

function closeQuietly(fs: ArtifactFileSystem, fd: number): void {
  try {
    fs.close(fd);
  } catch {
    // Best-effort — the fd may already be invalid on a failure path.
  }
}

/**
 * R4 step 1 (S1): `openExclusive` a fresh randomly-named temp file, bounded
 * retries on name collision. Returns both the absolute `path` (for further
 * `fs` calls) and a store-root-relative `relativePath` (P3, post-Phase-3
 * adversarial review, fix cycle 1) — every `ArtifactValidationError` this
 * module raises must name a value relative to the store's root, never the
 * absolute path `errors.ts`'s house rule forbids echoing an ambient/derived
 * root in.
 */
function openTempExclusive(
  fs: ArtifactFileSystem,
  incomingDir: string,
): { readonly fd: number; readonly path: string; readonly relativePath: string } {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TEMP_NAME_ATTEMPTS; attempt += 1) {
    const name = randomTempFileName();
    const path = join(incomingDir, name);
    const relativePath = join(INCOMING_DIR_LABEL, name);
    try {
      return { fd: fs.openExclusive(path), path, relativePath };
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) {
        throw new ArtifactValidationError(relativePath, "write", { cause: error });
      }
      lastError = error;
    }
  }
  throw new ArtifactValidationError(INCOMING_DIR_LABEL, "write", { cause: lastError });
}

/** R4 step 2. Any error is fatal — the temp file is left in `incoming/` for Phase 5's explicit `recoverArtifacts` operator entry point to remove later (no automatic sweep runs on open, per `store.ts`'s H1 fix). `relativePath` (P3) is store-root-relative, used only for the error message — the syscall itself operates on `fd`. */
function writeAll(
  fs: ArtifactFileSystem,
  fd: number,
  relativePath: string,
  bytes: Uint8Array,
): void {
  try {
    fs.write(fd, bytes);
  } catch (error) {
    throw new ArtifactValidationError(relativePath, "write", { cause: error });
  }
}

/** R4 step 3 (also reused for the post-fchmod re-fsync). Any error is fatal, same disposition as write. `relativePath` (P3) is store-root-relative. */
function fsyncFile(fs: ArtifactFileSystem, fd: number, relativePath: string): void {
  try {
    fs.fsync(fd);
  } catch (error) {
    throw new ArtifactValidationError(relativePath, "fsync", { cause: error });
  }
}

/**
 * R4 step 4: `fstat`, repeated positional `readAt` from position 0, then
 * `fstat` again to confirm size did not change under the hash. Any error
 * here is fatal; grouped under step `"write"` since it validates what the
 * write step produced (R4/R6 name only four durability boundaries — write,
 * fsync, link, dirfsync — and this pure validation sits between the first
 * two, with no fault-injection boundary of its own). `step` lets the two
 * call sites — the initial temp-file validation ("write") and the adopt
 * path's re-hash of the existing blob during EEXIST resolution ("link") —
 * report the boundary they actually happened under. `relativePath` (P3) is
 * store-root-relative — the caller passes the temp's or the blob's
 * relative form, never an absolute path.
 */
function hashAndValidate(
  fs: ArtifactFileSystem,
  fd: number,
  relativePath: string,
  step: "write" | "link",
): { readonly digest: string; readonly byteLength: number } {
  try {
    const before = fs.fstat(fd);
    const hash = createHash("sha256");
    const buffer = new Uint8Array(READ_CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const bytesRead = fs.readAt(fd, buffer, position);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fs.fstat(fd);
    if (after.size !== before.size) {
      throw new Error(`size changed under the hash: ${before.size} -> ${after.size}`);
    }
    return { digest: hash.digest("hex"), byteLength: position };
  } catch (error) {
    if (error instanceof ArtifactValidationError) {
      throw error;
    }
    throw new ArtifactValidationError(relativePath, step, { cause: error });
  }
}

interface LinkOutcome {
  readonly fd: number;
  readonly adopted: boolean;
}

/**
 * R4 step 6, EEXIST-and-mismatch branch: quarantine the corrupted blob
 * (audit trail, never deleted) and retry once. `existingDigest` is the
 * mismatched digest the caller already computed while re-hashing the
 * existing blob for the adopt check — recomputing it here would require
 * re-opening and re-reading the (about-to-be-unlinked) corrupted blob for
 * no benefit.
 */
function quarantineAndRetry(
  fs: ArtifactFileSystem,
  store: ArtifactStore,
  tempFd: number,
  tempPath: string,
  finalPath: string,
  relativePath: string,
  existingDigest: string,
): LinkOutcome {
  const quarantineDir = join(store.root, QUARANTINE_DIR_NAME);
  try {
    fs.mkdir(quarantineDir);
  } catch (error) {
    // P4 (post-Phase-3 adversarial review, fix cycle 1): previously
    // unwrapped — a raw errno would have escaped past this module's typed
    // error boundary.
    throw new ArtifactValidationError(relativePath, "link", { cause: error });
  }
  const quarantinePath = join(quarantineDir, `${existingDigest}-${randomBytes(8).toString("hex")}`);
  try {
    fs.link(finalPath, quarantinePath);
  } catch (error) {
    throw new ArtifactValidationError(relativePath, "link", { cause: error });
  }
  try {
    fs.unlink(finalPath);
  } catch (error) {
    throw new ArtifactValidationError(relativePath, "link", { cause: error });
  }
  try {
    fs.link(tempPath, finalPath);
  } catch (error) {
    if (isErrnoCode(error, "EEXIST")) {
      throw new ArtifactQuarantinedError(relativePath);
    }
    throw new ArtifactValidationError(relativePath, "link", { cause: error });
  }
  return { fd: tempFd, adopted: false };
}

/** R4 step 6: attempt the direct link; EEXIST resolves via idempotent adopt or quarantine-and-retry. */
function linkIntoBlobs(
  fs: ArtifactFileSystem,
  store: ArtifactStore,
  tempFd: number,
  tempPath: string,
  digest: string,
  relativePath: string,
): LinkOutcome {
  const finalPath = join(store.root, relativePath);
  try {
    fs.link(tempPath, finalPath);
    return { fd: tempFd, adopted: false };
  } catch (error) {
    if (!isErrnoCode(error, "EEXIST")) {
      throw new ArtifactValidationError(relativePath, "link", { cause: error });
    }
  }

  // Idempotent adopt: re-open the existing blob (O_NOFOLLOW) and re-hash it.
  let existingFd: number;
  try {
    existingFd = fs.openReadOnly(finalPath);
  } catch (error) {
    throw new ArtifactValidationError(relativePath, "link", { cause: error });
  }
  // P2 (post-Phase-3 adversarial review, fix cycle 1): hashAndValidate can
  // throw (fstat/readAt failure, or a size-changed-under-the-hash check).
  // existingFd must be closed on every one of those paths — previously it
  // leaked, because the outer publishArtifact catch only knows about
  // tempFd/receiptFd, never this function-local fd.
  let existingDigest: string;
  try {
    ({ digest: existingDigest } = hashAndValidate(fs, existingFd, relativePath, "link"));
  } catch (error) {
    closeQuietly(fs, existingFd);
    throw error;
  }

  if (existingDigest === digest) {
    // Match: the existing blob is already correct and durable. Adopt it —
    // never overwrite. The caller's own temp fd is no longer needed.
    return { fd: existingFd, adopted: true };
  }

  // Mismatch: the committed blob does not hash to its own address —
  // corruption, not a race. Quarantine, never poison.
  closeQuietly(fs, existingFd);
  return quarantineAndRetry(fs, store, tempFd, tempPath, finalPath, relativePath, existingDigest);
}

/** Publishes `input.bytes` as an immutable, content-addressed artifact. See this module's docblock for the full sequence. */
export function publishArtifact(
  store: ArtifactStore,
  input: PublishArtifactInput,
): ArtifactPublicationReceipt {
  const fs = internalArtifactFileSystem(store);
  const ids = internalArtifactIds(store);

  const {
    fd: tempFd,
    path: tempPath,
    relativePath: tempRelativePath,
  } = openTempExclusive(fs, store.incomingDir);
  // The fd this call will ultimately hand back in the receipt — starts as
  // tempFd, becomes the adopt-path's existing-blob fd once known. Tracked
  // separately from tempFd so the catch block below can close whichever
  // fd(s) it still owns without ever double-closing one it already handed
  // off (adopt) or already closed (non-adopt's own tempFd stays open until
  // the receipt returns).
  let receiptFd = tempFd;
  let tempFdOwned = true;

  try {
    writeAll(fs, tempFd, tempRelativePath, input.bytes);
    fsyncFile(fs, tempFd, tempRelativePath);

    const { digest, byteLength } = hashAndValidate(fs, tempFd, tempRelativePath, "write");

    if (input.expectedContentHash !== undefined && input.expectedContentHash !== digest) {
      throw new ArtifactDigestMismatchError(input.expectedContentHash, digest);
    }

    const relativePath = `blobs/sha256/${digest}`;

    try {
      fs.fchmod(tempFd, IMMUTABLE_BLOB_MODE);
    } catch (error) {
      // P4 (post-Phase-3 adversarial review, fix cycle 1): previously
      // unwrapped — a raw errno would have escaped past this module's typed
      // error boundary. Grouped under "write" (same disposition as
      // hashAndValidate's own validation of the temp file): it operates on
      // the still-in-incoming temp, before any link has been attempted.
      throw new ArtifactValidationError(tempRelativePath, "write", { cause: error });
    }

    const linkOutcome = linkIntoBlobs(fs, store, tempFd, tempPath, digest, relativePath);
    receiptFd = linkOutcome.fd;

    if (linkOutcome.adopted) {
      // tempFd's own content was never linked anywhere — it is no longer
      // needed once the existing blob has been adopted.
      closeQuietly(fs, tempFd);
      tempFdOwned = false;
    } else {
      // Only the direct/quarantine-retry success path re-links tempFd's own
      // content — re-fsync it now that fchmod's mode change and link's new
      // directory entry both need their own durability proof, per this
      // module's docblock.
      fsyncFile(fs, tempFd, tempRelativePath);
    }

    // H2 (post-Phase-3 adversarial review): the directory-fsync open uses
    // openDirectoryReadOnly (O_DIRECTORY added) rather than openReadOnly, so
    // a non-directory occupying blobsDir's path can never be opened as one.
    let blobsDirFd: number;
    try {
      blobsDirFd = fs.openDirectoryReadOnly(store.blobsDir);
    } catch (error) {
      // P4 (post-Phase-3 adversarial review, fix cycle 1): previously
      // unwrapped — a raw errno would have escaped past this module's typed
      // error boundary.
      throw new ArtifactValidationError(relativePath, "dirfsync", { cause: error });
    }
    try {
      fs.fsync(blobsDirFd);
    } catch (error) {
      throw new ArtifactValidationError(relativePath, "dirfsync", { cause: error });
    } finally {
      closeQuietly(fs, blobsDirFd);
    }

    try {
      fs.unlink(tempPath);
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) {
        // Best-effort — Phase 5's explicit recoverArtifacts operator entry
        // point cleans up any leftover temp later (R4 step 8); no automatic
        // sweep runs here or on store open.
      }
    }

    const receipt: BrandedArtifactPublicationReceipt = {
      artifactId: ids.next("art") as ArtifactId,
      relativePath,
      contentHash: digest,
      byteLength,
      fd: receiptFd,
      adopted: linkOutcome.adopted,
      [PUBLICATION_RECEIPT_BRAND]: true,
    };
    return receipt;
  } catch (error) {
    if (tempFdOwned) {
      closeQuietly(fs, tempFd);
    }
    if (receiptFd !== tempFd) {
      closeQuietly(fs, receiptFd);
    }
    throw error;
  }
}
