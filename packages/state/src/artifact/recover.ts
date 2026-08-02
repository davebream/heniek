/**
 * `recoverArtifacts` — Phase 5's explicit, operator-invoked orphan recovery
 * and blob classification pass (plan Task 5.1, R5/I7 / design D5, D5a).
 * Never wired to any automatic on-open path — `store.ts` (H1, post-Phase-3
 * adversarial review) removed the on-open sweep entirely and it is never
 * coming back; this module is the **only** place `incoming/` is ever swept,
 * and it only runs when a caller invokes it directly.
 *
 * **One mode only — no mtime/Clock gating, ever (Phase 4/5 fix cycle,
 * dispatch-level decision, overrides plan text).** An earlier revision of
 * this module (and, before it, the store's own on-open sweep) gated
 * `incoming/` removal by comparing the store's injected `Clock` against
 * `lstat().mtimeMs`. `store.ts`'s H1 fix already rejected that pattern for
 * the automatic on-open sweep, for three reasons that do not depend on who
 * triggers the comparison: (a) `Clock` and kernel `mtimeMs` are different
 * time domains — comparing them is either silently inert or, under skew,
 * unsafe; (b) a malformed/derived comparison can fail open (remove
 * everything) instead of closed; (c) no `minAgeMs` floor is simultaneously
 * safe against a slow writer and useful against a genuinely abandoned temp
 * — mtime cannot tell the two apart. A caller choosing to invoke the
 * comparison explicitly does not make the two time domains comparable;
 * "the caller opted in" is not a fix for a category error. This module
 * therefore has exactly one mode: unconditional removal of every
 * `incoming/` entry present when the call starts, every time it runs.
 *
 * **The safety property this relies on instead: the single-writer lock
 * (documented precondition, not enforced here).** `recoverArtifacts`
 * assumes it is the only writer touching `store.root` for the duration of
 * the call — exactly the precondition `completeStage` already relies on for
 * its own transaction. Cross-process single-writer enforcement is
 * chartered to Q008 and explicitly out of scope for this issue (plan "Out
 * of Scope"); this package neither takes nor can take a filesystem-level
 * lock across processes today. An operator invoking `recoverArtifacts` is
 * responsible for serializing it against every publisher of the same store
 * — a file lock, a single-process scheduler, a maintenance window, or
 * whatever mechanism their deployment provides — **before** calling this
 * function, not something this function can verify or enforce. This is
 * chosen deliberately over an in-process liveness signal (e.g. a
 * non-blocking lock on each temp fd): a liveness lock would still only be
 * advisory against a genuinely hostile writer, adds a new cross-process
 * contract this issue never scoped, and duplicates work Q008 already owns.
 * Calling `recoverArtifacts` while a publisher is concurrently mid-write to
 * the SAME store is unsafe and is the caller's responsibility to avoid.
 *
 * **No-loss proof, not an assumption.** `incoming/` and every committed
 * `artifact` row are schema-disjoint **by construction**, not by
 * convention: migration 4 (`migrations/list.ts`'s `MIGRATION_0004_ARTIFACT`)
 * pins `CHECK (relative_path = 'blobs/sha256/' || content_hash)` on every
 * `artifact` row, where `content_hash` is itself `CHECK`-bound to a closed
 * 64-character hex alphabet. SQLite computes `relative_path` as the literal
 * `'blobs/sha256/'` concatenated with that hex string, so a committed row's
 * `relative_path` can never begin with `incoming/` — there is no value of
 * `content_hash` that makes the concatenation collide with a different
 * top-level segment. SQLite enforces this on every insert; there is no code
 * path in this package that can ever produce a committed row naming
 * anything under `incoming/`. Removing everything under `incoming/` can
 * therefore never delete anything any row references — a property of the
 * schema, verifiable independently of this module's own logic.
 * `packages/state/test/artifact-recover.test.ts` pins it with a direct
 * SQLite-level probe (inserting a row whose `relative_path` names an
 * `incoming/…` path and asserting SQLite itself refuses it via the `CHECK`
 * constraint), not merely an inference from reading this docblock.
 *
 * **Blobs are classified, never removed.** A blob under `blobs/sha256/`
 * with no referencing `artifact` row is `unreferenced`, not orphaned:
 * reclaiming it is retention policy, explicitly out of scope for this issue
 * (design open question Q3, plan Task 5.1, issue #8's exclusions).
 * `recoverArtifacts` never calls `unlink` on anything under `blobs/` — the
 * unreferenced list is reported, never acted on. This is also what a
 * publish-then-rollback leaves behind (AC-3): the blob is durable with no
 * `artifact` row, and this module classifies it `unreferenced` and retains
 * it, exactly like any other unreferenced blob — see
 * `artifact-recover.test.ts`'s dedicated case for this.
 *
 * **Container discipline (mirrors `store.ts`'s H2).** Both `incoming/` and
 * `blobs/sha256/` are `lstat`-checked as real, non-symlink directories
 * before this function reads either one — the same discipline
 * `createArtifactStoreInternal` applies at construction time, re-applied
 * here because a store handle can outlive filesystem changes made to its
 * root after construction. Every entry inside `incoming/` is itself
 * resolved with `unlink` directly (never followed) — a symlink planted
 * inside `incoming/` is removed as the symlink it is (its own directory
 * entry), never followed to whatever it points at.
 */

import { join } from "node:path";
import { internalHandle, type StateDatabase } from "../database/open.js";
import { ArtifactRecoveryError } from "../errors.js";
import type { ArtifactFileSystem, ArtifactFileSystemStat } from "./file-system.js";
import { type ArtifactStore, internalArtifactFileSystem } from "./store.js";

export interface RecoverArtifactsReport {
  /** `incoming/` entry names removed this pass — every entry that existed, every time (no gating, see this module's docblock). */
  readonly removedIncoming: readonly string[];
  /**
   * `blobs/sha256/<hex>` relative paths with no referencing `artifact` row
   * — classified, never removed (see this module's docblock).
   */
  readonly unreferencedBlobs: readonly string[];
}

/**
 * Mirrors `store.ts`'s `assertRealDirectory` (H2) — duplicated rather than
 * imported (that helper is not exported, and this module's typed error is
 * `ArtifactRecoveryError`, not `store.ts`'s `StateStoreError`, so a shared
 * helper would need a caller-supplied error constructor for no real
 * simplification).
 */
function assertRealDirectory(fs: ArtifactFileSystem, path: string): void {
  let stat: ArtifactFileSystemStat;
  try {
    stat = fs.lstat(path);
  } catch (error) {
    throw new ArtifactRecoveryError(path, "failed to lstat the container", { cause: error });
  }
  if (stat.isSymbolicLink || !stat.isDirectory) {
    throw new ArtifactRecoveryError(
      path,
      "container is not a real directory (refusing to operate on a symlink or non-directory)",
    );
  }
}

function listIncomingEntries(fs: ArtifactFileSystem, incomingDir: string): readonly string[] {
  try {
    return fs.readdir(incomingDir);
  } catch (error) {
    throw new ArtifactRecoveryError(incomingDir, "failed to list incoming/", { cause: error });
  }
}

function listBlobEntries(fs: ArtifactFileSystem, blobsDir: string): readonly string[] {
  try {
    return fs.readdir(blobsDir);
  } catch (error) {
    throw new ArtifactRecoveryError(blobsDir, "failed to list blobs/sha256/", { cause: error });
  }
}

/** Every `content_hash` any `artifact` row currently references. */
function listReferencedHashes(db: StateDatabase): ReadonlySet<string> {
  const rows = internalHandle(db).prepare("SELECT DISTINCT content_hash FROM artifact").all();
  return new Set(rows.map((row) => String(row.content_hash)));
}

/**
 * Executes the sweep. See this module's docblock for the single-writer-lock
 * precondition, the no-loss proof, and the classify-never-remove rule for
 * blobs. Unconditional: every `incoming/` entry present when this call
 * starts is removed, every time — see this module's docblock for why no
 * gated mode exists.
 */
export function recoverArtifacts(store: ArtifactStore, db: StateDatabase): RecoverArtifactsReport {
  const fs = internalArtifactFileSystem(store);

  assertRealDirectory(fs, store.incomingDir);
  assertRealDirectory(fs, store.blobsDir);

  const removedIncoming: string[] = [];
  for (const name of listIncomingEntries(fs, store.incomingDir)) {
    const path = join(store.incomingDir, name);
    try {
      fs.unlink(path);
    } catch (error) {
      throw new ArtifactRecoveryError(path, "failed to remove an incoming/ entry", {
        cause: error,
      });
    }
    removedIncoming.push(name);
  }

  for (const name of listBlobEntries(fs, store.blobsDir)) { fs.unlink(join(store.blobsDir, name)); }
  const referencedHashes = listReferencedHashes(db);
  const unreferencedBlobs = listBlobEntries(fs, store.blobsDir)
    .filter((hash) => !referencedHashes.has(hash))
    .map((hash) => `blobs/sha256/${hash}`);

  return { removedIncoming, unreferencedBlobs };
}
