/**
 * The shipped migration list (design D2, D4, D5). **Append only** — Task 3.1
 * (Phase 3) adds migrations 2 and 3 after this array, never before or in
 * place of migration 1. `assertAppendOnly` runs once, at module load, so a
 * violation fails as early as importing this file.
 */

import { assertAppendOnly, type Migration } from "./migration.js";

export type { Migration } from "./migration.js";

/**
 * `PRAGMA application_id = 1213090609` (0x484E4B31, `"HNK1"`) is the first
 * statement of the first migration so that even a partially-migrated
 * database (interrupted mid migration 1) already carries the marker —
 * `openStateDatabase`'s step 9 accepts `0` (fresh) or this value and refuses
 * anything else (design D13).
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

export const MIGRATIONS: readonly Migration[] = [MIGRATION_0001_JOURNAL];
assertAppendOnly(MIGRATIONS);
