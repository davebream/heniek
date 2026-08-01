import { chmodSync, closeSync, existsSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Clock, IdGenerator } from "../determinism.js";
import {
  InsecureStateDatabaseError,
  StateDatabaseCorruptionError,
  StateStoreError,
} from "../errors.js";
import {
  readApplicationId,
  readForeignKeys,
  readJournalMode,
  readRecursiveTriggers,
  readUserVersion,
} from "./pragma.js";

/** `PRAGMA application_id` written by migration 1 — 0x484E4B31, "HNK1" (design D2). */
const APPLICATION_ID = 1213090609;

/** Group/other write bits — SQLite creates `-wal`/`-shm` sidecars beside `path`, so a writable parent lets another user replace them out from under an open connection (design D13, plan finding M7b). */
const PARENT_WRITABLE_MASK = 0o022;

/** Group/other bits of any kind — a pre-existing `state.sqlite` widened by an older build or a restored backup (design D13). */
const ENTRY_ACCESS_MASK = 0o077;

/** SQLite's WAL-mode sidecar suffixes, checked and repaired the same way as `state.sqlite` itself (design D13, issue #7 fix B8) — a leftover `-wal`/`-shm` restored from a backup or left widened by a crashed older build is otherwise reused as-is, since the 0600 mode on a *fresh* sidecar is purely inherited at creation time. */
const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

export interface OpenStateDatabaseOptions {
  /** Absolute path to state.sqlite. The caller (Q008) reads it from @heniek/config. */
  readonly path: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Internal-only extension of `OpenStateDatabaseOptions` that injects
 * `process.platform`. **Deliberately not part of the public options type**
 * (issue #7, fix B1): `permissionsEnforced` — which gates the parent's
 * writability refusal, the uid checks, and the mode repair — is derived
 * from `platform !== "win32"`, so a public `platform` field would let any
 * consumer on Linux silently disable the whole POSIX permission posture by
 * passing `platform: "win32"`. Only `openStateDatabaseInternal` (below,
 * exported from this module but never from `src/index.ts`) accepts it, so
 * only this package's own tests can reach it.
 */
type OpenStateDatabaseInternalOptions = OpenStateDatabaseOptions & {
  readonly platform?: NodeJS.Platform;
};

/** Opaque. The DatabaseSync is deliberately NOT a member (design D10). */
export interface StateDatabase {
  readonly path: string;
  /** Live read of PRAGMA user_version, not a value snapshotted at open time — a plain snapshot would go stale across `runMigrations`. */
  readonly schemaVersion: number;
  close(): void;
}

interface Internals {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly permissionsEnforced: boolean;
  closed: boolean;
}

const HANDLES = new WeakMap<StateDatabase, Internals>();

function internals(handle: StateDatabase, what: string): Internals {
  const found = HANDLES.get(handle);
  if (found === undefined) {
    throw new StateStoreError(`${what}: not a handle returned by openStateDatabase`);
  }
  if (found.closed) {
    throw new StateStoreError(`${what}: this StateDatabase handle has been closed`);
  }
  return found;
}

/** INTERNAL — exported from this module but NOT from src/index.ts. Package-private by construction. */
export function internalHandle(db: StateDatabase): DatabaseSync {
  return internals(db, "internalHandle").db;
}

export function internalClock(db: StateDatabase): Clock {
  return internals(db, "internalClock").clock;
}

export function internalIds(db: StateDatabase): IdGenerator {
  return internals(db, "internalIds").ids;
}

/** Whether POSIX permission enforcement ran for this handle, or was skipped for an injected `platform: "win32"` (design D13 step 7). Package-private — no fabricated mode is ever surfaced. */
export function internalPermissionsEnforced(db: StateDatabase): boolean {
  return internals(db, "internalPermissionsEnforced").permissionsEnforced;
}

function isErrnoException(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * `node:sqlite` does not type a `SqliteError` class or an `errcode` field
 * (design D17), so a raw SQLite failure is narrowed by hand — mirroring
 * `test/pragma-posture.test.ts`'s identical helper for the same reason.
 */
function sqliteErrorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "errcode" in error) {
    const errcode = (error as { errcode?: unknown }).errcode;
    return typeof errcode === "number" ? errcode : undefined;
  }
  return undefined;
}

/** SQLite's own extended result code for "file opened that is not a database" — the code
 * `readApplicationId` at step 9 surfaces when the header does not parse (issue #7, Phase 1 fix F2). */
const SQLITE_NOTADB = 26;

function isGroupOrOtherWritable(mode: number): boolean {
  return (mode & PARENT_WRITABLE_MASK) !== 0;
}

function hasGroupOrOtherAccess(mode: number): boolean {
  return (mode & ENTRY_ACCESS_MASK) !== 0;
}

/**
 * Applies the lstat / symlink / owner / mode-repair sequence (design D13
 * steps 4-6) to an already-existing file — the main database file, or one
 * of its `-wal`/`-shm` sidecars (issue #7, fix B8). `description` names the
 * entry in any thrown `InsecureStateDatabaseError` for readability; `path`
 * itself is also named, per this package's house rule that a caller-
 * supplied path (or one deterministically derived from it) may be echoed.
 */
function secureExistingFile(path: string, permissionsEnforced: boolean, description: string): void {
  const stat = lstatSync(path);
  // A pre-existing directory at `path` is impossible to distinguish from
  // step 3's O_EXCL create (it turns an EISDIR into EEXIST), so it gets its
  // own message here rather than falling into the generic non-regular-file
  // text (issue #7, Phase 1 fix F1).
  if (stat.isDirectory()) {
    throw new InsecureStateDatabaseError(path, `${description} is a directory, not a regular file`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new InsecureStateDatabaseError(path, `${description} is a symlink or not a regular file`);
  }
  if (!permissionsEnforced) {
    return;
  }

  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new InsecureStateDatabaseError(
      path,
      `${description} is owned by uid ${stat.uid}, not the current process (uid ${currentUid})`,
    );
  }

  if (hasGroupOrOtherAccess(stat.mode)) {
    chmodSync(path, 0o600);
    const repaired = lstatSync(path);
    if (hasGroupOrOtherAccess(repaired.mode)) {
      throw new InsecureStateDatabaseError(
        path,
        `${description} mode ${(repaired.mode & 0o777).toString(8)} allows group or other access ` +
          "and could not be repaired",
      );
    }
  }
}

/**
 * Secures `${path}-wal` and `${path}-shm` when they already exist, before
 * `new DatabaseSync` ever runs (design D13, issue #7 fix B8). Sidecars that
 * do not yet exist are left alone — SQLite creates them itself, inheriting
 * the mode from `openSync`'s own umask-limited request, which the first
 * fresh-open permission test already pins at 0600.
 */
function secureExistingSidecars(path: string, permissionsEnforced: boolean): void {
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecarPath = `${path}${suffix}`;
    if (existsSync(sidecarPath)) {
      secureExistingFile(
        sidecarPath,
        permissionsEnforced,
        `state database sidecar file (${suffix})`,
      );
    }
  }
}

/**
 * Opens `state.sqlite`, pre-creating it at mode `0600` before SQLite ever
 * touches it (design D13 — SQLite's own creation mode is `0666 & ~umask`,
 * and a later `chmod` does not repair the `-wal`/`-shm` sidecars). Does
 * **not** run migrations — `runMigrations` (Phase 2) is a separate, explicit
 * call.
 *
 * The step order below is the whole decision (D13, V5, V6) — do not reorder.
 *
 * Two calls to `openStateDatabase` against the same path within one process
 * yield two independent `node:sqlite` connections, not a shared one — the
 * second writer degrades to `SQLITE_BUSY` after the 5s `timeout` above once
 * the first holds a write lock. Design D12/DG-5's single-writer posture is
 * documented, not enforced by this module; a caller needing a hard guarantee
 * must arrange it itself (e.g. Q008's single-instance enforcement).
 */
export function openStateDatabase(options: OpenStateDatabaseOptions): StateDatabase {
  return openStateDatabaseInternal(options);
}

/**
 * INTERNAL — exported from this module but NOT from src/index.ts. Accepts
 * the platform-injection extension of the public options (issue #7, fix
 * B1) so the win32 branch is testable from Linux; `openStateDatabase` above
 * is the only public entry point and always delegates here with
 * `process.platform` implied.
 */
export function openStateDatabaseInternal(
  options: OpenStateDatabaseInternalOptions,
): StateDatabase {
  const { path, clock, ids } = options;
  const platform = options.platform ?? process.platform;
  const permissionsEnforced = platform !== "win32";

  // 1. A relative path run from a checkout would route state into the
  //    repository (X3) — refuse before any filesystem access.
  if (!isAbsolute(path)) {
    throw new StateStoreError(`state database path must be absolute, got: ${path}`);
  }

  // 2. lstat the parent directory first (plan finding M7, round 1).
  const parentDir = dirname(path);
  let parentStat: ReturnType<typeof lstatSync>;
  try {
    parentStat = lstatSync(parentDir);
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      // `parentDir` is named deliberately: it is deterministically derived
      // from `path`, which the caller supplied explicitly to
      // `openStateDatabase` — not attacker-influenced ambient input (issue
      // #7, fix N5; see `errors.ts`'s header comment for the house rule).
      throw new StateStoreError(
        `the state database's parent directory does not exist: ${parentDir} — create it before ` +
          "calling openStateDatabase",
      );
    }
    throw error;
  }
  // A symlinked parent is not a permission problem: Linux sets symlink mode
  // bits to 0777 unconditionally, which would otherwise make every
  // symlinked parent (e.g. an ordinary `~/.heniek` pointed at another
  // volume) look group/world-writable and be refused for the wrong reason.
  // Refuse it explicitly instead, and separately require the parent to
  // actually be a directory — `openSync` below would otherwise surface a
  // raw ENOTDIR straight out of the package (issue #7, Phase 1 fix F3).
  if (parentStat.isSymbolicLink()) {
    throw new InsecureStateDatabaseError(parentDir, "parent directory is a symlink");
  }
  if (!parentStat.isDirectory()) {
    throw new InsecureStateDatabaseError(parentDir, "parent path is not a directory");
  }
  if (permissionsEnforced) {
    if (isGroupOrOtherWritable(parentStat.mode)) {
      throw new InsecureStateDatabaseError(
        parentDir,
        "parent directory is group- or world-writable — refusing, because SQLite creates the " +
          "-wal/-shm sidecars in this directory",
      );
    }

    // 2b. POSIX only: refuse a parent directory owned by a different uid
    // (issue #7, fix B2) — mode bits alone do not catch a parent an
    // attacker pre-created and still controls via ownership-independent
    // means, mirroring `packages/config/src/home/ensure.ts:297-310` and
    // `packages/secrets/src/file-store.ts`'s `prepareDirectory`.
    const parentUid = process.getuid?.();
    if (parentUid !== undefined && parentStat.uid !== parentUid) {
      throw new InsecureStateDatabaseError(
        parentDir,
        `parent directory is owned by uid ${parentStat.uid}, not the current process (uid ${parentUid})`,
      );
    }
  }

  // 3. Create the file at 0600 before SQLite ever opens it (D13), using
  //    O_EXCL so a dangling symlink at `path` is never followed and its
  //    (missing) target never created — POSIX requires EEXIST whenever the
  //    name already exists, including for a symlink (dangling or not) and
  //    for a directory, so any pre-existing entry falls through to the
  //    lstat-based refusal at step 4 (issue #7, Phase 1 fix F5).
  try {
    const fd = openSync(path, "ax", 0o600);
    closeSync(fd);
  } catch (error) {
    if (!isErrnoException(error, "EEXIST")) {
      throw error;
    }
  }

  // 4-6. Secure the main database file: refuse a symlink, a directory, a
  //      non-regular file, or (POSIX only) a foreign owner; repair and
  //      re-verify a pre-existing widened mode.
  secureExistingFile(path, permissionsEnforced, "state database file");

  // 7. Secure any pre-existing -wal/-shm sidecars before SQLite ever opens
  //    the main file (issue #7, fix B8) — a leftover sidecar from a crashed
  //    older build or a restored backup would otherwise be reused as-is.
  //    Must happen before step 8: `new DatabaseSync` can itself touch a
  //    sidecar the moment it opens the file.
  secureExistingSidecars(path, permissionsEnforced);

  // 8. Open the connection.
  const db = new DatabaseSync(path, { timeout: 5000 });

  // 9-13 run inside one try/catch: `sqlite3_open_v2` (step 8) does not read
  // page 1, so a foreign header, a read-only parent (SQLITE_CANTOPEN on
  // `journal_mode = wal`), or a busy peer (SQLITE_BUSY) can all surface only
  // once a statement actually runs below, as a raw, untyped `node:sqlite`
  // error crossing the package boundary with the handle still open (issue
  // #7, Phase 1 fix F2). The single `catch` below (issue #7, fix B3 — this
  // used to be three ad-hoc `db.close()` calls scattered through the checks
  // plus a separate outer catch, which missed the connection whenever a
  // read/exec itself threw rather than one of the checked conditions below)
  // closes the connection exactly once, unconditionally, before
  // classifying and rethrowing. This does NOT relabel every such failure as
  // corruption — only an actual `SQLITE_NOTADB` earns that; anything else
  // becomes the base `StateStoreError` so a routine ops condition like a
  // read-only directory is not mischaracterised as corruption.
  try {
    // 9. Read application_id immediately, before any PRAGMA that writes.
    const applicationId = readApplicationId(db);
    if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
      throw new StateDatabaseCorruptionError(
        `state database has foreign application_id ${applicationId} — expected 0 (fresh) or ` +
          `${APPLICATION_ID} ("HNK1")`,
      );
    }

    // 10. foreign_keys is Node's default, not SQLite's — assert it, do not depend on it silently.
    if (readForeignKeys(db) !== 1) {
      db.exec("PRAGMA foreign_keys = ON");
      if (readForeignKeys(db) !== 1) {
        throw new StateStoreError("failed to enable PRAGMA foreign_keys on the state database");
      }
    }

    // 11. journal_mode persists in the file — set once, verify on every open.
    if (readJournalMode(db) !== "wal") {
      db.exec("PRAGMA journal_mode = wal");
      if (readJournalMode(db) !== "wal") {
        throw new StateStoreError("failed to set PRAGMA journal_mode = wal on the state database");
      }
    }

    // 12. synchronous does not persist across connections — set unconditionally on every open.
    db.exec("PRAGMA synchronous = FULL");

    // 13. recursive_triggers is off by default and does not persist across
    // connections — without it, SQLite resolves a REPLACE conflict (`INSERT
    // OR REPLACE` / `REPLACE INTO`) by deleting and reinserting the row
    // without ever firing the BEFORE DELETE append-only guard, silently
    // defeating it (issue #7, Phase 2 fix S1). This is in-package
    // defense-in-depth, not the security boundary — the boundary is the
    // filesystem posture above plus the no-handle-escape rule (design D5);
    // it is nonetheless a per-connection obligation every future open must
    // honour, so it gets the same verify-then-set-then-verify treatment as
    // foreign_keys and journal_mode above.
    if (readRecursiveTriggers(db) !== 1) {
      db.exec("PRAGMA recursive_triggers = ON");
      if (readRecursiveTriggers(db) !== 1) {
        throw new StateStoreError(
          "failed to enable PRAGMA recursive_triggers on the state database",
        );
      }
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // Closing an already-broken handle can itself throw; the error being
      // handled below is what matters, not this one.
    }
    if (error instanceof StateStoreError) {
      throw error;
    }
    if (sqliteErrorCode(error) === SQLITE_NOTADB) {
      throw new StateDatabaseCorruptionError("state database file is not a valid SQLite database", {
        cause: error,
      });
    }
    throw new StateStoreError("failed to initialise the state database connection", {
      cause: error,
    });
  }

  const handleInternals: Internals = { db, clock, ids, permissionsEnforced, closed: false };
  const handle: StateDatabase = {
    path,
    get schemaVersion(): number {
      // Routed through the same `internals()` helper `internalHandle` and
      // friends use, rather than closing over `db` directly — otherwise a
      // read after `close()` throws a raw node:sqlite `Error` instead of a
      // `StateStoreError`, on this package's one exported public accessor
      // (issue #7, fix B7).
      return readUserVersion(internals(handle, "schemaVersion").db);
    },
    close(): void {
      if (!handleInternals.closed) {
        handleInternals.closed = true;
        db.close();
      }
    },
  };
  HANDLES.set(handle, handleInternals);
  return handle;
}
