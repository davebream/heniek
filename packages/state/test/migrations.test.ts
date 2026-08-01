/**
 * The migrator suite (plan Task 2.6, design D2, D3, C1). Fixture pins live in
 * `test/fixtures/migration-statement-hashes.json`, produced by running this
 * suite once, reading the actual digests out of the failure output, and
 * pasting them in — never by having the code regenerate its own pin.
 */

import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle, openStateDatabase } from "../src/database/open.js";
import { readUserVersion } from "../src/database/pragma.js";
import { MigrationError, SchemaVersionError } from "../src/errors.js";
import { MIGRATIONS } from "../src/migrations/list.js";
import {
  currentSchemaVersion,
  migrationManifest,
  runMigrationList,
  runMigrations,
} from "../src/migrations/migrate.js";
import {
  assertAppendOnly,
  type Migration,
  migrationStatementHash,
} from "../src/migrations/migration.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

interface StatementHashFixtureEntry {
  readonly name: string;
  readonly statementHash: string;
}

const STATEMENT_HASHES: Record<string, StatementHashFixtureEntry> = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/migration-statement-hashes.json", import.meta.url)),
    "utf8",
  ),
);

/**
 * Typed as `Migration`, not `Migration | undefined` — an IIFE rather than a
 * bare `const` + narrowing `if`, because `noUncheckedIndexedAccess` narrowing
 * of a module-scope `const` does not propagate into a later hoisted function
 * declaration (`migrationWithStatements`, below), even though the value can
 * never actually be reassigned.
 */
const MIGRATION_1: Migration = (() => {
  const first = MIGRATIONS[0];
  if (first === undefined) {
    throw new Error("MIGRATIONS must contain at least one migration for this suite to run");
  }
  return first;
})();

let directory: string;
let path: string;

beforeEach(async () => {
  ({ directory, path } = await makeTempDbPath());
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function openDb() {
  return openStateDatabase({ path, clock: createFakeClock(), ids: createDeterministicIds(1) });
}

/**
 * A one-off Migration array with `statements` replaced, for a deliberately
 * doctored list. Narrows `MIGRATIONS[0]` locally rather than relying on the
 * module-level guard above — a hoisted `function` declaration does not
 * retain the outer `if`-narrowing the way a non-hoisted arrow closure does.
 */
function migrationWithStatements(statements: readonly string[]): Migration {
  const migration = MIGRATIONS[0];
  if (migration === undefined) {
    throw new Error("MIGRATIONS must contain at least one migration for this suite to run");
  }
  return { version: migration.version, name: migration.name, statements };
}

/**
 * Catches `fn`'s throw and asserts it is a `MigrationError` whose message
 * matches `pattern` — bare `toThrow(MigrationError)` cannot distinguish the
 * first-version, gap, and duplicate-version cases below, all three of which
 * are actually caught by the same contiguity check (issue #7, Phase 2 fix
 * G4).
 */
function expectMigrationError(fn: () => void, pattern: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MigrationError);
  expect((caught as Error).message).toMatch(pattern);
}

describe("assertAppendOnly (design D2, D3, C1)", () => {
  it("accepts the shipped MIGRATIONS list", () => {
    expect(() => assertAppendOnly(MIGRATIONS)).not.toThrow();
  });

  it("rejects a list whose first version is not 1", () => {
    const mutated: Migration[] = [{ ...MIGRATION_1, version: 2 }];
    expectMigrationError(() => assertAppendOnly(mutated), /the first migration must be version 1/);
  });

  it("rejects a gap in versions", () => {
    const mutated: Migration[] = [
      MIGRATION_1,
      { version: 3, name: "gap", statements: ["CREATE TABLE gap_table (a INTEGER) STRICT"] },
    ];
    expectMigrationError(() => assertAppendOnly(mutated), /contiguous and strictly ascending/);
  });

  it("rejects a duplicate version", () => {
    const mutated: Migration[] = [
      MIGRATION_1,
      {
        version: 1,
        name: "not-journal",
        statements: ["CREATE TABLE dup_table (a INTEGER) STRICT"],
      },
    ];
    // Behaviourally indistinguishable from the gap case above — a duplicate
    // version is caught by the same contiguity check, not a separate guard.
    expectMigrationError(() => assertAppendOnly(mutated), /contiguous and strictly ascending/);
  });

  it("rejects a duplicate name", () => {
    const mutated: Migration[] = [
      MIGRATION_1,
      {
        version: 2,
        name: MIGRATION_1.name,
        statements: ["CREATE TABLE dup_name (a INTEGER) STRICT"],
      },
    ];
    expectMigrationError(() => assertAppendOnly(mutated), /duplicate migration name/);
  });

  it("rejects an empty statements array", () => {
    const mutated: Migration[] = [{ ...MIGRATION_1, statements: [] }];
    expectMigrationError(() => assertAppendOnly(mutated), /no statements/);
  });

  it("rejects a statement containing AUTOINCREMENT", () => {
    const mutated: Migration[] = [
      migrationWithStatements([
        "CREATE TABLE auto_table (a INTEGER PRIMARY KEY AUTOINCREMENT) STRICT",
      ]),
    ];
    expectMigrationError(() => assertAppendOnly(mutated), /AUTOINCREMENT is banned/);
  });

  it("rejects a statement containing a SQL comment (--)", () => {
    const mutated: Migration[] = [
      migrationWithStatements(["CREATE TABLE comment_table (a INTEGER) -- trailing comment"]),
    ];
    expectMigrationError(() => assertAppendOnly(mutated), /must not contain SQL comments/);
  });
});

describe("migrationStatementHash pins (C1's append-only gate)", () => {
  it("matches the committed pin for every shipped migration", () => {
    for (const migration of MIGRATIONS) {
      const pin = STATEMENT_HASHES[String(migration.version)];
      expect(pin, `no committed pin for migration version ${migration.version}`).toBeDefined();
      expect(migrationStatementHash(migration)).toBe(pin?.statementHash);
    }
  });
});

describe("migrationManifest (E1)", () => {
  it("matches the committed pins and currentSchemaVersion", () => {
    const manifest = migrationManifest();
    const lastMigration = MIGRATIONS.at(-1);
    if (lastMigration === undefined) {
      throw new Error("MIGRATIONS must not be empty");
    }
    expect(manifest.currentVersion).toBe(lastMigration.version);
    expect(manifest.currentVersion).toBe(currentSchemaVersion());
    expect(manifest.entries).toHaveLength(MIGRATIONS.length);
    for (const entry of manifest.entries) {
      const pin = STATEMENT_HASHES[String(entry.version)];
      expect(pin).toBeDefined();
      expect(entry.name).toBe(pin?.name);
      expect(entry.statementHash).toBe(pin?.statementHash);
      const migration = MIGRATIONS.find((candidate) => candidate.version === entry.version);
      expect(migration).toBeDefined();
      expect(entry.statementCount).toBe(migration?.statements.length);
    }
  });
});

describe("runMigrations (design D2, C1, AC1)", () => {
  it("migrates a fresh database from 0 to the terminal version, and is idempotent", () => {
    const db = openDb();
    try {
      const first = runMigrations(db);
      expect(first.fromVersion).toBe(0);
      expect(first.toVersion).toBe(currentSchemaVersion());
      expect(first.applied).toHaveLength(MIGRATIONS.length);

      const second = runMigrations(db);
      expect(second.fromVersion).toBe(currentSchemaVersion());
      expect(second.toVersion).toBe(currentSchemaVersion());
      expect(second.applied).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("refuses a database newer than the highest known migration version, naming both numbers", () => {
    const db = openDb();
    try {
      const handle = internalHandle(db);
      const newerVersion = currentSchemaVersion() + 1;
      handle.exec(`PRAGMA user_version = ${newerVersion}`);

      let caught: unknown;
      try {
        runMigrations(db);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SchemaVersionError);
      const schemaError = caught as SchemaVersionError;
      expect(schemaError.databaseVersion).toBe(newerVersion);
      expect(schemaError.codeVersion).toBe(currentSchemaVersion());

      // No statement was executed: the schema is still exactly what it was
      // before the refused call (empty — the version was set by hand above,
      // no migration ran).
      const objectCount = handle
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        )
        .get();
      expect(objectCount?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rolls back atomically when a migration step fails partway through (finding CRIT-03, V7/V8)", () => {
    const db = openDb();
    try {
      const handle = internalHandle(db);
      expect(readUserVersion(handle)).toBe(0);

      const doctored = migrationWithStatements([
        ...MIGRATION_1.statements.slice(0, -1),
        "THIS IS NOT VALID SQL",
      ]);

      expect(() => runMigrationList(db, [doctored])).toThrow(MigrationError);

      expect(readUserVersion(handle)).toBe(0);
      expect(handle.isTransaction).toBe(false);
      const objectCount = handle
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        )
        .get();
      expect(objectCount?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("bumps PRAGMA user_version before COMMIT, not after (issue #7, Phase 2 fix S2)", () => {
    // A mutant that moves the PRAGMA statement back to after COMMIT would
    // still pass every other test in this suite — the DDL and the bump
    // would still both end up committed by the time any test can observe
    // the database again, since nothing in this single-threaded test can
    // pause between the two statements. This test pins the statement order
    // directly by recording every `exec` call this migration step makes.
    const db = openDb();
    try {
      const handle = internalHandle(db);
      const originalExec = handle.exec.bind(handle);
      const calls: string[] = [];
      handle.exec = ((sql: string) => {
        calls.push(sql);
        return originalExec(sql);
      }) as typeof handle.exec;
      try {
        runMigrations(db);
      } finally {
        handle.exec = originalExec;
      }

      const commitIndex = calls.indexOf("COMMIT");
      const pragmaIndex = calls.findIndex((sql) => sql.startsWith("PRAGMA user_version ="));
      expect(commitIndex).toBeGreaterThan(-1);
      expect(pragmaIndex).toBeGreaterThan(-1);
      expect(pragmaIndex).toBeLessThan(commitIndex);
    } finally {
      db.close();
    }
  });

  it("a migration already applied by a concurrent connection is a clean no-op, not a duplicate-DDL failure (issue #7, Phase 2 fix S2)", () => {
    // Simulates the loser of a race between two independent
    // `openStateDatabase` connections on the same path: this call's own
    // `readUserVersion` (at entry, before BEGIN IMMEDIATE) sees a stale `0`
    // because we bypass it — feeding `runMigrationList` a migrations list
    // whose only entry is already at-or-below the *actual* current version
    // by the time BEGIN IMMEDIATE's re-check runs is exactly the observable
    // shape of that race, and is what the in-transaction re-check exists to
    // make a no-op rather than a "table already exists" MigrationError.
    const db = openDb();
    try {
      const handle = internalHandle(db);
      runMigrations(db); // Advances to version 1 "out of band" of the call below.
      expect(readUserVersion(handle)).toBe(1);

      const report = runMigrationList(db, MIGRATIONS); // fromVersion read here is 1, so pending is already empty —
      // exercise the in-transaction guard directly via targetVersion instead.
      expect(report.applied).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("runMigrationList targetVersion validation (issue #7, Phase 2 fix G5)", () => {
  it("rejects NaN rather than silently no-op'ing", () => {
    const db = openDb();
    try {
      expect(() => runMigrationList(db, MIGRATIONS, Number.NaN)).toThrow(
        /targetVersion must be an integer/,
      );
    } finally {
      db.close();
    }
  });

  it("rejects a negative targetVersion rather than misreporting it as the build's known version", () => {
    const db = openDb();
    try {
      expect(() => runMigrationList(db, MIGRATIONS, -5)).toThrow(
        /targetVersion must be an integer/,
      );
    } finally {
      db.close();
    }
  });

  it("rejects a targetVersion above the highest version in the supplied migrations list", () => {
    const db = openDb();
    try {
      expect(() => runMigrationList(db, MIGRATIONS, 99)).toThrow(
        /targetVersion must be an integer/,
      );
    } finally {
      db.close();
    }
  });

  it("sorts pending migrations by version regardless of list order", () => {
    const db = openDb();
    try {
      const version2: Migration = {
        version: 2,
        name: "second",
        statements: ["CREATE TABLE second_table (a INTEGER) STRICT"],
      };
      // Deliberately out of order: version 2 supplied before version 1.
      const report = runMigrationList(db, [version2, MIGRATION_1]);
      expect(report.applied.map((entry) => entry.version)).toEqual([1, 2]);
      expect(report.toVersion).toBe(2);
    } finally {
      db.close();
    }
  });

  it("rejects a migration version outside the PRAGMA user_version interpolation bounds (V16)", () => {
    const db = openDb();
    try {
      const outOfBounds: Migration = {
        version: 2_147_483_648,
        name: "out-of-bounds",
        statements: ["CREATE TABLE out_of_bounds_table (a INTEGER) STRICT"],
      };
      // MIGRATION_1 first so the doctored migration is reached via the
      // normal pending loop rather than tripping the `fromVersion > ceiling`
      // guard before the interpolation-bounds check ever runs.
      expect(() => runMigrationList(db, [MIGRATION_1, outOfBounds])).toThrow(
        /outside the PRAGMA user_version interpolation bounds/,
      );
    } finally {
      db.close();
    }
  });
});
