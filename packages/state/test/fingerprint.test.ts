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

const MIGRATION_1 = MIGRATIONS[0];
if (MIGRATION_1 === undefined) {
  throw new Error("MIGRATIONS must contain at least one migration for this suite to run");
}

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
    expect(freshFingerprint.structural).toBe(pin(MIGRATION_1.version).structural);
    expect(freshFingerprint.declared).toBe(pin(MIGRATION_1.version).declared);

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

      expect(() => runMigrationList(interruptedTemp.db, [doctored])).toThrow();
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

describe("every schema version's fingerprint matches its committed pin (T1)", () => {
  it("version 0 — the empty, unmigrated schema", async () => {
    const temp = await openTempDb();
    try {
      const fingerprint = schemaFingerprint(temp.db);
      expect(fingerprint.structural).toBe(pin(0).structural);
      expect(fingerprint.declared).toBe(pin(0).declared);
    } finally {
      await temp.cleanup();
    }
  });

  it("version 1 — after runMigrations", async () => {
    const temp = await openTempDb();
    try {
      runMigrations(temp.db);
      const fingerprint = schemaFingerprint(temp.db);
      expect(fingerprint.structural).toBe(pin(1).structural);
      expect(fingerprint.declared).toBe(pin(1).declared);
    } finally {
      await temp.cleanup();
    }
  });
});

describe("terminal-schema.sql — the independent, hand-written witness", () => {
  it("its structural digest matches the terminal migrated version; declared is not required to match", async () => {
    const fingerprint = await fingerprintOfHandWritten(TERMINAL_SCHEMA_SQL);
    expect(fingerprint.structural).toBe(pin(MIGRATION_1.version).structural);
    // `declared` is allowed to differ from the migrated lineage's pin — a
    // future squashed baseline could legitimately make them equal, so
    // asserting inequality here is not required either (plan Task 2.6).
  });

  // Task 3.1 adds `ALTER TABLE run_projection ADD COLUMN workspace_id` as
  // migration 3's last statement and converts this into a real assertion
  // (`expect(freshSql).not.toBe(handWrittenSql)`) in the same commit — this
  // phase ships migration 1 only, so there is no ALTER yet to exercise.
  it.todo("literal DDL diverges once migration 3 ALTERs run_projection — Task 3.1");
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
});
