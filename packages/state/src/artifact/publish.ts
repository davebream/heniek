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

export interface ArtifactPublicationReceipt {
  readonly artifactId: ArtifactId;
  /** `blobs/sha256/<hex>` — relative to the store's root. */
  readonly relativePath: string;
  readonly contentHash: string;
  readonly byteLength: number;
  /** The fd the validated bytes were written through (S1) — never a re-open. The caller is responsible for closing it. */
  readonly fd: number;
}

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

/** R4 step 1 (S1): `openExclusive` a fresh randomly-named temp file, bounded retries on name collision. */
function openTempExclusive(
  fs: ArtifactFileSystem,
  incomingDir: string,
): { readonly fd: number; readonly path: string } {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TEMP_NAME_ATTEMPTS; attempt += 1) {
    const path = join(incomingDir, randomTempFileName());
    try {
      return { fd: fs.openExclusive(path), path };
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) {
        throw new ArtifactValidationError(path, "write", { cause: error });
      }
      lastError = error;
    }
  }
  throw new ArtifactValidationError(incomingDir, "write", { cause: lastError });
}

/** R4 step 2. Any error is fatal — the temp file is left for the gated recovery sweep. */
function writeAll(fs: ArtifactFileSystem, fd: number, path: string, bytes: Uint8Array): void {
  try {
    fs.write(fd, bytes);
  } catch (error) {
    throw new ArtifactValidationError(path, "write", { cause: error });
  }
}

/** R4 step 3 (also reused for the post-fchmod re-fsync). Any error is fatal, same disposition as write. */
function fsyncFile(fs: ArtifactFileSystem, fd: number, path: string): void {
  try {
    fs.fsync(fd);
  } catch (error) {
    throw new ArtifactValidationError(path, "fsync", { cause: error });
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
 * report the boundary they actually happened under.
 */
function hashAndValidate(
  fs: ArtifactFileSystem,
  fd: number,
  path: string,
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
    throw new ArtifactValidationError(path, step, { cause: error });
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
  fs.mkdir(quarantineDir);
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
  const { digest: existingDigest } = hashAndValidate(fs, existingFd, finalPath, "link");

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

  const { fd: tempFd, path: tempPath } = openTempExclusive(fs, store.incomingDir);
  // The fd this call will ultimately hand back in the receipt — starts as
  // tempFd, becomes the adopt-path's existing-blob fd once known. Tracked
  // separately from tempFd so the catch block below can close whichever
  // fd(s) it still owns without ever double-closing one it already handed
  // off (adopt) or already closed (non-adopt's own tempFd stays open until
  // the receipt returns).
  let receiptFd = tempFd;
  let tempFdOwned = true;

  try {
    writeAll(fs, tempFd, tempPath, input.bytes);
    fsyncFile(fs, tempFd, tempPath);

    const { digest, byteLength } = hashAndValidate(fs, tempFd, tempPath, "write");

    if (input.expectedContentHash !== undefined && input.expectedContentHash !== digest) {
      throw new ArtifactDigestMismatchError(input.expectedContentHash, digest);
    }

    fs.fchmod(tempFd, IMMUTABLE_BLOB_MODE);

    const relativePath = `blobs/sha256/${digest}`;
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
      fsyncFile(fs, tempFd, tempPath);
    }

    // H2 (post-Phase-3 adversarial review): the directory-fsync open uses
    // openDirectoryReadOnly (O_DIRECTORY added) rather than openReadOnly, so
    // a non-directory occupying blobsDir's path can never be opened as one.
    const blobsDirFd = fs.openDirectoryReadOnly(store.blobsDir);
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
        // Best-effort — the gated recovery sweep cleans up any leftover
        // temp later (R4 step 8).
      }
    }

    return {
      artifactId: ids.next("art") as ArtifactId,
      relativePath,
      contentHash: digest,
      byteLength,
      fd: receiptFd,
    };
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
