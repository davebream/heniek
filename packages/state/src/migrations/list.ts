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

export const MIGRATIONS: readonly Migration[] = Object.freeze([MIGRATION_0001_JOURNAL]);
assertAppendOnly(MIGRATIONS);
