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

/**
 * Migration 4 — immutable artifacts and the active artifact alias (design
 * D11, D11a; plan Task 2.1, Normative Reference N2). Two tables:
 *
 * `artifact` — content-addressed, immutable once written. It carries the
 * same `revision`/`last_event_sequence` columns every projection table
 * does, but deliberately **not** the `*_first_revision`/`*_causal_update`
 * guard pair: an artifact row is written exactly once and never updated
 * again, so there is no "causal update" to guard. Instead it carries a
 * BEFORE UPDATE / BEFORE DELETE `RAISE(ABORT)` pair, mirroring
 * `state_event`'s append-only posture (D11a) — `artifact` is append-only
 * like the journal, not mutably-projected like the other three tables.
 * `CHECK (relative_path = 'blobs/sha256/' || content_hash)` is what lets the
 * Phase 5 recovery sweep trust, by schema construction, that a committed row
 * can never point into `incoming/` — `relative_path` is pinned to the
 * `blobs/sha256/` prefix by equality, so no row can ever equal an
 * `incoming/…` path. A separate `CHECK (relative_path NOT LIKE
 * 'incoming/%')` shipped alongside it but was dead on arrival: it is fully
 * subsumed by the equality CHECK above and can never fire, so it was removed
 * (issue #8, Phase 2 fix cycle G1, finding F6).
 *
 * **`CHECK (length(content_hash) = 64 AND content_hash NOT GLOB
 * '*[^0-9a-f]*')` (issue #8, Phase 2 fix cycle G1, finding F1):** the
 * original shipped CHECK was `content_hash = lower(content_hash)`, which
 * only rejects uppercase letters — `lower(X) = X` is also true for a
 * 64-character string containing `.` and `/`, so a `content_hash` of
 * `../../../../../../../../../../../../../../../../../etc/passwd_aaaa`
 * (64 chars, already lowercase) passed the CHECK while making
 * `relative_path = 'blobs/sha256/' || content_hash` denote a path outside
 * the blob root. The GLOB pattern closes the alphabet to exactly
 * `[0-9a-f]`, so `relative_path` can no longer escape `blobs/sha256/`
 * regardless of what a caller passes as `contentHash`. `reducer.ts`
 * (`requireContentHash`) also validates `contentHash` against the same hex
 * alphabet before this CHECK is ever reached, so a malformed hash raises a
 * typed `ReducerError` at the public API boundary instead of surfacing as a
 * raw `SQLITE_CONSTRAINT_CHECK`.
 *
 * **`REFERENCES run_projection(run_id)` on `artifact.run_id` (issue #8,
 * Phase 2 fix cycle G1, finding F4):** `repository.codebase_id` and
 * `workspace.codebase_id` each carry both a `REFERENCES` clause and a
 * reducer-side existence check (the `repository.registered` precedent);
 * `artifact.run_id` shipped with neither, so an artifact could be committed
 * for a run that never existed. `PRAGMA foreign_keys = ON` is set in
 * `database/open.ts`, so this FK is genuinely enforced at the database
 * layer; `reducer.ts` adds the matching existence check for
 * `artifact.published` and `stage.completed` ahead of it, and both events'
 * `eventScope` load the referenced `run_projection` row so the check has
 * data to compare against.
 *
 * **`CHECK (revision = 1)` (issue #8, Phase 2 fix cycle G1):** the original
 * shipped DDL left `revision` an unconstrained `INTEGER NOT NULL`, so
 * `INSERT ... revision = 7` silently succeeded, contradicting
 * `command/commit.ts`'s docblock claim that the schema's guard triggers
 * enforce the causal shape "against any writer". `artifact` deliberately
 * does **not** get the ordinary `*_first_revision` trigger the other three
 * projection tables carry — that trigger's message and shape exist to pair
 * with a `*_causal_update` trigger this table cannot have (adding one would
 * be unreachable dead code behind the unconditional `BEFORE UPDATE
 * RAISE(ABORT)` above). A plain `CHECK` is simpler for a value that is
 * always `1` and never revised, sits declaratively alongside this table's
 * other value `CHECK`s instead of introducing a second enforcement
 * mechanism (SQL trigger) for one column, and needs no new trigger name to
 * track. `stage_artifact_alias` is unaffected — it keeps its own
 * `*_first_revision`/`*_causal_update` guard pair unchanged (design D11a);
 * it is the deliberately mutable §16.2 active-artifact alias, not an
 * append-only row.
 *
 * `stage_artifact_alias` — the §16.2 "active artifact alias": keyed
 * `(run_id, stage_id, name)`, pointing at whichever `artifact_id` is
 * currently active for that name. This is the one deliberately **mutable**
 * row in the design, so it carries the ordinary `*_first_revision`/
 * `*_causal_update` guard pair every other projection table carries — a
 * retry re-points this row to a new, still-immutable artifact rather than
 * mutating the artifact itself.
 */
const MIGRATION_0004_ARTIFACT: Migration = {
  version: 4,
  name: "artifact",
  statements: [
    `CREATE TABLE artifact (
      artifact_id          TEXT    NOT NULL PRIMARY KEY,
      run_id               TEXT    NOT NULL REFERENCES run_projection(run_id),
      stage_id             TEXT    NOT NULL,
      name                 TEXT    NOT NULL,
      content_hash         TEXT    NOT NULL,
      byte_length          INTEGER NOT NULL,
      media_type           TEXT    NOT NULL,
      content_schema_id    TEXT    NOT NULL,
      producer              TEXT    NOT NULL,
      source_lineage       TEXT    NOT NULL CHECK (json_valid(source_lineage)),
      relative_path        TEXT    NOT NULL,
      created_at           TEXT    NOT NULL,
      revision             INTEGER NOT NULL,
      last_event_sequence  INTEGER NOT NULL REFERENCES state_event(sequence),
      CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK (byte_length >= 0),
      CHECK (relative_path = 'blobs/sha256/' || content_hash),
      CHECK (revision = 1)
    ) STRICT`,
    "CREATE INDEX artifact_run_id_stage_id ON artifact (run_id, stage_id)",
    `CREATE TRIGGER artifact_immutable_update BEFORE UPDATE ON artifact
      BEGIN SELECT RAISE(ABORT, 'artifact is append-only'); END`,
    `CREATE TRIGGER artifact_immutable_delete BEFORE DELETE ON artifact
      BEGIN SELECT RAISE(ABORT, 'artifact is append-only'); END`,
    `CREATE TABLE stage_artifact_alias (
      run_id               TEXT    NOT NULL,
      stage_id             TEXT    NOT NULL,
      name                 TEXT    NOT NULL,
      artifact_id          TEXT    NOT NULL REFERENCES artifact(artifact_id),
      revision             INTEGER NOT NULL,
      last_event_sequence  INTEGER NOT NULL REFERENCES state_event(sequence),
      updated_at           TEXT    NOT NULL,
      PRIMARY KEY (run_id, stage_id, name)
    ) STRICT`,
    `CREATE TRIGGER stage_artifact_alias_first_revision BEFORE INSERT ON stage_artifact_alias
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first projection revision must be 1'); END`,
    `CREATE TRIGGER stage_artifact_alias_causal_update BEFORE UPDATE ON stage_artifact_alias
      WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'projection update must advance revision by 1 and cite a newer event'); END`,
  ],
};
Object.freeze(MIGRATION_0004_ARTIFACT.statements);
Object.freeze(MIGRATION_0004_ARTIFACT);

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  MIGRATION_0001_JOURNAL,
  MIGRATION_0002_RUN_PROJECTION,
  MIGRATION_0003_IDENTITY,
  MIGRATION_0004_ARTIFACT,
]);
assertAppendOnly(MIGRATIONS);
