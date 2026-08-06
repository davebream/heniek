/**
 * `completeStage` — §16.6 steps 4–6, executed as **one** SQLite transaction
 * (plan Task 4.4; design D4). Step 4 (append the stage-result event) and
 * step 5 (update the projection: an `artifact` row per published ref plus
 * the `stage_artifact_alias` row that re-points that name) run through
 * `commitStateChangeInternal`. Step 6 — release dependants — is **derived,
 * never performed** (design D7): there is no stage lifecycle to release
 * into yet, so this module ships no dispatch/release call at all. See
 * `test/complete-stage-derived.test.ts` for the assertion that no such call
 * is exported from this module or the package barrel.
 *
 * This is the only production caller of `commitStateChangeInternal` — every
 * other caller reaches this package through the plain `commitStateChange`,
 * which cannot write `artifact`/`stage_artifact_alias` at all (AC-1,
 * `command/commit.ts`'s `assertGuardedWritesAreVerified`).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type CommitReport,
  commitStateChangeInternal,
  type StageArtifactAssertion,
} from "../command/commit.js";
import type { StateDatabase } from "../database/open.js";
import { StageAssertionFailedError } from "../errors.js";
import type { CausationEventId } from "../journal/event.js";
import type { JsonValue } from "../json.js";
import type { ArtifactFileSystem } from "./file-system.js";
import { type ArtifactPublicationReceipt, assertReceiptIsBranded } from "./publish.js";
import { type ArtifactStore, internalArtifactFileSystem } from "./store.js";

/**
 * One published artifact `completeStage` will fold into the `stage.completed`
 * payload and alias. `receipt` is `publishArtifact`'s own output.
 *
 * J7 (Phase 4 fix cycle 2, post-Phase-4 adversarial review) — corrected: on
 * the normal-publish path (`receipt.adopted === false`) `receipt.fd` is the
 * same `O_RDWR` fd the validated bytes were written through (S1). On the
 * idempotent-adopt path (`receipt.adopted === true`, an `EEXIST` on `link`
 * resolved by re-hashing the already-committed blob) the fd is instead a
 * fresh `O_RDONLY` re-open of that existing blob — **not** the fd the bytes
 * were originally written through, since this call never wrote any (see
 * `publish.ts`'s own `ArtifactPublicationReceipt.fd` docs for the full
 * adopt-path rationale). Either way `completeStage` takes ownership of the
 * fd and closes it (see this module's docblock and the `finally` in
 * `completeStage` below).
 */
export interface CompleteStageArtifactInput {
  readonly receipt: ArtifactPublicationReceipt;
  readonly name: string;
  readonly mediaType: string;
  readonly contentSchemaId: string;
  readonly producer: string;
  readonly sourceLineage: readonly string[];
}

export interface CompleteStageInput {
  readonly runId: string;
  readonly stageId: string;
  /** May be empty — a stage that legitimately produces no outputs must be able to complete (F8). */
  readonly artifacts: readonly CompleteStageArtifactInput[];
  /** Q012: atomically terminalize the owning run with artifact activation. */
  readonly terminalRunStatus?: "succeeded";
  /** Absent ⇒ this event roots a new causal chain and mints a correlation id. */
  readonly causationEventId?: CausationEventId;
}

function closeQuietly(fs: ArtifactFileSystem, fd: number): void {
  try {
    fs.close(fd);
  } catch {
    // Best-effort, mirroring `publish.ts`'s identical helper: the fd may
    // already be invalid on a failure path, and there is nothing further to
    // do about a close failure here.
  }
}

/**
 * J1 (Phase 4 fix cycle, post-Phase-4 adversarial review): `fs.fstat` and
 * `fs.lstat` are Node `node:fs` port calls, same as every call
 * `artifact/publish.ts` makes — and, exactly like that module, a raw
 * `ErrnoException` from either must never escape this package's typed error
 * boundary. Reachable without any exotic setup: a crashed publisher leaves
 * `incoming/` residue so the pinned fd's `nlink === 1` (the `>= 1`
 * relaxation below deliberately admits this), while the separate
 * `blobs/sha256/<hash>` name the receipt's `relativePath` points at has
 * itself been removed — `fstat(fd)` succeeds (the fd's inode is still alive
 * through the `incoming/` link) but `lstat(finalPath)` throws a raw ENOENT.
 * Likewise a receipt whose fd was already closed (e.g. reused across two
 * `completeStage` calls) makes `fstat(fd)` throw a raw EBADF. Both are
 * wrapped here into `StageAssertionFailedError` with `{ cause }`, mirroring
 * `publish.ts`'s discipline for every port call it makes.
 */
function safeFstat(
  fs: ArtifactFileSystem,
  relativePath: string,
  fd: number,
): ReturnType<ArtifactFileSystem["fstat"]> {
  try {
    return fs.fstat(fd);
  } catch (error) {
    throw new StageAssertionFailedError(relativePath, "fstat failed on the pinned receipt fd", {
      cause: error,
    });
  }
}

function safeLstat(
  fs: ArtifactFileSystem,
  relativePath: string,
  path: string,
): ReturnType<ArtifactFileSystem["lstat"]> {
  try {
    return fs.lstat(path);
  } catch (error) {
    throw new StageAssertionFailedError(relativePath, "lstat failed for the blob path", {
      cause: error,
    });
  }
}

const REHASH_CHUNK_BYTES = 64 * 1024;

/**
 * Q1 (Phase 4 fix cycle 1, post-Phase-4 adversarial review). Re-reads every
 * byte through the pinned fd only (positional `readAt`, S1's own reads —
 * never a re-open) and recomputes its sha256. Exists solely so
 * `assertArtifactStillValid` can compare against `receipt.contentHash`
 * under the write lock: `fchmod(0o400)` (`publish.ts`) does not revoke
 * write access through an fd that was already open in `O_RDWR` mode before
 * the chmod ran, so on the non-adopt path (see call site) same-length bytes
 * could otherwise be swapped into the blob between `publishArtifact` and
 * `completeStage` without tripping isDirectory/nlink/size/ino/dev.
 */
function reHashPinnedFd(fs: ArtifactFileSystem, fd: number): string {
  const hash = createHash("sha256");
  const buffer = new Uint8Array(REHASH_CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const bytesRead = fs.readAt(fd, buffer, position);
    if (bytesRead === 0) {
      break;
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

/**
 * S2 — the under-lock assertion. Re-verifies that `artifact.receipt` still
 * names the exact bytes `publishArtifact` validated, using only the
 * receipt's own **pinned** fd (S1 — never a re-open) plus one `lstat` of the
 * blob path.
 *
 * - `fstat(fd)` must report a regular file (never a directory).
 * - `nlink >= 1`, **never `=== 1`** — a crashed publisher's `incoming/`
 *   residue is legitimately a second hard link to a committed blob
 *   (`nlink === 2`); `=== 1` would put AC-1 in direct conflict with AC-3.
 *   Only a full unlink (`nlink === 0`) is refused.
 * - `size` must equal the byte length `publishArtifact` measured.
 * - `lstat` of `<store.root>/<relativePath>` must resolve to the **same**
 *   `ino`/`dev` as the pinned fd — the name→inode binding that proves the
 *   blob path still names the exact file the fd was validated against, not
 *   merely a same-sized file at that address.
 * - **Q1 (Phase 4 fix cycle 1, post-Phase-4 adversarial review).** On the
 *   non-adopt path (`receipt.adopted === false`) the pinned fd is the
 *   writer's own `O_RDWR` descriptor from `publishArtifact`'s S1 step.
 *   `fchmod(0o400)` (`publish.ts`) does not revoke access through an
 *   already-open fd — any code holding the receipt could write same-length
 *   bytes into the blob between `publishArtifact` and `completeStage`, and
 *   none of the four checks above would notice (isDirectory/nlink/size/
 *   ino/dev are all still satisfied by an in-place same-length overwrite).
 *   So on this path only, re-hash every byte through the pinned fd
 *   (`reHashPinnedFd`, S1's own `readAt` — never a re-open) and compare
 *   against `receipt.contentHash`, making AC-1's "exact bytes" claim
 *   enforced rather than merely asserted. Skipped on the adopt path
 *   (`receipt.adopted === true`): that fd is a fresh `O_RDONLY` re-open
 *   (`linkIntoBlobs`'s `openReadOnly`) that never held write access, so the
 *   window this closes cannot exist there — re-hashing it too would be
 *   strictly wasted I/O against a threat that path was never exposed to.
 *
 * **J2 (Phase 4 fix cycle, post-Phase-4 adversarial review) — residual
 * TOCTOU window, documented not neutralised.** The pinned fd does NOT close
 * this window. SQLite's `BEGIN IMMEDIATE` write lock protects the
 * *database*, never the filesystem — nothing here or in `command/commit.ts`
 * takes any filesystem-level lock. `@heniek/daemon`'s `acquire.ts` closes
 * the legitimate-writer case — it is what stops a *second daemon* from
 * ever running against the same store — but it does not and cannot close
 * this window: a hostile or buggy process with filesystem access to the
 * store root is by definition not going through the daemon's claim at all,
 * so the daemon's single-instance enforcement has nothing to arbitrate
 * against it. Between this assertion returning and `COMMIT`, and again
 * between `COMMIT` and `completeStage`'s own `finally` closing the fd, such
 * a process can still `unlink` the blob out from under the just-committed
 * row: the pinned fd keeps the *inode's bytes* alive for as long as this
 * process holds it open, but it does not, and cannot, keep the *directory
 * entry* (the name a later reader resolves) alive. Once the fd is closed
 * the inode itself can be freed too, so the committed row can end up naming
 * a path with nothing there. No design in this module beats a hostile
 * unlinker; this is the residual gap
 * `packages/state/test/artifact-inventory.test.ts` (Task 5.2) exists to
 * detect after the fact, not to prevent.
 */
function assertArtifactStillValid(
  fs: ArtifactFileSystem,
  store: ArtifactStore,
  artifact: CompleteStageArtifactInput,
): void {
  const { relativePath, byteLength, fd, contentHash, adopted } = artifact.receipt;
  const fdStat = safeFstat(fs, relativePath, fd);
  if (fdStat.isDirectory) {
    throw new StageAssertionFailedError(
      relativePath,
      "the pinned fd no longer names a regular file",
    );
  }
  if (fdStat.nlink < 1) {
    throw new StageAssertionFailedError(relativePath, `nlink was ${fdStat.nlink}, expected >= 1`);
  }
  if (fdStat.size !== byteLength) {
    throw new StageAssertionFailedError(
      relativePath,
      `size ${fdStat.size} does not match the published byteLength ${byteLength}`,
    );
  }
  const pathStat = safeLstat(fs, relativePath, join(store.root, relativePath));
  if (pathStat.ino !== fdStat.ino || pathStat.dev !== fdStat.dev) {
    throw new StageAssertionFailedError(
      relativePath,
      "the blob path no longer names the inode the validated bytes were written to",
    );
  }
  // Q1: see this function's docblock — only the non-adopt path's fd was
  // ever writable, so only that path needs the re-hash.
  if (!adopted) {
    const recomputed = reHashPinnedFd(fs, fd);
    if (recomputed !== contentHash) {
      throw new StageAssertionFailedError(
        relativePath,
        `content_hash ${contentHash} no longer matches the pinned fd's bytes (recomputed ${recomputed})`,
      );
    }
  }
}

/**
 * §16.6 steps 4–6 as one transaction. Appends the `stage.completed` event,
 * writes an `artifact` row per ref (or idempotently adopts an already
 * -identical one, F2) plus the active `stage_artifact_alias` row, and
 * re-verifies every referenced artifact under the write lock (S2) before
 * `COMMIT`.
 *
 * `db` and `store` must share the same root — this function does not verify
 * that itself (it has no way to), but a receipt from a different store's
 * `publishArtifact` call would fail the S2 `lstat` check as soon as the
 * paths diverge.
 *
 * **FD ownership.** `completeStage` owns every `artifact.receipt.fd` it was
 * handed and closes each one in a `finally`, regardless of success or
 * failure — `commit.ts`'s own catch block has no `finally`, so leaving
 * these fds to it would leak one per artifact on every failure path.
 *
 * **J4 (Phase 4 fix cycle, post-Phase-4 adversarial review).** The `finally`
 * guards the *entire* function body — including resolving `store`'s
 * filesystem port and building the assertions/payload — not just the
 * `commitStateChangeInternal` call. A throw during that construction (e.g. a
 * malformed `artifact.receipt` whose fields throw on access) previously
 * happened **before** the old `try` block began, so it skipped the `finally`
 * entirely and leaked every receipt fd. The `finally` below re-resolves the
 * filesystem port independently of whatever ran inside `try` — if that
 * itself fails (an invalid `store` handle), there is no port left to close
 * the fds through and this function gives up on closing them, exactly as
 * unrecoverable as the same failure would have been before this fix.
 */
export function completeStage(
  db: StateDatabase,
  store: ArtifactStore,
  input: CompleteStageInput,
): CommitReport {
  try {
    // J3 (Phase 4 fix cycle 2, post-Phase-4 adversarial review): refuse any
    // receipt that did not originate from `publishArtifact` on this store,
    // before doing anything else — see `publish.ts`'s docblock on
    // `PUBLICATION_RECEIPT_BRAND` for exactly what this does and does not
    // prove.
    for (const artifact of input.artifacts) {
      assertReceiptIsBranded(artifact.receipt);
    }

    const fs = internalArtifactFileSystem(store);

    const assertions: StageArtifactAssertion[] = input.artifacts.map((artifact) => ({
      relativePath: artifact.receipt.relativePath,
      assert: () => assertArtifactStillValid(fs, store, artifact),
    }));
    const artifactRelativePaths = input.artifacts.map((artifact) => artifact.receipt.relativePath);

    const payload: JsonValue = {
      runId: input.runId,
      stageId: input.stageId,
      ...(input.terminalRunStatus === undefined
        ? {}
        : { terminalRunStatus: input.terminalRunStatus }),
      artifacts: input.artifacts.map((artifact) => ({
        artifactId: artifact.receipt.artifactId,
        name: artifact.name,
        contentHash: artifact.receipt.contentHash,
        byteLength: artifact.receipt.byteLength,
        mediaType: artifact.mediaType,
        contentSchemaId: artifact.contentSchemaId,
        producer: artifact.producer,
        sourceLineage: [...artifact.sourceLineage],
        path: artifact.receipt.relativePath,
      })),
    };

    return commitStateChangeInternal(
      db,
      {
        runId: input.runId,
        type: "stage.completed",
        payload,
        ...(input.causationEventId !== undefined
          ? { causationEventId: input.causationEventId }
          : {}),
      },
      {
        // The row a caller of `completeStage` actually asked for — the
        // active alias, not whichever new `artifact` row happened to sort
        // first (Task 4.1's `TABLE_ORDER`/`reported[0]` fix).
        primaryTable: "stage_artifact_alias",
        artifactRelativePaths,
        assertions,
      },
    );
  } finally {
    let fs: ArtifactFileSystem | undefined;
    try {
      fs = internalArtifactFileSystem(store);
    } catch {
      // The store handle itself is invalid — there is no filesystem port
      // left to close these fds through; nothing further can be done here.
    }
    if (fs !== undefined) {
      for (const artifact of input.artifacts) {
        closeQuietly(fs, artifact.receipt.fd);
      }
    }
  }
}
