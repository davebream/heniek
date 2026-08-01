/**
 * AC1's comparison object: a two-digest schema fingerprint (design D3).
 *
 * `structural` is lineage-independent — built from PRAGMA introspection
 * (`pragma_table_list`, `pragma_table_xinfo`, `pragma_index_list`,
 * `pragma_index_xinfo`, `pragma_foreign_key_list`) plus the normalised DDL of
 * every trigger and view (which have no PRAGMA introspection of their own).
 * `declared` closes `structural`'s three measured blind spots —
 * `AUTOINCREMENT`, `CHECK`, and column-level `COLLATE` — by hashing the
 * whitespace-normalised `sql` of every schema object, tables included.
 *
 * Rejected forms (measured, not guessed): raw `sqlite_master.sql` equality
 * (an `ALTER`-built table's stored DDL text differs from fresh DDL text for
 * the same logical schema); normalised-DDL-only (still fails the
 * hand-written-equivalent case); `db.serialize()` byte comparison (page
 * images embed free-list layout); structural-only (blind to
 * `CHECK`/`COLLATE`/`AUTOINCREMENT`).
 */

import { createHash } from "node:crypto";
import { internalHandle, type StateDatabase } from "./open.js";
import {
  readApplicationId,
  readForeignKeyList,
  readIndexList,
  readIndexXInfo,
  readSchemaObjects,
  readTableList,
  readTableXInfo,
  readUserVersion,
} from "./pragma.js";

export interface SchemaFingerprint {
  /** Lineage-independent PRAGMA-structural digest. sha256 hex. */
  readonly structural: string;
  /** sha256 hex over whitespace-normalised DDL of every object. */
  readonly declared: string;
  readonly userVersion: number;
  readonly applicationId: number;
}

/** The same normal form as `migrationStatementHash` — collapse whitespace runs, trim. */
function normaliseSql(sql: string | null): string {
  return (sql ?? "").replace(/\s+/g, " ").trim();
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function schemaFingerprint(db: StateDatabase): SchemaFingerprint {
  const handle = internalHandle(db);
  const userVersion = readUserVersion(handle);
  const applicationId = readApplicationId(handle);

  // Part A — structural. A JS array in exactly this order, JSON.stringify'd
  // and sha256'd. Every object literal below is constructed with a fixed key
  // order and every list is already `ORDER BY`ed by its pragma.ts reader, so
  // key order is fixed by construction — never sort at the end, and never
  // run this array through `canonicalize` (that would mask an accidental
  // key-order change instead of exposing it).
  const structuralEntries: unknown[] = [
    ["user_version", userVersion],
    ["application_id", applicationId],
  ];

  for (const table of readTableList(handle)) {
    const indexes = readIndexList(handle, table.name);
    const indexColumns = indexes.map((index) => readIndexXInfo(handle, index.name));
    structuralEntries.push([
      "object",
      {
        name: table.name,
        type: table.type,
        ncol: table.ncol,
        wr: table.wr,
        strict: table.strict,
        columns: readTableXInfo(handle, table.name),
        indexes,
        indexColumns,
        foreignKeys: readForeignKeyList(handle, table.name),
      },
    ]);
  }

  // Triggers and views have no PRAGMA introspection at all, and a view's
  // body lives only in its DDL — that is why exactly these two object
  // classes are compared as normalised text rather than structurally.
  // `readSchemaObjects` already reads `ORDER BY type, name`, so filtering
  // preserves that order.
  for (const object of readSchemaObjects(handle)) {
    if (object.type !== "trigger" && object.type !== "view") {
      continue;
    }
    structuralEntries.push([
      "ddl",
      {
        type: object.type,
        name: object.name,
        tbl: object.tblName,
        sql: normaliseSql(object.sql),
      },
    ]);
  }

  const structural = sha256Hex(JSON.stringify(structuralEntries));

  // Part B — declared. sha256 over the whitespace-normalised `sql` of every
  // `readSchemaObjects` row, tables included, ordered by (type, name),
  // joined by "\n".
  const declaredText = readSchemaObjects(handle)
    .map((object) => normaliseSql(object.sql))
    .join("\n");
  const declared = sha256Hex(declaredText);

  return { structural, declared, userVersion, applicationId };
}
