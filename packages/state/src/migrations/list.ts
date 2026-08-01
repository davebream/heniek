/**
 * The shipped migration list (design D2, D4, D5). **Append only** — Task 3.1
 * (Phase 3) adds migrations 2 and 3 after this array, never before or in
 * place of migration 1. `assertAppendOnly` runs once, at module load, and
 * validates the list's *well-formedness* — contiguous strictly-ascending
 * versions starting at 1, no duplicate name or version, no empty
 * `statements`, no `AUTOINCREMENT`, no SQL comments. It does **not** detect
 * an already-shipped migration's DDL being rewritten in place (issue #7,
 * Phase 2 fix S6) — nothing at module-load time re-parses `CREATE TABLE
 * state_event`'s text and compares it against what shipped before. That
 * guarantee is enforced by `test/fixtures/migration-statement-hashes.json`'s
 * committed pin (`test/migrations.test.ts`'s "matches the committed pin"
 * case) plus code review, not by this function.
 */

import { assertAppendOnly, type Migration } from "./migration.js";

export type { Migration } from "./migration.js";

/**
 * `PRAGMA application_id = 1213090609` (0x484E4B31, `"HNK1"`) is the first
 * statement of the first migration. It lands in the *same* `BEGIN
 * IMMEDIATE`/`COMMIT` transaction as the rest of migration 1's DDL (design
 * D2), so an interrupted migration 1 rolls the marker back along with
 * everything else — a partially-migrated database is not distinguishable
 * from a fresh, never-migrated one, and is not distinguishable from a
 * foreign SQLite file either. That is exactly why `openStateDatabase`'s
 * step 9 must accept `0` (fresh, or interrupted) as well as this value, and
 * refuse anything else (design D13) — see `fingerprint.test.ts`'s
 * interrupted-lineage case, which asserts the interrupted database's
 * `structural` digest equals version 0's, `application_id` included.
 *
 * `sequence INTEGER PRIMARY KEY` is the rowid alias — one global total
 * order, no `AUTOINCREMENT`, no separate counter (D4's rejection). `run_id`
 * is nullable without a `NOT NULL` constraint: identity events
 * (`codebase.registered`, `repository.registered`, `workspace.registered`)
 * are not run-scoped and omit it; only `run.*` events carry one.
 * `correlation_id` stays `NOT NULL` — every event belongs to exactly one
 * causal chain. `causation_event_id` is nullable only for a chain root, and
 * FK-enforced against `state_event.event_id` (D6). `recorded_at` is `TEXT`
 * ISO-8601 and is *not* an ordering key — `sequence` is.
 */
const MIGRATION_0001_JOURNAL: Migration = {
  version: 1,
  name: "journal",
  statements: [
    "PRAGMA application_id = 1213090609",
    `CREATE TABLE state_event (
      sequence            INTEGER PRIMARY KEY,
      event_id            TEXT    NOT NULL UNIQUE,
      run_id               TEXT,
      correlation_id      TEXT    NOT NULL,
      causation_event_id  TEXT             REFERENCES state_event(event_id),
      type                TEXT    NOT NULL,
      recorded_at         TEXT    NOT NULL,
      payload             TEXT    NOT NULL CHECK (json_valid(payload))
    ) STRICT`,
    "CREATE INDEX state_event_run_id_sequence ON state_event (run_id, sequence)",
    "CREATE INDEX state_event_correlation_id ON state_event (correlation_id)",
    `CREATE TRIGGER state_event_immutable_update BEFORE UPDATE ON state_event
      BEGIN SELECT RAISE(ABORT, 'state_event is append-only'); END`,
    `CREATE TRIGGER state_event_immutable_delete BEFORE DELETE ON state_event
      BEGIN SELECT RAISE(ABORT, 'state_event is append-only'); END`,
  ],
};

// `readonly Migration[]` is compile-time only — `assertAppendOnly` runs once
// at module load, and `runMigrationList` never re-validates on every call
// (it must stay permissive for the test seam that drives it with doctored
// lists), so a runtime `.push`/mutation of the exported array or of a
// migration's `statements` would defeat C1's enforcement silently, and
// `migrationManifest()` — E1's evidence artefact — would inherit the
// corruption because it reads this list live. `Object.freeze` closes that
// gap at runtime (issue #7, Phase 2 fix G6): mutating a frozen array or
// object throws under ESM's always-strict mode instead of silently
// succeeding.
Object.freeze(MIGRATION_0001_JOURNAL.statements);
Object.freeze(MIGRATION_0001_JOURNAL);

/**
 * Migration 2 — the run projection substrate (design D8, plan Task 3.1).
 * `workspace_id` is deliberately absent from this `CREATE TABLE` — it
 * arrives in migration 3 via `ALTER TABLE … ADD COLUMN` (plan P6), which
 * exercises the migrator's `ALTER` path at least once. `codebase_id` is
 * denormalised here for query convenience and carries no FK to `codebase`
 * (revisit at Q010, design open question 3).
 */
const MIGRATION_0002_RUN_PROJECTION: Migration = {
  version: 2,
  name: "run_projection",
  statements: [
    `CREATE TABLE run_projection (
      run_id               TEXT    NOT NULL PRIMARY KEY,
      status               TEXT    NOT NULL,
      revision             INTEGER NOT NULL,
      last_event_sequence  INTEGER NOT NULL REFERENCES state_event(sequence),
      codebase_id          TEXT    NOT NULL,
      updated_at           TEXT    NOT NULL
    ) STRICT`,
    `CREATE TRIGGER run_projection_first_revision BEFORE INSERT ON run_projection
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first projection revision must be 1'); END`,
    `CREATE TRIGGER run_projection_causal_update BEFORE UPDATE ON run_projection
      WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'projection update must advance revision by 1 and cite a newer event'); END`,
  ],
};
Object.freeze(MIGRATION_0002_RUN_PROJECTION.statements);
Object.freeze(MIGRATION_0002_RUN_PROJECTION);

/**
 * Migration 3 — the identity substrate: `codebase`, `repository`, `workspace`
 * (design D8, D9; plan P2), each with the same `last_event_sequence` FK
 * discipline and the same guard-trigger pair as `run_projection`. No
 * lifecycle/status/name/URL/branch columns — those are Q010/Q011/Q034
 * (design D9 rows 2-3); the relationship columns (`repository.codebase_id`,
 * `workspace.codebase_id`) are included because they are identities *and
 * relationships* (§16.3), and omitting them would be the speculative
 * under-reach X4 equally bans.
 *
 * The final statement adds `run_projection.workspace_id` by `ALTER TABLE …
 * ADD COLUMN` (plan P6, finding C2) — nullable and with no default, which
 * `ALTER TABLE ADD COLUMN` permits on a `STRICT` table. `workspace_id` is
 * nullable deliberately: a run exists for a moment before its workspace is
 * provisioned (Q011). This column MUST stay the last statement of this
 * migration: `pragma_table_xinfo` orders by `cid`, and an `ALTER`-appended
 * column always receives the highest `cid` — `test/fixtures/terminal-schema.sql`
 * must place `workspace_id` last in `run_projection`'s column list to match
 * (finding C2).
 */
const MIGRATION_0003_IDENTITY: Migration = {
  version: 3,
  name: "identity",
  statements: [
    `CREATE TABLE codebase (
      codebase_id          TEXT    NOT NULL PRIMARY KEY,
      revision             INTEGER NOT NULL,
      last_event_sequence  INTEGER NOT NULL REFERENCES state_event(sequence),
      updated_at           TEXT    NOT NULL
    ) STRICT`,
    `CREATE TRIGGER codebase_first_revision BEFORE INSERT ON codebase
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first projection revision must be 1'); END`,
    `CREATE TRIGGER codebase_causal_update BEFORE UPDATE ON codebase
      WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'projection update must advance revision by 1 and cite a newer event'); END`,
    `CREATE TABLE repository (
      repository_id        TEXT    NOT NULL PRIMARY KEY,
      codebase_id          TEXT    NOT NULL REFERENCES codebase(codebase_id),
      revision             INTEGER NOT NULL,
      last_event_sequence  INTEGER NOT NULL REFERENCES state_event(sequence),
      updated_at           TEXT    NOT NULL
    ) STRICT`,
    `CREATE TRIGGER repository_first_revision BEFORE INSERT ON repository
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first projection revision must be 1'); END`,
    `CREATE TRIGGER repository_causal_update BEFORE UPDATE ON repository
      WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'projection update must advance revision by 1 and cite a newer event'); END`,
    `CREATE TABLE workspace (
      workspace_id         TEXT    NOT NULL PRIMARY KEY,
      codebase_id          TEXT    NOT NULL REFERENCES codebase(codebase_id),
      revision             INTEGER NOT NULL,
      last_event_sequence  INTEGER NOT NULL REFERENCES state_event(sequence),
      updated_at           TEXT    NOT NULL
    ) STRICT`,
    `CREATE TRIGGER workspace_first_revision BEFORE INSERT ON workspace
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first projection revision must be 1'); END`,
    `CREATE TRIGGER workspace_causal_update BEFORE UPDATE ON workspace
      WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'projection update must advance revision by 1 and cite a newer event'); END`,
    "ALTER TABLE run_projection ADD COLUMN workspace_id TEXT",
  ],
};
Object.freeze(MIGRATION_0003_IDENTITY.statements);
Object.freeze(MIGRATION_0003_IDENTITY);

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  MIGRATION_0001_JOURNAL,
  MIGRATION_0002_RUN_PROJECTION,
  MIGRATION_0003_IDENTITY,
]);
assertAppendOnly(MIGRATIONS);
