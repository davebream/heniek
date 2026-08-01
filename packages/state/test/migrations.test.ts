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

describe("assertAppendOnly (design D2, D3, C1)", () => {
  it("accepts the shipped MIGRATIONS list", () => {
    expect(() => assertAppendOnly(MIGRATIONS)).not.toThrow();
  });

  it("rejects a list whose first version is not 1", () => {
    const mutated: Migration[] = [{ ...MIGRATION_1, version: 2 }];
    expect(() => assertAppendOnly(mutated)).toThrow(MigrationError);
  });

  it("rejects a gap in versions", () => {
    const mutated: Migration[] = [
      MIGRATION_1,
      { version: 3, name: "gap", statements: ["CREATE TABLE gap_table (a INTEGER) STRICT"] },
    ];
    expect(() => assertAppendOnly(mutated)).toThrow(MigrationError);
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
    expect(() => assertAppendOnly(mutated)).toThrow(MigrationError);
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
    expect(() => assertAppendOnly(mutated)).toThrow(MigrationError);
  });

  it("rejects an empty statements array", () => {
    const mutated: Migration[] = [{ ...MIGRATION_1, statements: [] }];
    expect(() => assertAppendOnly(mutated)).toThrow(MigrationError);
  });

  it("rejects a statement containing AUTOINCREMENT", () => {
    const mutated: Migration[] = [
      migrationWithStatements([
        "CREATE TABLE auto_table (a INTEGER PRIMARY KEY AUTOINCREMENT) STRICT",
      ]),
    ];
    expect(() => assertAppendOnly(mutated)).toThrow(MigrationError);
  });

  it("rejects a statement containing a SQL comment (--)", () => {
    const mutated: Migration[] = [
      migrationWithStatements(["CREATE TABLE comment_table (a INTEGER) -- trailing comment"]),
    ];
    expect(() => assertAppendOnly(mutated)).toThrow(MigrationError);
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
});
