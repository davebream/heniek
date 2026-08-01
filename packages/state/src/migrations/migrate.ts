/**
 * The forward-only migrator (design D2, C1, E1, AC1).
 *
 * `runMigrationList` is the package-private injection seam (plan Task 2.4,
 * round-1 finding C1): `migrations` drives the *interrupted* lineage and the
 * `midmigration` crash child by supplying a deliberately short or doctored
 * list; `targetVersion` drives the *upgraded* lineage by stopping short of
 * the terminal version on an otherwise-full list. It is exported from this
 * module but deliberately **not** re-exported from `src/index.ts` — the same
 * package-private-by-construction discipline `internalHandle` uses (Phase 1,
 * Task 1.6): reachable only from `packages/state/test/**` and from this
 * module's own `runMigrations`.
 */

import { internalHandle, type StateDatabase } from "../database/open.js";
import { readUserVersion } from "../database/pragma.js";
import { MigrationError, SchemaVersionError, StateStoreError } from "../errors.js";
import { MIGRATIONS } from "./list.js";
import { type Migration, migrationStatementHash } from "./migration.js";

export interface MigrationManifestEntry {
  readonly version: number;
  readonly name: string;
  readonly statementCount: number;
  readonly statementHash: string;
}

export interface MigrationManifest {
  readonly currentVersion: number;
  readonly entries: readonly MigrationManifestEntry[];
}

export interface MigrationRunReport {
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Empty when the database was already at (or above, within the ceiling) the target version. */
  readonly applied: readonly MigrationManifestEntry[];
}

/** `PRAGMA user_version` is a signed 32-bit integer — the bounds `runMigrationList` asserts before interpolating (V16). */
const MAX_SCHEMA_VERSION = 2_147_483_647;

function toManifestEntry(migration: Migration): MigrationManifestEntry {
  return {
    version: migration.version,
    name: migration.name,
    statementCount: migration.statements.length,
    statementHash: migrationStatementHash(migration),
  };
}

/** `MIGRATIONS.at(-1)` narrowed explicitly before reading `.version` (`noUncheckedIndexedAccess`). */
export function currentSchemaVersion(): number {
  const last = MIGRATIONS.at(-1);
  if (last === undefined) {
    throw new StateStoreError("MIGRATIONS is empty — no schema version is defined");
  }
  return last.version;
}

/** E1 — no database needed; a pure read of the shipped `MIGRATIONS` list. */
export function migrationManifest(): MigrationManifest {
  return {
    currentVersion: currentSchemaVersion(),
    entries: MIGRATIONS.map(toManifestEntry),
  };
}

/**
 * Applies every migration in `migrations` whose version is greater than the
 * database's current `PRAGMA user_version` and no greater than `ceiling`
 * (`targetVersion`, defaulting to the highest version in `migrations`),
 * ascending, one migration per transaction (D2). A database newer than
 * `ceiling` is refused, never guessed, via `SchemaVersionError`.
 */
export function runMigrationList(
  db: StateDatabase,
  migrations: readonly Migration[],
  targetVersion?: number,
): MigrationRunReport {
  const handle = internalHandle(db);
  const fromVersion = readUserVersion(handle);
  // The highest version anywhere in `migrations`, not `migrations.at(-1)` —
  // `pending` below is sorted before use precisely because callers are not
  // required to supply this list pre-sorted, and `.at(-1)` would silently
  // pick whichever entry happens to be last rather than the true ceiling.
  const terminal = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);

  // An explicit `targetVersion` is caller input, validated before it drives
  // anything below (issue #7, Phase 2 fix G5): `NaN` made every subsequent
  // comparison silently false, producing a no-op report indistinguishable
  // from "already current"; a negative value produced a `SchemaVersionError`
  // that named the negative value as "this build's highest known migration
  // version", which is false; and a value above `terminal` applied
  // everything in `migrations` with no signal that the requested ceiling was
  // unreachable.
  if (
    targetVersion !== undefined &&
    (!Number.isInteger(targetVersion) || targetVersion < 0 || targetVersion > terminal)
  ) {
    throw new StateStoreError(
      `targetVersion must be an integer between 0 and ${terminal} (the highest version in the ` +
        `supplied migrations list), got: ${targetVersion}`,
    );
  }

  const ceiling = targetVersion ?? terminal;

  if (fromVersion > ceiling) {
    // Names `currentSchemaVersion()` — the shipped list's terminal version —
    // not the caller's `ceiling`, which may be a deliberately short test
    // list and would otherwise mislabel this build's actual highest known
    // migration version.
    throw new SchemaVersionError(fromVersion, currentSchemaVersion());
  }

  const pending = migrations
    .filter((migration) => migration.version > fromVersion && migration.version <= ceiling)
    .toSorted((a, b) => a.version - b.version);

  const applied: MigrationManifestEntry[] = [];
  for (const migration of pending) {
    const { version } = migration;
    if (!Number.isInteger(version) || version <= 0 || version > MAX_SCHEMA_VERSION) {
      throw new StateStoreError(
        `migration version ${version} is outside the PRAGMA user_version interpolation bounds`,
      );
    }

    // The whole step — every DDL statement plus the version bump — is one
    // transaction (D2), which is what makes AC1's "interrupted" lineage true
    // by construction: a failure partway through leaves `user_version`
    // exactly where it started, with none of the step's objects created.
    let statementIndex = -1;
    try {
      handle.exec("BEGIN IMMEDIATE");

      // Re-read `user_version` now that this connection holds the write
      // lock, not just the pre-transaction read that produced `pending`
      // above (issue #7, Phase 2 fix S2). Two `openStateDatabase` calls on
      // one path are two independent connections, not a shared one (this
      // module's own header comment) — the loser of a race would otherwise
      // find this migration already applied, re-run its DDL against an
      // already-migrated schema, and fail with "table ... already exists"
      // wrapped in a `MigrationError`, where a clean no-op is correct.
      if (migration.version <= readUserVersion(handle)) {
        handle.exec("COMMIT");
        continue;
      }

      for (const [index, statement] of migration.statements.entries()) {
        statementIndex = index;
        handle.exec(statement);
      }
      statementIndex = migration.statements.length;
      // PRAGMA user_version cannot be parameterised (verified: `near "?":
      // syntax error`) — `version` is bounds-asserted immediately above, so
      // this is the one string-built statement in the package and it is
      // auditable at a glance; the value never originates from user input.
      // Run before COMMIT, not after (issue #7, Phase 2 fix S2): `PRAGMA
      // user_version` is fully transactional (verified — it rolls back with
      // an explicit ROLLBACK and commits with an explicit COMMIT exactly
      // like any other write), so running it before COMMIT makes the DDL
      // and the bump one atomic unit. Running it after COMMIT, as a second,
      // separate statement, left a window where the DDL could be durably
      // committed while the bump was not — a state a second connection
      // could then observe and act on incorrectly.
      handle.exec(`PRAGMA user_version = ${version}`);
      handle.exec("COMMIT");
    } catch (error) {
      if (handle.isTransaction) {
        handle.exec("ROLLBACK");
      }
      throw new MigrationError(version, statementIndex, `migration "${migration.name}" failed`, {
        cause: error,
      });
    }
    applied.push(toManifestEntry(migration));
  }

  return { fromVersion, toVersion: readUserVersion(handle), applied };
}

/** `runMigrations(db)` is exactly `runMigrationList(db, MIGRATIONS)` — the shipped list, no ceiling. */
export function runMigrations(db: StateDatabase): MigrationRunReport {
  return runMigrationList(db, MIGRATIONS);
}
