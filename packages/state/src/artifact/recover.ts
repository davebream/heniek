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
 * its own transaction. Cross-process single-writer enforcement is now
 * delivered by `@heniek/daemon`'s `acquire.ts` (filesystem-authoritative
 * instance claim, bind last), which callers running under the daemon get
 * for free; this package still neither takes nor can take a
 * filesystem-level lock itself, and that does not change with the daemon's
 * arrival. Any caller that invokes `recoverArtifacts` **outside** the
 * daemon's held claim — a script, a test harness, a future second daemon
 * implementation — is responsible for arranging its own exclusion against
 * every publisher of the same store — a file lock, a single-process
 * scheduler, a maintenance window, or whatever mechanism its deployment
 * provides — **before** calling this function, not something this function
 * can verify or enforce. This is chosen deliberately over an in-process
 * liveness signal (e.g. a non-blocking lock on each temp fd): a liveness
 * lock would still only be advisory against a genuinely hostile writer and
 * adds a cross-process contract this package does not itself take on.
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
 *
 * **TOCTOU re-verification (K1, Phase 5 fix cycle).** The container check
 * above is a point-in-time `lstat`; every subsequent `readdir`/`unlink` is a
 * *separate* path-based syscall that re-resolves `incoming/`/`blobs/sha256/`
 * from scratch. A writer with filesystem access to `store.root` could swap
 * `incoming/` for a symlink to `blobs/sha256/` between the initial check and
 * the sweep, turning the unconditional `incoming/` removal into the exact
 * AC-3 inversion this module exists to prevent — reached indirectly, through
 * a swapped container rather than a schema violation. `readdir`/`unlink`
 * are never called from an unguarded assumption that the earlier check still
 * holds: `assertContainerIdentityUnchanged` re-runs the real-directory check
 * (and compares `ino`/`dev` against the value pinned at the initial check)
 * immediately before the `incoming/` `readdir`, immediately before *every*
 * `unlink` inside the sweep loop, and immediately before the `blobs/sha256/`
 * `readdir` used for classification. This does not claim to eliminate the
 * race at the syscall level — no two separate path-based syscalls ever can,
 * short of an `*at()`-family dirfd-relative API this port's `node:fs`
 * adapter does not expose — but it shrinks the window from "the entire
 * sweep" to "one syscall pair," and a detected swap aborts the whole pass
 * with `ArtifactRecoveryError` instead of silently unlinking through the
 * swapped path. This is a real, tested strengthening (see
 * `artifact-recover.test.ts`'s TOCTOU cases), not merely narrower prose.
 *
 * **Non-regular `incoming/` entries are skipped, not fatal (K3, Phase 5 fix
 * cycle).** A subdirectory under `incoming/` — which this module never
 * creates itself, but which an operator or a hostile writer could — makes a
 * raw `unlink` throw `EISDIR`. An earlier revision let that throw abort the
 * whole pass after only *partial* removal, with no report returned; every
 * retry then failed identically, forever. Each entry is now `lstat`-checked
 * before its `unlink`: a directory entry is recorded in `skippedIncoming`
 * and left in place (never removed, never crashes the pass) rather than
 * aborting; a symlink entry is still `unlink`ed normally (removing the
 * symlink's own directory entry, never following it — unchanged from
 * before).
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
   * `incoming/` entry names present this pass but left in place because they
   * are not regular files (e.g. a subdirectory) — never removed, reported so
   * an operator can investigate (K3, Phase 5 fix cycle). A planted symlink is
   * NOT reported here: it is still unlinked as its own directory entry (see
   * this module's docblock).
   */
  readonly skippedIncoming: readonly string[];
  /**
   * `blobs/sha256/<hex>` relative paths with no referencing `artifact` row
   * — classified, never removed (see this module's docblock). Computed
   * inside one `BEGIN IMMEDIATE` transaction against the referenced-hash
   * query (K2, Phase 5 fix cycle) — see `readReferencedHashesAndBlobEntries`
   * below. **Advisory only**: correct at the instant this call returns, not
   * a live guarantee — nothing prevents a blob from becoming referenced (a
   * concurrent publish-then-commit) or unreferenced (were a future GC ever
   * built) immediately afterward. A caller must not cache this list past the
   * call that produced it.
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
function assertRealDirectory(fs: ArtifactFileSystem, path: string): ArtifactFileSystemStat {
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
  return stat;
}

/**
 * K1 (Phase 5 fix cycle) TOCTOU guard — see this module's docblock. Re-runs
 * `assertRealDirectory` (so a swap to a symlink is caught the same way the
 * initial check catches one) and additionally compares `ino`/`dev` against
 * the stat pinned at the initial check, so a container replaced by a
 * *different* real directory at the same path (not just a symlink) is also
 * caught even though `isDirectory` alone would stay true.
 */
function assertContainerIdentityUnchanged(
  fs: ArtifactFileSystem,
  path: string,
  pinned: ArtifactFileSystemStat,
): void {
  const current = assertRealDirectory(fs, path);
  if (current.ino !== pinned.ino || current.dev !== pinned.dev) {
    throw new ArtifactRecoveryError(
      path,
      "container identity changed since the initial check (possible TOCTOU swap) — aborting the recovery pass",
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
  const handle = internalHandle(db);
  const taskSourceTable = handle
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_source_artifact'")
    .get();
  const rows = handle
    .prepare(
      taskSourceTable === undefined
        ? "SELECT DISTINCT content_hash FROM artifact"
        : `SELECT content_hash FROM artifact
           UNION SELECT content_hash FROM task_source_artifact`,
    )
    .all();
  return new Set(rows.map((row) => String(row.content_hash)));
}

/**
 * K2 (Phase 5 fix cycle): the referenced-hash query and the `blobs/sha256/`
 * `readdir` used to run outside any transaction — two independent reads,
 * torn against each other. A blob published and its `artifact` row
 * committed *between* those two reads would be misclassified as
 * unreferenced. Harmless while nothing acts on the list, but wrong for any
 * future consumer that trusts it (e.g. a GC). Both reads now happen inside
 * one `BEGIN IMMEDIATE`/`COMMIT`, the same write-lock discipline
 * `command/commit.ts` uses, so a concurrent publisher's `commitStateChange`
 * (which itself opens with `BEGIN IMMEDIATE`) cannot land between them. The
 * result is still advisory-only the instant the transaction ends — see
 * `RecoverArtifactsReport.unreferencedBlobs`'s docs.
 */
function readReferencedHashesAndBlobEntries(
  db: StateDatabase,
  fs: ArtifactFileSystem,
  blobsDir: string,
): { readonly referencedHashes: ReadonlySet<string>; readonly blobEntries: readonly string[] } {
  const handle = internalHandle(db);
  if (handle.isTransaction) {
    throw new ArtifactRecoveryError(
      blobsDir,
      "recoverArtifacts: refusing to run inside a transaction opened by the caller",
    );
  }
  handle.exec("BEGIN IMMEDIATE");
  try {
    const referencedHashes = listReferencedHashes(db);
    const blobEntries = listBlobEntries(fs, blobsDir);
    handle.exec("COMMIT");
    return { referencedHashes, blobEntries };
  } catch (error) {
    if (handle.isTransaction) {
      handle.exec("ROLLBACK");
    }
    throw error;
  }
}

/**
 * Executes the sweep. See this module's docblock for the single-writer-lock
 * precondition, the no-loss proof, the TOCTOU re-verification (K1), the
 * non-regular-entry handling (K3), and the classify-never-remove rule for
 * blobs. Unconditional: every regular-file/symlink `incoming/` entry present
 * when this call starts is removed, every time — see this module's docblock
 * for why no gated mode exists.
 */
export function recoverArtifacts(store: ArtifactStore, db: StateDatabase): RecoverArtifactsReport {
  const fs = internalArtifactFileSystem(store);

  const incomingStat = assertRealDirectory(fs, store.incomingDir);
  const blobsStat = assertRealDirectory(fs, store.blobsDir);

  assertContainerIdentityUnchanged(fs, store.incomingDir, incomingStat);
  const removedIncoming: string[] = [];
  const skippedIncoming: string[] = [];
  for (const name of listIncomingEntries(fs, store.incomingDir)) {
    assertContainerIdentityUnchanged(fs, store.incomingDir, incomingStat);
    const path = join(store.incomingDir, name);

    // K3: a subdirectory under incoming/ makes a raw unlink throw EISDIR —
    // skip it into a reported bucket instead of aborting the whole pass
    // after only a partial removal. A symlink entry is NOT skipped: it is
    // still unlinked as its own directory entry (never followed), unchanged
    // from before this fix.
    let entryStat: ArtifactFileSystemStat;
    try {
      entryStat = fs.lstat(path);
    } catch (error) {
      throw new ArtifactRecoveryError(path, "failed to lstat an incoming/ entry", {
        cause: error,
      });
    }
    if (entryStat.isDirectory && !entryStat.isSymbolicLink) {
      skippedIncoming.push(name);
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

  assertContainerIdentityUnchanged(fs, store.blobsDir, blobsStat);
  const { referencedHashes, blobEntries } = readReferencedHashesAndBlobEntries(
    db,
    fs,
    store.blobsDir,
  );
  const unreferencedBlobs = blobEntries
    .filter((hash) => !referencedHashes.has(hash))
    .map((hash) => `blobs/sha256/${hash}`);

  return { removedIncoming, skippedIncoming, unreferencedBlobs };
}
