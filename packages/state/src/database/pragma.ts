import type { DatabaseSync } from "node:sqlite";
import { StateStoreError } from "../errors.js";

/**
 * This module is the single place where a raw `node:sqlite` row (typed
 * `Record<string, SQLOutputValue>` by `@types/node`, where `SQLOutputValue =
 * null | number | bigint | string | NonSharedUint8Array`) becomes a typed JS
 * value. Nothing else in `@heniek/state` may narrow a raw row by hand
 * (design D3, D4, plan §0.4 trap 7).
 */

export type SqlValue = null | number | bigint | string | Uint8Array;

export interface TableListRow {
  readonly name: string;
  readonly type: string;
  readonly ncol: number;
  readonly wr: number;
  readonly strict: number;
}

export interface ColumnRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dfltValue: string | null;
  readonly pk: number;
  readonly hidden: number;
}

export interface IndexRow {
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
  readonly partial: number;
}

export interface IndexColumnRow {
  readonly seqno: number;
  readonly cid: number;
  readonly name: string | null;
  readonly desc: number;
  readonly coll: string;
  readonly key: number;
}

export interface ForeignKeyRow {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
}

export interface SchemaObjectRow {
  readonly type: string;
  readonly name: string;
  readonly tblName: string;
  readonly sql: string | null;
}

/** D4's safe-integer boundary assertion. Accepts number|bigint, throws StateStoreError otherwise. */
export function toSafeInteger(value: unknown, what: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new StateStoreError(`${what} is not a safe integer: ${value}`);
    }
    return value;
  }
  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new StateStoreError(`${what} is outside the safe integer range: ${value}`);
    }
    return Number(value);
  }
  throw new StateStoreError(`${what} is not a number or bigint (got ${typeof value})`);
}

/** Narrows a raw row value to a non-null string, or throws `StateStoreError` naming `what`. */
export function toText(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new StateStoreError(`${what} is not a string (got ${typeof value})`);
  }
  return value;
}

/** Narrows a raw row value to a string or `null`, or throws `StateStoreError` naming `what`. */
export function toNullableText(value: unknown, what: string): string | null {
  if (value === null) {
    return null;
  }
  return toText(value, what);
}

function get(db: DatabaseSync, sql: string): Record<string, unknown> {
  const row = db.prepare(sql).get();
  if (row === undefined) {
    throw new StateStoreError(`PRAGMA query "${sql}" returned no row`);
  }
  return row;
}

export function readUserVersion(db: DatabaseSync): number {
  return toSafeInteger(get(db, "PRAGMA user_version").user_version, "PRAGMA user_version");
}

export function readApplicationId(db: DatabaseSync): number {
  return toSafeInteger(get(db, "PRAGMA application_id").application_id, "PRAGMA application_id");
}

export function readJournalMode(db: DatabaseSync): string {
  return toText(get(db, "PRAGMA journal_mode").journal_mode, "PRAGMA journal_mode");
}

export function readSynchronous(db: DatabaseSync): number {
  return toSafeInteger(get(db, "PRAGMA synchronous").synchronous, "PRAGMA synchronous");
}

export function readForeignKeys(db: DatabaseSync): number {
  return toSafeInteger(get(db, "PRAGMA foreign_keys").foreign_keys, "PRAGMA foreign_keys");
}

/** Table-valued PRAGMA introspection — bound parameters, never interpolation (V15). */
export function readTableList(db: DatabaseSync): readonly TableListRow[] {
  const rows = db
    .prepare(
      "SELECT name, type, ncol, wr, strict FROM pragma_table_list" +
        " WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return rows.map((row) => ({
    name: toText(row.name, "pragma_table_list.name"),
    type: toText(row.type, "pragma_table_list.type"),
    ncol: toSafeInteger(row.ncol, "pragma_table_list.ncol"),
    wr: toSafeInteger(row.wr, "pragma_table_list.wr"),
    strict: toSafeInteger(row.strict, "pragma_table_list.strict"),
  }));
}

export function readTableXInfo(db: DatabaseSync, table: string): readonly ColumnRow[] {
  const rows = db
    .prepare(
      'SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
    )
    .all(table);
  return rows.map((row) => ({
    cid: toSafeInteger(row.cid, "pragma_table_xinfo.cid"),
    name: toText(row.name, "pragma_table_xinfo.name"),
    type: toText(row.type, "pragma_table_xinfo.type"),
    notnull: toSafeInteger(row.notnull, "pragma_table_xinfo.notnull"),
    dfltValue: toNullableText(row.dflt_value, "pragma_table_xinfo.dflt_value"),
    pk: toSafeInteger(row.pk, "pragma_table_xinfo.pk"),
    hidden: toSafeInteger(row.hidden, "pragma_table_xinfo.hidden"),
  }));
}

export function readIndexList(db: DatabaseSync, table: string): readonly IndexRow[] {
  const rows = db
    .prepare('SELECT name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY name')
    .all(table);
  return rows.map((row) => ({
    name: toText(row.name, "pragma_index_list.name"),
    unique: toSafeInteger(row.unique, "pragma_index_list.unique"),
    origin: toText(row.origin, "pragma_index_list.origin"),
    partial: toSafeInteger(row.partial, "pragma_index_list.partial"),
  }));
}

export function readIndexXInfo(db: DatabaseSync, index: string): readonly IndexColumnRow[] {
  const rows = db
    .prepare("SELECT seqno, cid, name, desc, coll, key FROM pragma_index_xinfo(?) ORDER BY seqno")
    .all(index);
  return rows.map((row) => ({
    seqno: toSafeInteger(row.seqno, "pragma_index_xinfo.seqno"),
    cid: toSafeInteger(row.cid, "pragma_index_xinfo.cid"),
    name: toNullableText(row.name, "pragma_index_xinfo.name"),
    desc: toSafeInteger(row.desc, "pragma_index_xinfo.desc"),
    coll: toText(row.coll, "pragma_index_xinfo.coll"),
    key: toSafeInteger(row.key, "pragma_index_xinfo.key"),
  }));
}

export function readForeignKeyList(db: DatabaseSync, table: string): readonly ForeignKeyRow[] {
  const rows = db
    .prepare(
      'SELECT id, seq, "table", "from", "to", on_update, on_delete, match' +
        " FROM pragma_foreign_key_list(?) ORDER BY id, seq",
    )
    .all(table);
  return rows.map((row) => ({
    id: toSafeInteger(row.id, "pragma_foreign_key_list.id"),
    seq: toSafeInteger(row.seq, "pragma_foreign_key_list.seq"),
    table: toText(row.table, "pragma_foreign_key_list.table"),
    from: toText(row.from, "pragma_foreign_key_list.from"),
    to: toText(row.to, "pragma_foreign_key_list.to"),
    onUpdate: toText(row.on_update, "pragma_foreign_key_list.on_update"),
    onDelete: toText(row.on_delete, "pragma_foreign_key_list.on_delete"),
    match: toText(row.match, "pragma_foreign_key_list.match"),
  }));
}

export function readSchemaObjects(db: DatabaseSync): readonly SchemaObjectRow[] {
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema" +
        " WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
  return rows.map((row) => ({
    type: toText(row.type, "sqlite_schema.type"),
    name: toText(row.name, "sqlite_schema.name"),
    tblName: toText(row.tbl_name, "sqlite_schema.tbl_name"),
    sql: toNullableText(row.sql, "sqlite_schema.sql"),
  }));
}
