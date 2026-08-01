import type { DatabaseSync } from "node:sqlite";
import { StateStoreError } from "../errors.js";

/**
 * This module is the single place where a raw `node:sqlite` row (typed
 * `Record<string, SQLOutputValue>` by `@types/node`, where `SQLOutputValue =
 * null | number | bigint | string | NonSharedUint8Array`) becomes a typed JS
 * value. Nothing else in `@heniek/state` may narrow a raw row by hand
 * (design D3, D4, plan §0.4 trap 7).
 *
 * A NULL parent column in `readForeignKeyList`'s `to` field — the idiomatic
 * short form `REFERENCES codebase` (no explicit column, meaning "the
 * parent's primary key") — must render as JSON `null` in Phase 2's schema
 * fingerprint normal form, never as an empty string: an empty string is a
 * distinct, valid value SQLite would never itself produce here, so
 * collapsing `null` into `""` would make the fingerprint unable to tell
 * "no explicit parent column" apart from a (hypothetical, never-real)
 * empty one. Phase 2 must preserve the three-way distinction: `null`
 * (SQLite's, meaning "implicit"), a real column name, or — never — `""`.
 */

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
  /**
   * `pragma_index_xinfo.coll` — unlike `to` below, this is not modelled as
   * nullable: SQLite always resolves a column's collating sequence to a
   * concrete name (`"BINARY"` by default; `"RTRIM"`/`"NOCASE"`/a
   * user-defined collation otherwise), even for an expression index column
   * whose `name` is NULL. There is no SQLite construct that leaves `coll`
   * itself unset (issue #7, fix B5 — the nullability question this row
   * raises resolves to "no", recorded here rather than left implicit).
   */
  readonly coll: string;
  readonly key: number;
}

export interface ForeignKeyRow {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  /**
   * NULL when the migration DDL uses the idiomatic short form
   * (`REFERENCES codebase`, no explicit column), which implicitly targets
   * the parent table's primary key — see this module's header comment for
   * how that must be rendered in Phase 2's fingerprint normal form (issue
   * #7, fix B5).
   */
  readonly to: string | null;
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

/**
 * D4's safe-integer boundary assertion. Accepts `number` or `bigint` and
 * throws `StateStoreError` otherwise. `bigint` is accepted (not just
 * tolerated) because `@types/node`'s `StatementResultingChanges.changes`
 * and `.lastInsertRowid` are typed `number | bigint` even with
 * `setReadBigInts` left off (plan §0.4 trap 8) — every caller reading either
 * field must route it through here regardless of which runtime type
 * actually comes back.
 */
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

/**
 * `recursive_triggers` gates whether SQLite fires a `BEFORE DELETE` trigger
 * for the row removal half of a `REPLACE` conflict resolution (`INSERT OR
 * REPLACE` / `REPLACE INTO`) — it defaults to off, in which case a REPLACE
 * conflict silently deletes and reinserts a row without the delete trigger
 * ever running (issue #7, Phase 2 fix S1). `openStateDatabase` verifies and
 * sets it on every open, mirroring `readForeignKeys`/`readJournalMode`.
 */
export function readRecursiveTriggers(db: DatabaseSync): number {
  return toSafeInteger(
    get(db, "PRAGMA recursive_triggers").recursive_triggers,
    "PRAGMA recursive_triggers",
  );
}

/**
 * Table-valued PRAGMA introspection — bound parameters, never interpolation
 * (V15). `NOT LIKE 'sqlite\_%' ESCAPE '\'` (not the unescaped
 * `'sqlite_%'`) so a real table whose name merely *resembles* the pattern
 * (e.g. one literally containing an underscore right after `sqlite`, where
 * plain `LIKE`'s `_` wildcard would match any single character and wrongly
 * exclude it) is not silently dropped from every reader below that filters
 * internal tables this way.
 */
export function readTableList(db: DatabaseSync): readonly TableListRow[] {
  // `schema = 'main'` and `ORDER BY name` are both load-bearing, not
  // decorative: `pragma_table_list` returns rows in unspecified order
  // (observed order has varied across otherwise-identical schemas), so a
  // caller comparing two lineages needs the `ORDER BY` for a stable diff;
  // and without `schema = 'main'`, the result also includes
  // `sqlite_temp_schema`'s entries, which this package never creates but
  // which would otherwise pollute the fingerprint with session-local noise.
  const rows = db
    .prepare(
      "SELECT name, type, ncol, wr, strict FROM pragma_table_list" +
        " WHERE schema = 'main' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
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

/**
 * `pragma_table_xinfo`, deliberately not `pragma_table_info`: only the
 * `_xinfo` form carries the `hidden` column (0 for an ordinary column, 2/3
 * for a generated or virtual-table hidden column), which the plain form
 * omits entirely. A schema fingerprint built on `table_info` would be
 * blind to a hidden-column change.
 */
export function readTableXInfo(db: DatabaseSync, table: string): readonly ColumnRow[] {
  // `"notnull"` is double-quoted because it collides with the SQL keyword
  // `NOT NULL`; the other columns here (`cid`, `name`, `type`, `dflt_value`,
  // `pk`, `hidden`) are ordinary identifiers with no such collision, so
  // quoting them would be noise.
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
  // `"unique"` is double-quoted for the same reason as `"notnull"` above —
  // it collides with the SQL keyword `UNIQUE`. `name`, `origin`, `partial`
  // do not collide with anything and are left bare.
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
  // `desc` and `key` are ordinary identifiers in this context (SQLite's
  // grammar does not treat either as reserved here), unlike `"notnull"` and
  // `"unique"` above, so neither needs quoting.
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
  // `"table"`, `"from"`, and `"to"` are double-quoted because all three
  // collide with SQL keywords (`TABLE`, `FROM`, `TO` — the last reserved by
  // SQLite's own grammar even though it is not standard SQL); `on_update`,
  // `on_delete`, and `match` do not collide with anything.
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
    // `to` is NULL whenever the migration DDL omits an explicit parent
    // column (`REFERENCES codebase`, not `REFERENCES codebase(id)`) — see
    // this module's header comment and the `ForeignKeyRow.to` doc comment
    // (issue #7, fix B5). `toText` would throw on exactly the idiomatic
    // short form Phase 3 uses for `repository.codebase_id` and
    // `workspace.codebase_id`.
    to: toNullableText(row.to, "pragma_foreign_key_list.to"),
    onUpdate: toText(row.on_update, "pragma_foreign_key_list.on_update"),
    onDelete: toText(row.on_delete, "pragma_foreign_key_list.on_delete"),
    match: toText(row.match, "pragma_foreign_key_list.match"),
  }));
}

export function readSchemaObjects(db: DatabaseSync): readonly SchemaObjectRow[] {
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema" +
        " WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
    )
    .all();
  return rows.map((row) => ({
    type: toText(row.type, "sqlite_schema.type"),
    name: toText(row.name, "sqlite_schema.name"),
    tblName: toText(row.tbl_name, "sqlite_schema.tbl_name"),
    sql: toNullableText(row.sql, "sqlite_schema.sql"),
  }));
}
