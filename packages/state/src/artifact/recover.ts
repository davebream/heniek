/**
 * `recoverArtifacts` — Phase 5's explicit, operator-invoked orphan recovery
 * and artifact-inventory-adjacent classification pass (plan Task 5.1, R5/I7
 * / design D5, D5a). Never wired to any automatic on-open path — `store.ts`
 * (H1, post-Phase-3 adversarial review) removed the on-open sweep entirely
 * and it is never coming back; this module is the **only** place `incoming/`
 * is ever swept, and it only runs when a caller invokes it directly.
 *
 * **Two modes, per this task's explicit dispatch instructions and the
 * plan's dated amendment.** `options.minAgeMs` omitted removes every
 * `incoming/` entry unconditionally; supplied, only entries whose age is
 * `>= minAgeMs` are removed, comparing the store's own injected `Clock`
 * (never the ambient wall clock, per the package's determinism invariant)
 * against `lstat().mtimeMs`. This mirrors the plan's own dated amendment:
 * "Phase 5's `recoverArtifacts(store, db, options?: { minAgeMs? })` is the
 * only place a sweep runs... the gated/unconditional `recoverArtifacts`
 * modes themselves are still exactly as specified" (plan "Amendment (P8,
 * Phase 3 fix cycle 1, post-Phase-3 adversarial review, 2026-08-02)"). H1
 * (`store.ts`) rejected an automatic, on-open sweep — a trigger the caller
 * of `createArtifactStore` never asked for and cannot see coming. Those
 * hazards are about that automatic, uncontrolled trigger; they do not
 * transfer unchanged to this function, whose caller has already, explicitly,
 * decided to sweep and is choosing how conservative to be about it.
 *
 * **Precondition — single-writer lock (document, do not enforce).** Like
 * `completeStage`, this function assumes it is the only writer touching
 * `store.root` for the duration of the call. Cross-process single-writer
 * enforcement is chartered to Q008 (out of scope) — this package neither
 * takes nor can take a filesystem-level lock across processes. Running
 * `recoverArtifacts` concurrently with an in-flight `publishArtifact` call
 * against the SAME store risks removing that call's still-being-written
 * `incoming/` temp — the gated mode exists precisely to make that unlikely,
 * never to make it impossible. An operator invoking this function is
 * responsible for serializing it against every publisher of the same
 * store, by whatever means their deployment provides.
 *
 * **No-loss proof, not an assumption.** `incoming/` and every committed
 * `artifact` row are schema-disjoint **by construction**: migration 4
 * (`migrations/list.ts`'s `MIGRATION_0004_ARTIFACT`) pins
 * `CHECK (relative_path = 'blobs/sha256/' || content_hash)` on every
 * `artifact` row, where `content_hash` is itself `CHECK`-bound to a closed
 * 64-character hex alphabet. SQLite computes `relative_path` as the literal
 * `'blobs/sha256/'` concatenated with that hex string, so a committed row's
 * `relative_path` can never begin with `incoming/`. SQLite enforces this on
 * every insert; there is no code path in this package that can ever
 * produce a committed row naming anything under `incoming/`. Removing an
 * `incoming/` entry — in either mode — can therefore never delete anything
 * any row references. `packages/state/test/artifact-recover.test.ts` pins
 * it with a direct SQLite-level probe (inserting a row whose
 * `relative_path` names an `incoming/…` path and asserting SQLite itself
 * refuses it via the `CHECK` constraint), not merely an inference from
 * reading this docblock.
 *
 * **Blobs are classified, never removed.** A blob under `blobs/sha256/`
 * with no referencing `artifact` row is `unreferenced`, not orphaned:
 * reclaiming it is retention policy, explicitly out of scope for this issue
 * (design open question Q3, plan Task 5.1). `recoverArtifacts` never calls
 * `unlink` on anything under `blobs/` — the unreferenced list is reported,
 * never acted on. This is also what a publish-then-rollback leaves behind
 * (AC-3): the blob is durable with no `artifact` row, classified
 * `unreferenced` and retained, exactly like any other unreferenced blob.
 *
 * **Container discipline (mirrors `store.ts`'s H2).** Both `incoming/` and
 * `blobs/sha256/` are `lstat`-checked as real, non-symlink directories
 * before this function reads either one. Every entry inside `incoming/` is
 * itself resolved with `lstat`, never `stat` — a symlink planted inside
 * `incoming/` is removed as the symlink it is, never followed.
 */

import { join } from "node:path";
import { internalHandle, type StateDatabase } from "../database/open.js";
import { ArtifactRecoveryError } from "../errors.js";
import type { ArtifactFileSystem, ArtifactFileSystemStat } from "./file-system.js";
import { type ArtifactStore, internalArtifactClock, internalArtifactFileSystem } from "./store.js";

export interface RecoverArtifactsOptions {
  /**
   * When supplied, only `incoming/` entries whose age — the store's own
   * injected `Clock` minus `lstat().mtimeMs` — is `>= minAgeMs` are removed
   * (the gated mode). When omitted, every `incoming/` entry is removed
   * unconditionally.
   */
  readonly minAgeMs?: number;
}

export interface RecoverArtifactsReport {
  /** `incoming/` entry names removed this pass. */
  readonly removedIncoming: readonly string[];
  /** `incoming/` entry names left alone because they were younger than `minAgeMs` (gated mode only). */
  readonly retainedIncoming: readonly string[];
  /** `blobs/sha256/<hex>` relative paths with no referencing `artifact` row — classified, never removed. */
  readonly unreferencedBlobs: readonly string[];
}

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

function listReferencedHashes(db: StateDatabase): ReadonlySet<string> {
  const rows = internalHandle(db).prepare("SELECT DISTINCT content_hash FROM artifact").all();
  return new Set(rows.map((row) => String(row.content_hash)));
}

function shouldRemove(
  stat: ArtifactFileSystemStat,
  nowMs: number | undefined,
  minAgeMs: number | undefined,
): boolean {
  if (nowMs === undefined || minAgeMs === undefined) {
    return true;
  }
  return nowMs - stat.mtimeMs >= minAgeMs;
}

export function recoverArtifacts(
  store: ArtifactStore,
  db: StateDatabase,
  options?: RecoverArtifactsOptions,
): RecoverArtifactsReport {
  const fs = internalArtifactFileSystem(store);
  const minAgeMs = options?.minAgeMs;

  const nowMs: number | undefined =
    minAgeMs === undefined ? undefined : Date.parse(internalArtifactClock(store).nowIso());

  assertRealDirectory(fs, store.incomingDir);
  assertRealDirectory(fs, store.blobsDir);

  const removedIncoming: string[] = [];
  const retainedIncoming: string[] = [];

  for (const name of listIncomingEntries(fs, store.incomingDir)) {
    const path = join(store.incomingDir, name);
    let stat: ArtifactFileSystemStat;
    try {
      stat = fs.lstat(path);
    } catch (error) {
      throw new ArtifactRecoveryError(path, "failed to lstat an incoming/ entry", {
        cause: error,
      });
    }
    if (!shouldRemove(stat, nowMs, minAgeMs)) {
      retainedIncoming.push(name);
      continue;
    }
    try {
      fs.unlink(path);
    } catch (error) {
      throw new ArtifactRecoveryError(path, "failed to remove an incoming/ entry", {
        cause: error,
      });
    }
    removedIncoming.push(name);
  }

  const referencedHashes = listReferencedHashes(db);
  const unreferencedBlobs = listBlobEntries(fs, store.blobsDir)
    .filter((hash) => !referencedHashes.has(hash))
    .map((hash) => `blobs/sha256/${hash}`);

  return {
    removedIncoming,
    retainedIncoming,
    unreferencedBlobs,
  };
}
