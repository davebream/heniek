/**
 * Issue #7, Phase 1 fix F7: `readTableList`, `readTableXInfo`, `readIndexList`,
 * `readIndexXInfo`, `readForeignKeyList`, and `readSchemaObjects` had zero
 * execution coverage — referenced by no `src/` file and no test — so a SQL
 * syntax or column-name error in any of them would not surface until
 * Phase 5's fingerprint, four commits downstream. This builds a small
 * adversarial schema in a temp database and pins all six readers' output
 * against it, including the `NOT LIKE 'sqlite\_%' ESCAPE '\'` fix: a table
 * literally named `sqliteXtrap` (matching the *unescaped* `sqlite_%`
 * pattern's wildcard `_`, but not the literal-underscore corrected one)
 * must appear in the results.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readForeignKeyList,
  readIndexList,
  readIndexXInfo,
  readSchemaObjects,
  readTableList,
  readTableXInfo,
} from "../src/database/pragma.js";

let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "heniek-state-"));
  const path = join(directory, "state.sqlite");
  db = new DatabaseSync(path);

  // WITHOUT ROWID table.
  db.exec("CREATE TABLE wr_table (id INTEGER PRIMARY KEY, val TEXT) WITHOUT ROWID;");
  // STRICT table.
  db.exec("CREATE TABLE strict_table (id INTEGER PRIMARY KEY, val TEXT) STRICT;");
  // A table whose name would be wrongly excluded by an unescaped
  // `NOT LIKE 'sqlite_%'` filter (the `_` matches the literal `X`).
  db.exec("CREATE TABLE sqliteXtrap (id INTEGER PRIMARY KEY);");
  // Ordinary table with a foreign key, feeding an expression index, a
  // partial index, and a view.
  db.exec(
    "CREATE TABLE main_table (" +
      "id INTEGER PRIMARY KEY, name TEXT, wr_id INTEGER, " +
      "FOREIGN KEY (wr_id) REFERENCES wr_table(id));",
  );
  db.exec("CREATE VIEW v_view AS SELECT id, name FROM main_table;");
  db.exec("CREATE INDEX idx_expr ON main_table(lower(name));");
  db.exec("CREATE INDEX idx_partial ON main_table(name) WHERE name IS NOT NULL;");
  // A table whose name embeds both `%` and `'`.
  db.exec(`CREATE TABLE "weird%name's" (id INTEGER PRIMARY KEY, val TEXT);`);
  // A foreign key using the idiomatic short form with no explicit parent
  // column — SQLite implicitly targets `wr_table`'s primary key, and
  // `pragma_foreign_key_list.to` reports NULL for it (issue #7, fix B5).
  db.exec(
    "CREATE TABLE short_fk_table (id INTEGER PRIMARY KEY, wr_id INTEGER REFERENCES wr_table);",
  );
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe("pragma introspection readers pinned against an adversarial schema (issue #7, Phase 1 fix F7)", () => {
  it("readTableList includes a table matching the unescaped LIKE wildcard, and reports wr/strict correctly", () => {
    const tables = readTableList(db);
    const names = tables.map((row) => row.name);

    // The load-bearing assertion for the LIKE-escaping fix: with the buggy
    // `NOT LIKE 'sqlite_%'` filter, "sqliteXtrap" is wrongly excluded
    // because `_` matches any single character, including the literal `X`.
    expect(names).toContain("sqliteXtrap");
    expect(names).toContain(`weird%name's`);
    expect(names).toContain("main_table");

    const view = tables.find((row) => row.name === "v_view");
    expect(view?.type).toBe("view"); // pragma_table_list lists views too, distinguished by `type`

    const wrTable = tables.find((row) => row.name === "wr_table");
    expect(wrTable?.wr).toBe(1);

    const strictTable = tables.find((row) => row.name === "strict_table");
    expect(strictTable?.strict).toBe(1);

    const mainTable = tables.find((row) => row.name === "main_table");
    expect(mainTable?.wr).toBe(0);
    expect(mainTable?.strict).toBe(0);
  });

  it("readTableXInfo returns main_table's columns in cid order", () => {
    const columns = readTableXInfo(db, "main_table");
    expect(columns.map((column) => column.name)).toEqual(["id", "name", "wr_id"]);
    expect(columns.map((column) => column.cid)).toEqual([0, 1, 2]);
  });

  it("readIndexList lists both the expression and the partial index on main_table", () => {
    const indexes = readIndexList(db, "main_table");
    const names = indexes.map((row) => row.name);
    expect(names).toContain("idx_expr");
    expect(names).toContain("idx_partial");

    const partial = indexes.find((row) => row.name === "idx_partial");
    expect(partial?.partial).toBe(1);

    const expr = indexes.find((row) => row.name === "idx_expr");
    expect(expr?.partial).toBe(0);
  });

  it("readIndexXInfo reads a NULL column name for an expression index, and a real one for a partial index", () => {
    const exprColumns = readIndexXInfo(db, "idx_expr");
    // pragma_index_xinfo.name is NULL for an expression index column — this
    // is what forces `readIndexXInfo` to use `toNullableText`, not `toText`.
    expect(exprColumns[0]?.name).toBeNull();

    const partialColumns = readIndexXInfo(db, "idx_partial");
    expect(partialColumns[0]?.name).toBe("name");
  });

  it("readForeignKeyList reads main_table's foreign key to wr_table", () => {
    const foreignKeys = readForeignKeyList(db, "main_table");
    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0]).toMatchObject({ table: "wr_table", from: "wr_id", to: "id" });
  });

  it("readForeignKeyList narrows to null (not throw) for a column-less REFERENCES (issue #7, fix B5)", () => {
    const foreignKeys = readForeignKeyList(db, "short_fk_table");
    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0]?.to).toBeNull();
    expect(foreignKeys[0]?.table).toBe("wr_table");
  });

  it("readSchemaObjects includes the view, the sqlite_%-shaped table name, and the %/' table, all with correct sql", () => {
    const objects = readSchemaObjects(db);
    const names = objects.map((row) => row.name);

    expect(names).toContain("sqliteXtrap"); // same LIKE-escaping fix, exercised via sqlite_schema this time
    expect(names).toContain(`weird%name's`);

    const view = objects.find((row) => row.name === "v_view");
    expect(view?.type).toBe("view");
    expect(view?.sql).toContain("SELECT");

    const weirdTable = objects.find((row) => row.name === `weird%name's`);
    expect(weirdTable?.type).toBe("table");
    expect(weirdTable?.sql).toContain(`weird%name's`);
  });
});
