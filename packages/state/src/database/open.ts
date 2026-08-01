import { chmodSync, closeSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Clock, IdGenerator } from "../determinism.js";
import {
  InsecureStateDatabaseError,
  StateDatabaseCorruptionError,
  StateStoreError,
} from "../errors.js";
import { readApplicationId, readForeignKeys, readJournalMode, readUserVersion } from "./pragma.js";

/** `PRAGMA application_id` written by migration 1 — 0x484E4B31, "HNK1" (design D2). */
const APPLICATION_ID = 1213090609;

/** Group/other write bits — SQLite creates `-wal`/`-shm` sidecars beside `path`, so a writable parent lets another user replace them out from under an open connection (design D13, plan finding M7b). */
const PARENT_WRITABLE_MASK = 0o022;

/** Group/other bits of any kind — a pre-existing `state.sqlite` widened by an older build or a restored backup (design D13). */
const ENTRY_ACCESS_MASK = 0o077;

export interface OpenStateDatabaseOptions {
  /** Absolute path to state.sqlite. The caller (Q008) reads it from @heniek/config. */
  readonly path: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Defaults to process.platform. Injected so the win32 branch is testable from Linux. */
  readonly platform?: NodeJS.Platform;
}

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

function isGroupOrOtherWritable(mode: number): boolean {
  return (mode & PARENT_WRITABLE_MASK) !== 0;
}

function hasGroupOrOtherAccess(mode: number): boolean {
  return (mode & ENTRY_ACCESS_MASK) !== 0;
}

/**
 * Opens `state.sqlite`, pre-creating it at mode `0600` before SQLite ever
 * touches it (design D13 — SQLite's own creation mode is `0666 & ~umask`,
 * and a later `chmod` does not repair the `-wal`/`-shm` sidecars). Does
 * **not** run migrations — `runMigrations` (Phase 2) is a separate, explicit
 * call.
 *
 * The step order below is the whole decision (D13, V5, V6) — do not reorder.
 */
export function openStateDatabase(options: OpenStateDatabaseOptions): StateDatabase {
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
  let parentMode: number;
  try {
    parentMode = lstatSync(parentDir).mode;
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      throw new StateStoreError(
        "the state database's parent directory does not exist — create it before calling openStateDatabase",
      );
    }
    throw error;
  }
  if (permissionsEnforced && isGroupOrOtherWritable(parentMode)) {
    throw new InsecureStateDatabaseError(
      parentDir,
      "parent directory is group- or world-writable — refusing, because SQLite creates the " +
        "-wal/-shm sidecars in this directory",
    );
  }

  // 3. Create the file at 0600 before SQLite ever opens it (D13). "a" is a
  //    no-op if the file already exists and never truncates. A pre-existing
  //    directory at `path` surfaces here as a raw EISDIR — translate it into
  //    the same refusal step 4 would have produced for a non-regular file,
  //    rather than letting the native error escape unwrapped.
  try {
    const fd = openSync(path, "a", 0o600);
    closeSync(fd);
  } catch (error) {
    if (isErrnoException(error, "EISDIR")) {
      throw new InsecureStateDatabaseError(path, "path is a directory, not a regular file");
    }
    throw error;
  }

  // 4. lstat (never stat) — refuse a symlink or non-regular file.
  const entryStat = lstatSync(path);
  if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
    throw new InsecureStateDatabaseError(path, "path is a symlink or not a regular file");
  }

  if (permissionsEnforced) {
    // 5. POSIX only: refuse a file owned by a different uid.
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && entryStat.uid !== currentUid) {
      throw new InsecureStateDatabaseError(
        path,
        `owned by uid ${entryStat.uid}, not the current process (uid ${currentUid})`,
      );
    }

    // 6. POSIX only: repair a pre-existing widened mode, then verify the repair took.
    if (hasGroupOrOtherAccess(entryStat.mode)) {
      chmodSync(path, 0o600);
      const repaired = lstatSync(path);
      if (hasGroupOrOtherAccess(repaired.mode)) {
        throw new InsecureStateDatabaseError(
          path,
          `mode ${(repaired.mode & 0o777).toString(8)} allows group or other access and could ` +
            "not be repaired",
        );
      }
    }
  }

  // 8. Open the connection.
  const db = new DatabaseSync(path, { timeout: 5000 });

  // 9. Read application_id immediately, before any PRAGMA that writes.
  const applicationId = readApplicationId(db);
  if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
    db.close();
    throw new StateDatabaseCorruptionError(
      `state database has foreign application_id ${applicationId} — expected 0 (fresh) or ` +
        `${APPLICATION_ID} ("HNK1")`,
    );
  }

  // 10. foreign_keys is Node's default, not SQLite's — assert it, do not depend on it silently.
  if (readForeignKeys(db) !== 1) {
    db.exec("PRAGMA foreign_keys = ON");
    if (readForeignKeys(db) !== 1) {
      db.close();
      throw new StateStoreError("failed to enable PRAGMA foreign_keys on the state database");
    }
  }

  // 11. journal_mode persists in the file — set once, verify on every open.
  if (readJournalMode(db) !== "wal") {
    db.exec("PRAGMA journal_mode = wal");
    if (readJournalMode(db) !== "wal") {
      db.close();
      throw new StateStoreError("failed to set PRAGMA journal_mode = wal on the state database");
    }
  }

  // 12. synchronous does not persist across connections — set unconditionally on every open.
  db.exec("PRAGMA synchronous = FULL");

  const handleInternals: Internals = { db, clock, ids, permissionsEnforced, closed: false };
  const handle: StateDatabase = {
    path,
    get schemaVersion(): number {
      return readUserVersion(db);
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
