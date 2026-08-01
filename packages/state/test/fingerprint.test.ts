/**
 * The AC1 four-lineage matrix and the discrimination cases (plan Task 2.6,
 * design D3). Fixture pins live in `test/fixtures/schema-fingerprints.json`
 * and `test/fixtures/terminal-schema.sql`, produced the same way as
 * `migrations.test.ts`'s pins: run the suite once, read the actual digests
 * out of the failure output, paste them in.
 *
 * The adopted reading of "four lineages" (round-1 finding C6): *fresh*,
 * *upgraded* and *rolled-forward* are pairwise byte-equal on both digests at
 * the terminal version; the *interrupted* database is asserted equal to the
 * **previous** version's committed pin (it is, by construction, not at the
 * terminal version); AC1's "interrupted" lineage is satisfied by
 * *interrupted-then-rolled-forward* reaching the terminal fingerprint.
 */

import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type SchemaFingerprint, schemaFingerprint } from "../src/database/fingerprint.js";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { MigrationError } from "../src/errors.js";
import { MIGRATIONS } from "../src/migrations/list.js";
import { runMigrationList, runMigrations } from "../src/migrations/migrate.js";
import type { Migration } from "../src/migrations/migration.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

interface FingerprintFixtureEntry {
  readonly structural: string;
  readonly declared: string;
}

const SCHEMA_FINGERPRINTS: Record<string, FingerprintFixtureEntry> = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/schema-fingerprints.json", import.meta.url)),
    "utf8",
  ),
);

const TERMINAL_SCHEMA_SQL = readFileSync(
  fileURLToPath(new URL("./fixtures/terminal-schema.sql", import.meta.url)),
  "utf8",
);

interface SqliteVersionFixture {
  readonly sqlite: string;
  readonly node: string;
  readonly note: string;
}

const SQLITE_VERSION_FIXTURE: SqliteVersionFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/sqlite-version.json", import.meta.url)), "utf8"),
);

const MIGRATION_1 = MIGRATIONS[0];
if (MIGRATION_1 === undefined) {
  throw new Error("MIGRATIONS must contain at least one migration for this suite to run");
}

// Derived, never hand-written (G7): the terminal version is whatever the last
// shipped migration says it is, so appending migration 4 in a later phase
// re-points every "terminal" assertion below automatically instead of leaving
// them silently pinned to an older version.
const TERMINAL_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1];
if (TERMINAL_MIGRATION === undefined) {
  throw new Error("MIGRATIONS must contain at least one migration for this suite to run");
}
const TERMINAL_VERSION = TERMINAL_MIGRATION.version;

function pin(version: number): FingerprintFixtureEntry {
  const entry = SCHEMA_FINGERPRINTS[String(version)];
  if (entry === undefined) {
    throw new Error(`no committed schema-fingerprint pin for version ${version}`);
  }
  return entry;
}

async function openTempDb(): Promise<{
  readonly db: StateDatabase;
  readonly cleanup: () => Promise<void>;
}> {
  const { directory, path } = await makeTempDbPath();
  const db = openStateDatabase({ path, clock: createFakeClock(), ids: createDeterministicIds(1) });
  return {
    db,
    cleanup: async () => {
      db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Runs `sql` — a multi-statement script, possibly containing trigger bodies
 * with their own internal `;` — against a fresh temp db in one `exec` call.
 * `DatabaseSync.exec` wraps `sqlite3_exec`, which tokenises the whole script
 * itself and correctly treats a `CREATE TRIGGER … BEGIN … END;` body as one
 * statement; a naive JS-side `split(";")` would cut a trigger body in half.
 */
async function fingerprintOfHandWritten(sql: string): Promise<SchemaFingerprint> {
  const { db, cleanup } = await openTempDb();
  try {
    const handle: DatabaseSync = internalHandle(db);
    handle.exec(sql);
    return schemaFingerprint(db);
  } finally {
    await cleanup();
  }
}

/**
 * The stored, un-normalised `CREATE TABLE run_projection` text, straight from
 * `sqlite_schema` — the one place this suite looks at raw DDL rather than at a
 * digest of it. Returns `null` if the table is absent, so a caller can assert
 * presence explicitly instead of comparing two silent nulls.
 */
function readRunProjectionDdl(handle: DatabaseSync): string | null {
  const row = handle
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'run_projection'")
    .get();
  if (row === undefined) {
    return null;
  }
  const { sql } = row;
  return typeof sql === "string" ? sql : null;
}

/** Opens two independent temp dbs, builds each with `buildA`/`buildB`, and returns both fingerprints. */
async function fingerprintPair(
  buildA: (handle: DatabaseSync) => void,
  buildB: (handle: DatabaseSync) => void,
): Promise<readonly [SchemaFingerprint, SchemaFingerprint]> {
  const a = await openTempDb();
  const b = await openTempDb();
  try {
    buildA(internalHandle(a.db));
    buildB(internalHandle(b.db));
    return [schemaFingerprint(a.db), schemaFingerprint(b.db)];
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
}

describe("the AC1 four-lineage matrix", () => {
  it("fresh, upgraded and rolled-forward are pairwise byte-equal at the terminal version; interrupted equals the previous version's pin; interrupted-then-rolled-forward reaches the terminal fingerprint", async () => {
    // fresh — one runMigrations call on an empty file.
    const freshTemp = await openTempDb();
    let freshFingerprint: SchemaFingerprint;
    try {
      runMigrations(freshTemp.db);
      freshFingerprint = schemaFingerprint(freshTemp.db);
    } finally {
      await freshTemp.cleanup();
    }

    // upgraded — stop and resume at every intermediate version via
    // runMigrationList(db, MIGRATIONS, v), closing and reopening between
    // stops. Phase 2 ships exactly one migration, so this loop still
    // exercises the stop/resume mechanism generically for Phase 3 onward.
    const upgradedTemp = await makeTempDbPath();
    let upgradedFingerprint: SchemaFingerprint;
    try {
      for (const migration of MIGRATIONS) {
        const db = openStateDatabase({
          path: upgradedTemp.path,
          clock: createFakeClock(),
          ids: createDeterministicIds(1),
        });
        try {
          runMigrationList(db, MIGRATIONS, migration.version);
        } finally {
          db.close();
        }
      }
      const finalDb = openStateDatabase({
        path: upgradedTemp.path,
        clock: createFakeClock(),
        ids: createDeterministicIds(1),
      });
      try {
        upgradedFingerprint = schemaFingerprint(finalDb);
      } finally {
        finalDb.close();
      }
    } finally {
      await rm(upgradedTemp.directory, { recursive: true, force: true });
    }

    expect(upgradedFingerprint).toStrictEqual(freshFingerprint);
    expect(freshFingerprint.structural).toBe(pin(TERMINAL_VERSION).structural);
    expect(freshFingerprint.declared).toBe(pin(TERMINAL_VERSION).declared);

    // interrupted — target version 1 (the first migration) with its last
    // statement replaced to throw mid-step; the fingerprint must equal the
    // *previous* version's committed pin (version 0), not the terminal one.
    const interruptedTemp = await openTempDb();
    let interruptedFingerprint: SchemaFingerprint;
    let rolledForwardFingerprint: SchemaFingerprint;
    try {
      const doctored: Migration = {
        version: MIGRATION_1.version,
        name: MIGRATION_1.name,
        statements: [...MIGRATION_1.statements.slice(0, -1), "THIS IS NOT VALID SQL"],
      };

      expect(() => runMigrationList(interruptedTemp.db, [doctored])).toThrow(MigrationError);
      interruptedFingerprint = schemaFingerprint(interruptedTemp.db);
      expect(interruptedFingerprint.structural).toBe(pin(0).structural);
      expect(interruptedFingerprint.declared).toBe(pin(0).declared);

      // rolled-forward — re-run runMigrations on the SAME interrupted
      // database (not a fresh one): the concrete "interrupted → rolled
      // forward" step AC1 requires.
      runMigrations(interruptedTemp.db);
      rolledForwardFingerprint = schemaFingerprint(interruptedTemp.db);
    } finally {
      await interruptedTemp.cleanup();
    }

    expect(rolledForwardFingerprint).toStrictEqual(freshFingerprint);
  });
});

// [0, ...MIGRATIONS.map(m => m.version)] — derived, not hand-listed (G7): a
// migration appended in a later phase automatically gets a case here rather
// than silently staying unpinned until someone remembers to add one by hand.
const PINNED_VERSIONS: readonly number[] = [0, ...MIGRATIONS.map((migration) => migration.version)];

describe("every schema version's fingerprint matches its committed pin (T1)", () => {
  it.each(PINNED_VERSIONS)("version %i", async (version) => {
    const temp = await openTempDb();
    try {
      if (version > 0) {
        runMigrationList(temp.db, MIGRATIONS, version);
      }
      const fingerprint = schemaFingerprint(temp.db);
      expect(fingerprint.structural).toBe(pin(version).structural);
      expect(fingerprint.declared).toBe(pin(version).declared);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("recorded SQLite/Node version alongside the fingerprint pins (G7)", () => {
  it("test/fixtures/sqlite-version.json is present and well-formed", () => {
    // Not an equality assertion against `process.versions.sqlite` on
    // purpose: a Node/SQLite bump legitimately changes `declared` (see this
    // fixture's own `note`), and a hard version-lock here would turn that
    // expected, documented event into a spurious suite failure instead of
    // the diagnostic breadcrumb it is meant to be.
    expect(SQLITE_VERSION_FIXTURE.sqlite.length).toBeGreaterThan(0);
    expect(SQLITE_VERSION_FIXTURE.node.length).toBeGreaterThan(0);
    if (SQLITE_VERSION_FIXTURE.sqlite !== process.versions.sqlite) {
      console.warn(
        `test/fixtures/sqlite-version.json records SQLite ${SQLITE_VERSION_FIXTURE.sqlite}, ` +
          `but this run's node:sqlite reports ${process.versions.sqlite}. If a fingerprint pin ` +
          "just failed, this is the expected cause — see this fixture's note.",
      );
    }
  });
});

describe("terminal-schema.sql — the independent, hand-written witness", () => {
  it("its structural digest matches the terminal migrated version — the ALTER is invisible to PRAGMA introspection (G1)", async () => {
    const fingerprint = await fingerprintOfHandWritten(TERMINAL_SCHEMA_SQL);
    // This is the assertion the hand-written witness exists for. `structural`
    // reads normalised PRAGMA introspection, which records only *what* the
    // schema is, never *how* it got there — so a `run_projection` whose
    // `workspace_id` arrived by `ALTER TABLE … ADD COLUMN` (migration 3) must
    // be indistinguishable from this fixture's fresh inline `CREATE`, even
    // though the fixture's formatting and statement ordering are deliberately
    // different. A real content divergence (a dropped `STRICT`, a changed
    // `NOT NULL`, a missing FK, a reordered column) trips this immediately.
    //
    // The column-order caveat is load-bearing (finding C2): `readTableXInfo`
    // reads `ORDER BY cid` and an `ALTER`-appended column always takes the
    // highest `cid`, which is exactly why the fixture must place
    // `workspace_id` last in `run_projection`'s column list.
    expect(fingerprint.structural).toBe(pin(TERMINAL_VERSION).structural);
  });

  it("its declared digest does NOT match, because declared hashes stored DDL text and the ALTER rewrote it (G1a, Task 3.1)", async () => {
    const fingerprint = await fingerprintOfHandWritten(TERMINAL_SCHEMA_SQL);
    // The deliberate asymmetry, and the reason two digests exist at all
    // (plan Task 3.1: the inline-vs-`ALTER` difference "is precisely what the
    // structural digest must see through and the declared digest must not").
    //
    // Through version 1 these two digests agreed, because migration 1 is all
    // fresh `CREATE`s and the shared normal form (collapse whitespace runs,
    // trim, sort by (type, name)) erased every formatting difference between
    // the fixture and the migration DDL. Migration 3's `ALTER TABLE
    // run_projection ADD COLUMN workspace_id TEXT` breaks that: SQLite
    // rewrites the stored `CREATE TABLE run_projection` text by splicing
    // `, workspace_id TEXT` in ahead of the closing paren, which normalises
    // to `… updated_at TEXT NOT NULL , workspace_id TEXT) STRICT` — text no
    // hand-written inline `CREATE` would ever produce. Asserting inequality
    // *positively* is what keeps this honest: if a future refactor made the
    // migrated and hand-written DDL text converge, this test fails loudly
    // rather than silently weakening into a tautology.
    expect(fingerprint.declared).not.toBe(pin(TERMINAL_VERSION).declared);
  });

  it("the literal, un-normalised run_projection DDL differs between the migrated lineage and the hand-written fixture (Task 3.1 — was it.todo through Phase 2)", async () => {
    const migratedTemp = await openTempDb();
    let migratedSql: string | null;
    try {
      runMigrations(migratedTemp.db);
      migratedSql = readRunProjectionDdl(internalHandle(migratedTemp.db));
    } finally {
      await migratedTemp.cleanup();
    }

    const handWrittenTemp = await openTempDb();
    let handWrittenSql: string | null;
    try {
      internalHandle(handWrittenTemp.db).exec(TERMINAL_SCHEMA_SQL);
      handWrittenSql = readRunProjectionDdl(internalHandle(handWrittenTemp.db));
    } finally {
      await handWrittenTemp.cleanup();
    }

    // Both must actually exist — otherwise `null !== null` would be a vacuous
    // pass and this case would prove nothing.
    expect(migratedSql).not.toBeNull();
    expect(handWrittenSql).not.toBeNull();
    expect(migratedSql).not.toBe(handWrittenSql);
    // Pin the *reason* rather than just the inequality: the migrated text
    // carries SQLite's spliced-in ALTER fragment, the hand-written one has
    // `workspace_id` as an ordinary inline column.
    expect(migratedSql).toContain(", workspace_id TEXT)");
    expect(handWrittenSql).not.toContain(", workspace_id TEXT)");
  });
});

describe("discrimination cases (D3, D17, R1) — matched pairs differing in exactly one feature", () => {
  it("structural differs for NOT NULL", async () => {
    const [a, b] = await fingerprintPair(
      (handle) => handle.exec("CREATE TABLE t (a INTEGER) STRICT"),
      (handle) => handle.exec("CREATE TABLE t (a INTEGER NOT NULL) STRICT"),
    );
    expect(a.structural).not.toBe(b.structural);
  });

  it("structural differs for DEFAULT", async () => {
    const [a, b] = await fingerprintPair(
      (handle) => handle.exec("CREATE TABLE t (a INTEGER) STRICT"),
      (handle) => handle.exec("CREATE TABLE t (a INTEGER DEFAULT 0) STRICT"),
    );
    expect(a.structural).not.toBe(b.structural);
  });

  it("structural differs for UNIQUE", async () => {
    const [a, b] = await fingerprintPair(
      (handle) => handle.exec("CREATE TABLE t (a INTEGER) STRICT"),
      (handle) => handle.exec("CREATE TABLE t (a INTEGER UNIQUE) STRICT"),
    );
    expect(a.structural).not.toBe(b.structural);
  });

  it("structural differs for ON DELETE", async () => {
    const [a, b] = await fingerprintPair(
      (handle) => {
        handle.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT");
        handle.exec("CREATE TABLE t (a INTEGER REFERENCES parent(id)) STRICT");
      },
      (handle) => {
        handle.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT");
        handle.exec("CREATE TABLE t (a INTEGER REFERENCES parent(id) ON DELETE CASCADE) STRICT");
      },
    );
    expect(a.structural).not.toBe(b.structural);
  });

  it("structural differs for a generated column", async () => {
    const [a, b] = await fingerprintPair(
      (handle) => handle.exec("CREATE TABLE t (a INTEGER, b INTEGER) STRICT"),
      (handle) =>
        handle.exec("CREATE TABLE t (a INTEGER, b INTEGER GENERATED ALWAYS AS (a + 1)) STRICT"),
    );
    expect(a.structural).not.toBe(b.structural);
  });

  it("structural differs for STRICT", async () => {
    const [a, b] = await fingerprintPair(
      (handle) => handle.exec("CREATE TABLE t (a INTEGER)"),
      (handle) => handle.exec("CREATE TABLE t (a INTEGER) STRICT"),
    );
    expect(a.structural).not.toBe(b.structural);
  });

  it("structural differs for WITHOUT ROWID", async () => {
    const [a, b] = await fingerprintPair(
      (handle) => handle.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)"),
      (handle) => handle.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT) WITHOUT ROWID"),
    );
    expect(a.structural).not.toBe(b.structural);
  });

  it("structural differs for a partial vs total index", async () => {
    const [a, b] = await fingerprintPair(
      (handle) => {
        handle.exec("CREATE TABLE t (a INTEGER)");
        handle.exec("CREATE INDEX t_a ON t (a)");
      },
      (handle) => {
        handle.exec("CREATE TABLE t (a INTEGER)");
        handle.exec("CREATE INDEX t_a ON t (a) WHERE a IS NOT NULL");
      },
    );
    expect(a.structural).not.toBe(b.structural);
  });

  it("structural is equal but declared differs for CHECK", async () => {
    const [a, b] = await fingerprintPair(
      (handle) => handle.exec("CREATE TABLE t (a INTEGER) STRICT"),
      (handle) => handle.exec("CREATE TABLE t (a INTEGER CHECK (a > 0)) STRICT"),
    );
    expect(a.structural).toBe(b.structural);
    expect(a.declared).not.toBe(b.declared);
  });

  it("structural is equal but declared differs for column-level COLLATE", async () => {
    const [a, b] = await fingerprintPair(
      (handle) => handle.exec("CREATE TABLE t (a TEXT) STRICT"),
      (handle) => handle.exec("CREATE TABLE t (a TEXT COLLATE NOCASE) STRICT"),
    );
    expect(a.structural).toBe(b.structural);
    expect(a.declared).not.toBe(b.declared);
  });

  // Deferred to Phase 3 (Phase 2 fix supplement, G7 blind-spot list item 1,
  // via `fingerprint.ts`'s own header comment): `AUTOINCREMENT` is banned
  // outright from `MIGRATIONS` by `assertAppendOnly` (design D3), so this
  // case necessarily goes through `fingerprintPair`'s raw-schema helper
  // rather than through any shipped migration — there is no way to exercise
  // it via `MIGRATIONS` at all. Measured directly (this suite's own probe):
  // neither `pragma_table_xinfo` nor `pragma_table_list.strict` records
  // whether a rowid-alias column carries `AUTOINCREMENT` — both are
  // byte-identical with and without it — so `structural` is blind to it
  // exactly like `CHECK` and `COLLATE` above, and only `declared` (which
  // hashes the stored DDL text) sees it.
  it("structural is equal but declared differs for AUTOINCREMENT", async () => {
    const [a, b] = await fingerprintPair(
      (handle) => handle.exec("CREATE TABLE t (a INTEGER PRIMARY KEY) STRICT"),
      (handle) => handle.exec("CREATE TABLE t (a INTEGER PRIMARY KEY AUTOINCREMENT) STRICT"),
    );
    expect(a.structural).toBe(b.structural);
    expect(a.declared).not.toBe(b.declared);
  });

  it("both digests are independent of table creation order (G7 — true by construction via ORDER BY name, exercised here for real)", async () => {
    const [a, b] = await fingerprintPair(
      (handle) => {
        handle.exec("CREATE TABLE alpha (a INTEGER) STRICT");
        handle.exec("CREATE TABLE beta (b INTEGER) STRICT");
      },
      (handle) => {
        handle.exec("CREATE TABLE beta (b INTEGER) STRICT");
        handle.exec("CREATE TABLE alpha (a INTEGER) STRICT");
      },
    );
    expect(a).toStrictEqual(b);
  });
});
