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

import { MIGRATION_0019_CAPABILITY_LANDING } from "./capability-landing.js";
import { assertAppendOnly, type Migration } from "./migration.js";
import { MIGRATION_0018_PIPELINE_ADMISSION } from "./pipeline-admission.js";
import { MIGRATION_0017_PIPELINE_FINDINGS } from "./pipeline-findings.js";
import { MIGRATION_0016_PIPELINE_FUSION } from "./pipeline-fusion.js";
import { MIGRATION_0015_PIPELINE_RECOVERY } from "./pipeline-recovery.js";
import { MIGRATION_0013_PIPELINE_RUNNER } from "./pipeline-runner.js";
import { MIGRATION_0014_PIPELINE_RUNNER_OPERATIONS } from "./pipeline-runner-operations.js";
import { MIGRATION_0012_PIPELINE_SCHEDULER } from "./pipeline-scheduler.js";
import { MIGRATION_0021_TASK_SOURCE } from "./task-source.js";
import { MIGRATION_0020_WORKSPACE_VARIANTS } from "./workspace-variants.js";

export { MIGRATION_0019_CAPABILITY_LANDING } from "./capability-landing.js";
export type { Migration } from "./migration.js";
export { MIGRATION_0018_PIPELINE_ADMISSION } from "./pipeline-admission.js";
export { MIGRATION_0017_PIPELINE_FINDINGS } from "./pipeline-findings.js";
export { MIGRATION_0016_PIPELINE_FUSION } from "./pipeline-fusion.js";
export { MIGRATION_0015_PIPELINE_RECOVERY } from "./pipeline-recovery.js";
export { MIGRATION_0013_PIPELINE_RUNNER } from "./pipeline-runner.js";
export { MIGRATION_0014_PIPELINE_RUNNER_OPERATIONS } from "./pipeline-runner-operations.js";
export { MIGRATION_0012_PIPELINE_SCHEDULER } from "./pipeline-scheduler.js";
export { MIGRATION_0021_TASK_SOURCE } from "./task-source.js";
export { MIGRATION_0020_WORKSPACE_VARIANTS } from "./workspace-variants.js";

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

/** Q010: durable Codebase discovery attributes and immutable per-run instruction provenance. */
const MIGRATION_0005_CODEBASE_REGISTRATION: Migration = {
  version: 5,
  name: "codebase-registration",
  statements: [
    "ALTER TABLE codebase ADD COLUMN name TEXT",
    "ALTER TABLE codebase ADD COLUMN root_path TEXT",
    "ALTER TABLE codebase ADD COLUMN topology_sha256 TEXT",
    "ALTER TABLE codebase ADD COLUMN configuration_sha256 TEXT",
    "ALTER TABLE codebase ADD COLUMN registration_json TEXT CHECK (registration_json IS NULL OR json_valid(registration_json))",
    "ALTER TABLE codebase ADD COLUMN instruction_snapshot_json TEXT CHECK (instruction_snapshot_json IS NULL OR json_valid(instruction_snapshot_json))",
    "ALTER TABLE repository ADD COLUMN name TEXT",
    "ALTER TABLE repository ADD COLUMN repository_path TEXT",
    "ALTER TABLE repository ADD COLUMN git_common_directory TEXT",
    "ALTER TABLE repository ADD COLUMN remotes_json TEXT CHECK (remotes_json IS NULL OR json_valid(remotes_json))",
    "ALTER TABLE repository ADD COLUMN default_remote TEXT",
    "ALTER TABLE repository ADD COLUMN default_branch TEXT",
    "ALTER TABLE run_projection ADD COLUMN instruction_snapshot_sha256 TEXT",
    "ALTER TABLE run_projection ADD COLUMN instruction_snapshot_json TEXT CHECK (instruction_snapshot_json IS NULL OR json_valid(instruction_snapshot_json))",
  ],
};

const MIGRATION_0006_WORKSPACE_LIFECYCLE: Migration = {
  version: 6,
  name: "workspace-lifecycle-and-writer-leases",
  statements: [
    "ALTER TABLE workspace ADD COLUMN repository_id TEXT REFERENCES repository(repository_id)",
    "ALTER TABLE workspace ADD COLUMN lifecycle_status TEXT",
    "ALTER TABLE workspace ADD COLUMN checkout_path TEXT",
    "ALTER TABLE workspace ADD COLUMN configuration_sha256 TEXT",
    "ALTER TABLE workspace ADD COLUMN manifest_json TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json))",
    "CREATE UNIQUE INDEX workspace_checkout_path_unique ON workspace(checkout_path) WHERE checkout_path IS NOT NULL",
    `CREATE TABLE workspace_lease (
      checkout_path        TEXT    NOT NULL PRIMARY KEY,
      workspace_id         TEXT    NOT NULL REFERENCES workspace(workspace_id),
      repository_id        TEXT    NOT NULL REFERENCES repository(repository_id),
      lease_id             TEXT    NOT NULL,
      owner_id             TEXT    NOT NULL,
      boot_witness         TEXT,
      process_witnesses_json TEXT  NOT NULL CHECK (json_valid(process_witnesses_json)),
      expected_sha         TEXT    NOT NULL,
      fencing_revision     INTEGER NOT NULL,
      lease_state          TEXT    NOT NULL,
      acquired_at          TEXT    NOT NULL,
      renewed_at           TEXT    NOT NULL,
      expires_at           TEXT    NOT NULL,
      released_at          TEXT,
      revision             INTEGER NOT NULL,
      last_event_sequence  INTEGER NOT NULL REFERENCES state_event(sequence),
      updated_at           TEXT    NOT NULL
    ) STRICT`,
    `CREATE TRIGGER workspace_lease_first_revision BEFORE INSERT ON workspace_lease
      WHEN NEW.revision <> 1 OR NEW.fencing_revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first workspace lease revision and fence must be 1'); END`,
    `CREATE TRIGGER workspace_lease_causal_update BEFORE UPDATE ON workspace_lease
      WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'projection update must advance revision by 1 and cite a newer event'); END`,
  ],
};

const MIGRATION_0007_STAGE_EXECUTION: Migration = {
  version: 7,
  name: "stage-execution",
  statements: [
    `CREATE TABLE stage_execution (
      run_id                 TEXT NOT NULL PRIMARY KEY REFERENCES run_projection(run_id),
      stage_id               TEXT NOT NULL UNIQUE,
      codebase_id            TEXT NOT NULL REFERENCES codebase(codebase_id),
      repository_id          TEXT NOT NULL REFERENCES repository(repository_id),
      workspace_id           TEXT NOT NULL REFERENCES workspace(workspace_id),
      backend_kind           TEXT NOT NULL,
      backend_execution_id   TEXT UNIQUE,
      status                 TEXT NOT NULL,
      prompt                 TEXT NOT NULL,
      artifact_path          TEXT NOT NULL,
      limits_json            TEXT NOT NULL CHECK (json_valid(limits_json)),
      summary                TEXT,
      session_id             TEXT,
      error                  TEXT,
      finalized              INTEGER NOT NULL DEFAULT 0,
      created_at             TEXT NOT NULL,
      updated_at             TEXT NOT NULL,
      CHECK (status IN ('queued','running','waiting_on_user','recovery_required','succeeded','failed','cancelled')),
      CHECK (finalized IN (0,1))
    ) STRICT`,
    "CREATE INDEX stage_execution_status ON stage_execution(status, run_id)",
    `CREATE TABLE execution_interaction (
      run_id                 TEXT NOT NULL REFERENCES stage_execution(run_id),
      interaction_id         TEXT NOT NULL,
      payload_json           TEXT NOT NULL CHECK (json_valid(payload_json)),
      answer_json            TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
      state                  TEXT NOT NULL,
      updated_at             TEXT NOT NULL,
      PRIMARY KEY (run_id, interaction_id),
      CHECK (state IN ('pending','answered','resolved'))
    ) STRICT`,
    `CREATE TABLE backend_artifact_import (
      run_id                 TEXT NOT NULL REFERENCES stage_execution(run_id),
      backend_artifact_id    TEXT NOT NULL,
      artifact_id            TEXT REFERENCES artifact(artifact_id),
      content_hash           TEXT,
      byte_length            INTEGER,
      state                  TEXT NOT NULL,
      updated_at             TEXT NOT NULL,
      PRIMARY KEY (run_id, backend_artifact_id),
      CHECK (state IN ('pending','completed')),
      CHECK (byte_length IS NULL OR byte_length >= 0)
    ) STRICT`,
  ],
};
Object.freeze(MIGRATION_0004_ARTIFACT.statements);
Object.freeze(MIGRATION_0004_ARTIFACT);
Object.freeze(MIGRATION_0007_STAGE_EXECUTION.statements);
Object.freeze(MIGRATION_0007_STAGE_EXECUTION);

const MIGRATION_0008_CAPABILITY_CACHE: Migration = {
  version: 8,
  name: "capability-cache",
  statements: [
    `CREATE TABLE capability_snapshot (
      engine             TEXT NOT NULL,
      account_key        TEXT NOT NULL,
      engine_version_key TEXT NOT NULL,
      claudexor_version  TEXT NOT NULL,
      observed_at        TEXT NOT NULL,
      expires_at         TEXT NOT NULL,
      payload_json       TEXT NOT NULL CHECK (json_valid(payload_json)),
      PRIMARY KEY (engine, account_key, engine_version_key, claudexor_version),
      CHECK (engine IN ('claude','codex','cursor'))
    ) STRICT`,
    "CREATE INDEX capability_snapshot_latest ON capability_snapshot(engine, account_key, observed_at DESC)",
  ],
};
Object.freeze(MIGRATION_0008_CAPABILITY_CACHE.statements);
Object.freeze(MIGRATION_0008_CAPABILITY_CACHE);

const MIGRATION_0009_DURABLE_INTERACTIONS: Migration = {
  version: 9,
  name: "durable-interactions",
  statements: [
    `CREATE TABLE interaction_record (
      run_id                 TEXT NOT NULL REFERENCES stage_execution(run_id),
      interaction_id         TEXT NOT NULL,
      stage_id               TEXT NOT NULL,
      purpose                TEXT NOT NULL,
      source_payload_json    TEXT NOT NULL CHECK (json_valid(source_payload_json)),
      canonical_payload_json TEXT CHECK (canonical_payload_json IS NULL OR json_valid(canonical_payload_json)),
      legacy_state           TEXT,
      requested_at           TEXT NOT NULL,
      timeout_at             TEXT,
      created_event_id       TEXT REFERENCES state_event(event_id),
      PRIMARY KEY (run_id, interaction_id),
      CHECK (purpose IN ('question','approval'))
    ) STRICT`,
    `CREATE TRIGGER interaction_record_immutable_update BEFORE UPDATE ON interaction_record
      BEGIN SELECT RAISE(ABORT, 'interaction records are immutable'); END`,
    `CREATE TRIGGER interaction_record_immutable_delete BEFORE DELETE ON interaction_record
      BEGIN SELECT RAISE(ABORT, 'interaction records are immutable'); END`,
    `CREATE TABLE interaction_answer_record (
      answer_id                TEXT NOT NULL PRIMARY KEY,
      run_id                   TEXT NOT NULL,
      interaction_id           TEXT NOT NULL,
      operation_id             TEXT NOT NULL UNIQUE,
      source_answer_json       TEXT NOT NULL CHECK (json_valid(source_answer_json)),
      canonical_answer_json    TEXT CHECK (canonical_answer_json IS NULL OR json_valid(canonical_answer_json)),
      answered_by_key_id       TEXT NOT NULL,
      answered_at              TEXT NOT NULL,
      accepted_event_id        TEXT REFERENCES state_event(event_id),
      UNIQUE (run_id, interaction_id),
      FOREIGN KEY (run_id, interaction_id)
        REFERENCES interaction_record(run_id, interaction_id)
    ) STRICT`,
    `CREATE TRIGGER interaction_answer_immutable_update BEFORE UPDATE ON interaction_answer_record
      BEGIN SELECT RAISE(ABORT, 'interaction answers are immutable'); END`,
    `CREATE TRIGGER interaction_answer_immutable_delete BEFORE DELETE ON interaction_answer_record
      BEGIN SELECT RAISE(ABORT, 'interaction answers are immutable'); END`,
    `CREATE TABLE pending_interaction_projection (
      run_id                 TEXT NOT NULL,
      interaction_id        TEXT NOT NULL,
      state                  TEXT NOT NULL,
      revision               INTEGER NOT NULL,
      delivery_state         TEXT NOT NULL,
      cancellation_reason    TEXT,
      resolved_at            TEXT,
      answer_id              TEXT REFERENCES interaction_answer_record(answer_id),
      last_event_sequence    INTEGER NOT NULL REFERENCES state_event(sequence),
      updated_at             TEXT NOT NULL,
      PRIMARY KEY (run_id, interaction_id),
      FOREIGN KEY (run_id, interaction_id)
        REFERENCES interaction_record(run_id, interaction_id),
      CHECK (state IN ('pending','answered','cancelled')),
      CHECK (delivery_state IN ('not_applicable','pending','delivered')),
      CHECK (revision >= 1),
      CHECK (cancellation_reason IS NULL OR cancellation_reason IN
        ('withdrawn','timed_out','run_terminal','migration_unresolved'))
    ) STRICT`,
    `CREATE INDEX pending_interaction_inbox
      ON pending_interaction_projection(state, updated_at, run_id, interaction_id)`,
    `CREATE TRIGGER pending_interaction_causal_update BEFORE UPDATE ON pending_interaction_projection
      WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'interaction projection must advance revision by 1'); END`,
    `CREATE TABLE execution_operation_outbox (
      operation_id           TEXT NOT NULL PRIMARY KEY,
      run_id                 TEXT NOT NULL REFERENCES stage_execution(run_id),
      interaction_id         TEXT,
      kind                   TEXT NOT NULL,
      payload_json           TEXT NOT NULL CHECK (json_valid(payload_json)),
      state                  TEXT NOT NULL,
      attempt_count          INTEGER NOT NULL DEFAULT 0,
      last_error             TEXT,
      created_at             TEXT NOT NULL,
      delivered_at           TEXT,
      last_event_sequence    INTEGER NOT NULL REFERENCES state_event(sequence),
      FOREIGN KEY (run_id, interaction_id)
        REFERENCES interaction_record(run_id, interaction_id),
      CHECK (kind IN ('answer','resume')),
      CHECK (state IN ('pending','delivered')),
      CHECK (attempt_count >= 0),
      CHECK ((kind = 'answer' AND interaction_id IS NOT NULL) OR
             (kind = 'resume' AND interaction_id IS NULL))
    ) STRICT`,
    `CREATE INDEX execution_operation_pending
      ON execution_operation_outbox(state, created_at, operation_id)`,
    `CREATE TRIGGER migration_0009_run_revision AFTER INSERT ON state_event
      WHEN NEW.type IN ('interaction.created','interaction.answer_accepted','interaction.cancelled')
      BEGIN
        UPDATE run_projection
          SET revision = revision + 1,
              last_event_sequence = NEW.sequence,
              updated_at = NEW.recorded_at
          WHERE run_id = NEW.run_id;
      END`,
    `INSERT INTO state_event
      (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)
      SELECT
        'm9c:' || length(run_id) || ':' || run_id || ':' || interaction_id,
        run_id,
        'm9:' || length(run_id) || ':' || run_id || ':' || interaction_id,
        NULL,
        'interaction.created',
        COALESCE(json_extract(payload_json, '$.requestedAt'), updated_at),
        json_object(
          'interactionId', interaction_id,
          'stageId', (SELECT stage_id FROM stage_execution WHERE run_id = execution_interaction.run_id),
          'purpose', 'question',
          'sourcePayload', json(payload_json),
          'legacyState', state,
          'migrationVersion', 9
        )
      FROM execution_interaction`,
    `INSERT INTO state_event
      (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)
      SELECT
        'm9a:' || length(run_id) || ':' || run_id || ':' || interaction_id,
        run_id,
        'm9:' || length(run_id) || ':' || run_id || ':' || interaction_id,
        'm9c:' || length(run_id) || ':' || run_id || ':' || interaction_id,
        'interaction.answer_accepted',
        updated_at,
        json_object(
          'interactionId', interaction_id,
          'sourceAnswer', json(answer_json),
          'answeredByKeyId', 'legacy-migration',
          'migrationVersion', 9
        )
      FROM execution_interaction
      WHERE answer_json IS NOT NULL`,
    `INSERT INTO state_event
      (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)
      SELECT
        'm9x:' || length(run_id) || ':' || run_id || ':' || interaction_id,
        run_id,
        'm9:' || length(run_id) || ':' || run_id || ':' || interaction_id,
        'm9c:' || length(run_id) || ':' || run_id || ':' || interaction_id,
        'interaction.cancelled',
        updated_at,
        json_object(
          'interactionId', interaction_id,
          'reason', 'migration_unresolved',
          'legacyState', state,
          'migrationVersion', 9
        )
      FROM execution_interaction
      WHERE answer_json IS NULL AND state <> 'pending'`,
    "DROP TRIGGER migration_0009_run_revision",
    `INSERT INTO interaction_record
      (run_id, interaction_id, stage_id, purpose, source_payload_json,
       canonical_payload_json, legacy_state, requested_at, timeout_at, created_event_id)
      SELECT
        run_id,
        interaction_id,
        (SELECT stage_id FROM stage_execution WHERE run_id = execution_interaction.run_id),
        'question',
        payload_json,
        NULL,
        state,
        COALESCE(json_extract(payload_json, '$.requestedAt'), updated_at),
        json_extract(payload_json, '$.timeoutAt'),
        'm9c:' || length(run_id) || ':' || run_id || ':' || interaction_id
      FROM execution_interaction`,
    `INSERT INTO interaction_answer_record
      (answer_id, run_id, interaction_id, operation_id, source_answer_json,
       canonical_answer_json, answered_by_key_id, answered_at, accepted_event_id)
      SELECT
        'legacy-answer:' || length(run_id) || ':' || run_id || ':' || interaction_id,
        run_id,
        interaction_id,
        'legacy-operation:' || length(run_id) || ':' || run_id || ':' || interaction_id,
        answer_json,
        NULL,
        'legacy-migration',
        updated_at,
        'm9a:' || length(run_id) || ':' || run_id || ':' || interaction_id
      FROM execution_interaction
      WHERE answer_json IS NOT NULL`,
    `INSERT INTO pending_interaction_projection
      (run_id, interaction_id, state, revision, delivery_state, cancellation_reason,
       resolved_at, answer_id, last_event_sequence, updated_at)
      SELECT
        run_id,
        interaction_id,
        CASE
          WHEN answer_json IS NOT NULL THEN 'answered'
          WHEN state = 'pending' THEN 'pending'
          ELSE 'cancelled'
        END,
        CASE WHEN state = 'pending' AND answer_json IS NULL THEN 1 ELSE 2 END,
        CASE WHEN answer_json IS NOT NULL THEN 'delivered' ELSE 'not_applicable' END,
        CASE WHEN answer_json IS NULL AND state <> 'pending' THEN 'migration_unresolved' ELSE NULL END,
        CASE WHEN state = 'pending' AND answer_json IS NULL THEN NULL ELSE updated_at END,
        CASE WHEN answer_json IS NOT NULL
          THEN 'legacy-answer:' || length(run_id) || ':' || run_id || ':' || interaction_id
          ELSE NULL END,
        (SELECT sequence FROM state_event WHERE event_id =
          CASE
            WHEN answer_json IS NOT NULL
              THEN 'm9a:' || length(run_id) || ':' || run_id || ':' || interaction_id
            WHEN state <> 'pending'
              THEN 'm9x:' || length(run_id) || ':' || run_id || ':' || interaction_id
            ELSE 'm9c:' || length(run_id) || ':' || run_id || ':' || interaction_id
          END),
        CASE
          WHEN state = 'pending' AND answer_json IS NULL
            THEN COALESCE(json_extract(payload_json, '$.requestedAt'), updated_at)
          ELSE updated_at
        END
      FROM execution_interaction`,
    "DROP TABLE execution_interaction",
    `CREATE TRIGGER pending_interaction_first_revision BEFORE INSERT ON pending_interaction_projection
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first interaction projection revision must be 1'); END`,
  ],
};
Object.freeze(MIGRATION_0009_DURABLE_INTERACTIONS.statements);
Object.freeze(MIGRATION_0009_DURABLE_INTERACTIONS);

const MIGRATION_0010_ACCOUNT_SCHEDULING: Migration = {
  version: 10,
  name: "account-scheduling",
  statements: [
    `CREATE TABLE execution_schedule (
      run_id                    TEXT NOT NULL PRIMARY KEY,
      stage_id                  TEXT NOT NULL UNIQUE,
      codebase_id               TEXT NOT NULL,
      repository_id             TEXT NOT NULL,
      prompt                    TEXT NOT NULL,
      artifact_path             TEXT NOT NULL,
      base_sha                  TEXT,
      hard_deadline_at          TEXT,
      state                     TEXT NOT NULL,
      capacity_policy           TEXT NOT NULL,
      requested_priority        INTEGER NOT NULL,
      current_candidate_index   INTEGER,
      current_attempt_id        TEXT,
      revision                  INTEGER NOT NULL,
      chain_json                TEXT NOT NULL CHECK (json_valid(chain_json)),
      requested_secret_ids_json TEXT NOT NULL CHECK (json_valid(requested_secret_ids_json)),
      enqueued_at               TEXT NOT NULL,
      updated_at                TEXT NOT NULL,
      CHECK (state IN ('queued','waiting_on_user','running','terminal')),
      CHECK (capacity_policy IN ('queue','fallback','ask')),
      CHECK (requested_priority BETWEEN 0 AND 9),
      CHECK (revision >= 1)
    ) STRICT`,
    `CREATE TABLE execution_candidate (
      run_id                 TEXT NOT NULL REFERENCES execution_schedule(run_id),
      candidate_index        INTEGER NOT NULL,
      profile_id             TEXT NOT NULL,
      account_id             TEXT,
      engine                 TEXT NOT NULL,
      max_concurrent_runs    INTEGER NOT NULL,
      profile_json           TEXT NOT NULL CHECK (json_valid(profile_json)),
      limits_json            TEXT NOT NULL CHECK (json_valid(limits_json)),
      permissions_json       TEXT NOT NULL CHECK (json_valid(permissions_json)),
      state                  TEXT NOT NULL,
      PRIMARY KEY (run_id, candidate_index),
      CHECK (candidate_index >= 0),
      CHECK (max_concurrent_runs >= 1),
      CHECK (state IN ('pending','queued','selected','rejected','failed','succeeded'))
    ) STRICT`,
    `CREATE INDEX execution_candidate_account
      ON execution_candidate(account_id, state, run_id, candidate_index)`,
    `CREATE TABLE account_capacity (
      account_id             TEXT NOT NULL PRIMARY KEY,
      max_concurrent_runs    INTEGER NOT NULL,
      updated_at             TEXT NOT NULL,
      CHECK (max_concurrent_runs >= 1)
    ) STRICT`,
    `CREATE TABLE account_queue_entry (
      queue_sequence         INTEGER PRIMARY KEY,
      run_id                 TEXT NOT NULL,
      candidate_index        INTEGER NOT NULL,
      account_id             TEXT NOT NULL,
      requested_priority     INTEGER NOT NULL,
      enqueued_at            TEXT NOT NULL,
      UNIQUE (run_id, candidate_index),
      FOREIGN KEY (run_id, candidate_index)
        REFERENCES execution_candidate(run_id, candidate_index),
      CHECK (requested_priority BETWEEN 0 AND 9)
    ) STRICT`,
    `CREATE INDEX account_queue_order
      ON account_queue_entry(account_id, requested_priority DESC, queue_sequence)`,
    `CREATE TABLE execution_attempt (
      attempt_id             TEXT NOT NULL PRIMARY KEY,
      run_id                 TEXT NOT NULL REFERENCES execution_schedule(run_id),
      stage_id               TEXT NOT NULL,
      candidate_index        INTEGER NOT NULL,
      profile_id             TEXT NOT NULL,
      account_id             TEXT,
      workspace_id           TEXT REFERENCES workspace(workspace_id),
      backend_execution_id   TEXT UNIQUE,
      status                 TEXT NOT NULL,
      limits_json            TEXT NOT NULL CHECK (json_valid(limits_json)),
      permissions_json       TEXT NOT NULL CHECK (json_valid(permissions_json)),
      readonly_baseline_json TEXT CHECK (readonly_baseline_json IS NULL OR json_valid(readonly_baseline_json)),
      result_json            TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      failure_json           TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
      started_at             TEXT,
      finished_at            TEXT,
      created_at             TEXT NOT NULL,
      updated_at             TEXT NOT NULL,
      UNIQUE (run_id, candidate_index),
      FOREIGN KEY (run_id, candidate_index)
        REFERENCES execution_candidate(run_id, candidate_index),
      CHECK (status IN ('queued','running','waiting_on_user','recovery_required','succeeded','failed','cancelled'))
    ) STRICT`,
    "CREATE INDEX execution_attempt_run ON execution_attempt(run_id, candidate_index)",
    `CREATE TABLE account_concurrency_lease (
      lease_id               TEXT NOT NULL PRIMARY KEY,
      account_id             TEXT NOT NULL,
      run_id                 TEXT NOT NULL,
      candidate_index        INTEGER NOT NULL,
      attempt_id             TEXT NOT NULL REFERENCES execution_attempt(attempt_id),
      owner_id               TEXT NOT NULL,
      acquired_at            TEXT NOT NULL,
      renewed_at             TEXT NOT NULL,
      expires_at             TEXT NOT NULL,
      released_at            TEXT,
      fencing_revision       INTEGER NOT NULL,
      state                  TEXT NOT NULL,
      FOREIGN KEY (run_id, candidate_index)
        REFERENCES execution_candidate(run_id, candidate_index),
      CHECK (fencing_revision >= 1),
      CHECK (state IN ('active','released','expired'))
    ) STRICT`,
    `CREATE UNIQUE INDEX account_lease_attempt_active
      ON account_concurrency_lease(attempt_id) WHERE state = 'active'`,
    `CREATE INDEX account_lease_capacity
      ON account_concurrency_lease(account_id, state, expires_at)`,
    `CREATE TABLE scheduling_decision (
      decision_sequence      INTEGER PRIMARY KEY,
      decision_id            TEXT NOT NULL UNIQUE,
      run_id                 TEXT NOT NULL REFERENCES execution_schedule(run_id),
      stage_id               TEXT NOT NULL,
      candidate_index        INTEGER,
      profile_id             TEXT,
      account_id             TEXT,
      kind                   TEXT NOT NULL,
      reason_code            TEXT NOT NULL,
      recorded_at            TEXT NOT NULL,
      CHECK (candidate_index IS NULL OR candidate_index >= 0)
    ) STRICT`,
    "CREATE INDEX scheduling_decision_run ON scheduling_decision(run_id, decision_sequence)",
    `CREATE TRIGGER scheduling_decision_immutable_update BEFORE UPDATE ON scheduling_decision
      BEGIN SELECT RAISE(ABORT, 'scheduling decisions are immutable'); END`,
    `CREATE TRIGGER scheduling_decision_immutable_delete BEFORE DELETE ON scheduling_decision
      BEGIN SELECT RAISE(ABORT, 'scheduling decisions are immutable'); END`,
    `CREATE TABLE scheduling_capacity_question (
      run_id                 TEXT NOT NULL PRIMARY KEY REFERENCES execution_schedule(run_id),
      interaction_id        TEXT NOT NULL UNIQUE,
      question_json         TEXT NOT NULL CHECK (json_valid(question_json)),
      state                 TEXT NOT NULL,
      revision              INTEGER NOT NULL,
      answer_json           TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
      created_at            TEXT NOT NULL,
      answered_at           TEXT,
      CHECK (state IN ('pending','answered')),
      CHECK (revision >= 1)
    ) STRICT`,
    `CREATE TRIGGER scheduling_capacity_question_immutable
      BEFORE UPDATE OF interaction_id, question_json, created_at ON scheduling_capacity_question
      BEGIN SELECT RAISE(ABORT, 'scheduling capacity questions are immutable'); END`,
    `INSERT INTO execution_schedule
      (run_id, stage_id, codebase_id, repository_id, prompt, artifact_path,
       base_sha, hard_deadline_at, state, capacity_policy, requested_priority,
       current_candidate_index, current_attempt_id, revision, chain_json,
       requested_secret_ids_json, enqueued_at, updated_at)
      SELECT run_id, stage_id, codebase_id, repository_id, prompt, artifact_path, NULL, NULL,
        CASE
          WHEN status IN ('succeeded','failed','cancelled') THEN 'terminal'
          WHEN status = 'queued' THEN 'queued'
          ELSE 'running'
        END,
        'queue', 0, 0, 'legacy-attempt:' || run_id, 1,
        json_object('schemaVersion', 0, 'legacy', 1), json_array(), created_at, updated_at
      FROM stage_execution`,
    `INSERT INTO execution_candidate
      (run_id, candidate_index, profile_id, account_id, engine, max_concurrent_runs,
       profile_json, limits_json, permissions_json, state)
      SELECT run_id, 0, 'legacy', 'legacy-claudexor-v2', 'claude', 1,
        json_object('schemaVersion', 0, 'profileId', 'legacy'), limits_json,
        json_object('workspace', 'read-write', 'identifiers', json_array()),
        CASE
          WHEN status = 'succeeded' THEN 'succeeded'
          WHEN status IN ('failed','cancelled') THEN 'failed'
          WHEN status = 'queued' THEN 'queued'
          ELSE 'selected'
        END
      FROM stage_execution`,
    `INSERT INTO execution_attempt
      (attempt_id, run_id, stage_id, candidate_index, profile_id, account_id,
       workspace_id, backend_execution_id, status, limits_json, permissions_json,
       readonly_baseline_json, result_json, failure_json, started_at, finished_at, created_at, updated_at)
      SELECT 'legacy-attempt:' || run_id, run_id, stage_id, 0, 'legacy',
        'legacy-claudexor-v2', workspace_id, backend_execution_id, status, limits_json,
        json_object('schemaVersion', 1, 'workspace', 'read-write', 'identifiers', json_array()),
        NULL, NULL, NULL,
        CASE WHEN status = 'queued' THEN NULL ELSE created_at END,
        CASE WHEN status IN ('succeeded','failed','cancelled') THEN updated_at ELSE NULL END,
        created_at, updated_at
      FROM stage_execution`,
    `INSERT INTO account_capacity (account_id, max_concurrent_runs, updated_at)
      SELECT 'legacy-claudexor-v2', 1, COALESCE(max(updated_at), '1970-01-01T00:00:00.000Z')
      FROM stage_execution
      HAVING count(*) > 0`,
    `INSERT INTO account_concurrency_lease
      (lease_id, account_id, run_id, candidate_index, attempt_id, owner_id,
       acquired_at, renewed_at, expires_at, released_at, fencing_revision, state)
      SELECT 'legacy-lease:' || run_id, 'legacy-claudexor-v2', run_id, 0,
        'legacy-attempt:' || run_id, 'legacy-migration', created_at, updated_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+5 minutes'), NULL, 1, 'active'
      FROM stage_execution
      WHERE status NOT IN ('queued','succeeded','failed','cancelled')`,
    `INSERT INTO account_queue_entry
      (run_id, candidate_index, account_id, requested_priority, enqueued_at)
      SELECT run_id, 0, 'legacy-claudexor-v2', 0, created_at
      FROM stage_execution WHERE status = 'queued'`,
  ],
};
Object.freeze(MIGRATION_0010_ACCOUNT_SCHEDULING.statements);
Object.freeze(MIGRATION_0010_ACCOUNT_SCHEDULING);

/**
 * Migration 11 — the native Claude bridge (Q023, ADR 0021).
 *
 * Native stages get their own tables rather than reusing the scheduler's,
 * for three structural reasons rather than a stylistic one:
 *
 * 1. `account_queue_entry.account_id` is `NOT NULL` and the whole claim path
 *    groups and capacity-checks by account. A native profile has no account
 *    by construction — the resolver deletes it and emits
 *    `profile.native-account-forbidden`, because native execution inherits
 *    the connected parent session rather than selecting a billing account.
 *    Reusing the queue would mean inventing a synthetic account id and
 *    publishing it on `ExecutionAttempt/v1.accountId`, a value the user
 *    never configured, in a field whose meaning is "which account was
 *    billed".
 * 2. `execution_attempt` is `UNIQUE (run_id, candidate_index)` with an FK to
 *    `execution_candidate`: one attempt per candidate, forever. §9.5 says an
 *    interrupted native stage "may be retried from canonical run state, but
 *    that is a new attempt" — which that table cannot represent for a stage
 *    with a single native candidate. Hence `attempt_ordinal` here.
 * 3. `interaction_record.run_id` references `stage_execution(run_id)`, and
 *    foreign keys are on. A native run has no `stage_execution` row, so
 *    native questions need their own pair of tables — the same reason Q021
 *    built `scheduling_capacity_question` separately. Only the *storage* is
 *    separate; the *contracts* are reused verbatim, so a native question
 *    reaches the inbox and is answered exactly like any other.
 *
 * Nothing existing is touched: no CHECK widens, no table is rebuilt, and
 * there is no backfill. In particular `run_projection.status` needs no
 * change — it never had a CHECK, the vocabulary lives in `@heniek/contracts`,
 * and `waiting_for_parent_session` has been a legal `RunStatus` all along.
 * What was missing was an emitter, not a column.
 *
 * The fencing design is concentrated in `native_dispatch`. A dispatch is
 * one-shot (`dispatched`/`waiting_on_user` are the only non-terminal
 * states), at most one may be open per attempt (the partial unique index),
 * its binding to a run/stage/attempt is immutable after insert (trigger),
 * and its `revision` never moves backwards (trigger). Expiry does not merely
 * mark the *attempt* recovered — it terminates the *dispatch* and bumps that
 * revision, which is what stops a parent that slept through its lease from
 * waking up, rebinding, and submitting a result for a superseded attempt
 * while a newer one is already running. `expireOrphanLeases` in the
 * scheduling store does exactly the same thing for account leases.
 */
const MIGRATION_0011_NATIVE_BRIDGE: Migration = {
  version: 11,
  name: "native-bridge",
  statements: [
    `CREATE TABLE parent_session (
      session_id           TEXT    NOT NULL PRIMARY KEY,
      codebase_id          TEXT    NOT NULL REFERENCES codebase(codebase_id),
      state                TEXT    NOT NULL,
      revision             INTEGER NOT NULL,
      boot_witness         TEXT,
      process_witness_json TEXT             CHECK (process_witness_json IS NULL OR json_valid(process_witness_json)),
      attached_at          TEXT    NOT NULL,
      renewed_at           TEXT    NOT NULL,
      expires_at           TEXT    NOT NULL,
      released_at          TEXT,
      superseded_by        TEXT             REFERENCES parent_session(session_id),
      updated_at           TEXT    NOT NULL,
      CHECK (state IN ('attached','stalled','detached','expired','superseded')),
      CHECK (revision >= 1),
      CHECK (superseded_by IS NULL OR superseded_by <> session_id),
      CHECK ((state IN ('detached','expired','superseded')) = (released_at IS NOT NULL))
    ) STRICT`,
    `CREATE INDEX parent_session_live
      ON parent_session(codebase_id, state, expires_at)`,
    `CREATE TRIGGER parent_session_first_revision BEFORE INSERT ON parent_session
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first parent session revision must be 1'); END`,
    `CREATE TRIGGER parent_session_revision_advances BEFORE UPDATE ON parent_session
      WHEN NEW.revision < OLD.revision
      BEGIN SELECT RAISE(ABORT, 'a parent session revision must never move backwards'); END`,
    `CREATE TABLE native_stage (
      run_id               TEXT    NOT NULL PRIMARY KEY REFERENCES run_projection(run_id),
      stage_id             TEXT    NOT NULL UNIQUE,
      codebase_id          TEXT    NOT NULL REFERENCES codebase(codebase_id),
      repository_id        TEXT    NOT NULL REFERENCES repository(repository_id),
      profile_id           TEXT    NOT NULL,
      profile_json         TEXT    NOT NULL CHECK (json_valid(profile_json)),
      permissions_json     TEXT    NOT NULL CHECK (json_valid(permissions_json)),
      limits_json          TEXT    NOT NULL CHECK (json_valid(limits_json)),
      prompt               TEXT    NOT NULL,
      artifact_path        TEXT    NOT NULL,
      instructions_path    TEXT    NOT NULL,
      artifact_contract    TEXT    NOT NULL,
      model                TEXT    NOT NULL,
      effort               TEXT    NOT NULL,
      focus                TEXT,
      questions            TEXT    NOT NULL,
      base_sha             TEXT    NOT NULL,
      hard_deadline_at     TEXT,
      state                TEXT    NOT NULL,
      current_attempt_id   TEXT,
      attempt_count        INTEGER NOT NULL,
      revision             INTEGER NOT NULL,
      waiting_since        TEXT,
      created_at           TEXT    NOT NULL,
      updated_at           TEXT    NOT NULL,
      CHECK (state IN ('waiting_for_parent','dispatched','waiting_on_user','recovery_required','settled')),
      CHECK (questions IN ('parent-mediated','direct')),
      CHECK (revision >= 1),
      CHECK (attempt_count >= 0),
      CHECK ((state = 'waiting_for_parent') = (waiting_since IS NOT NULL))
    ) STRICT`,
    `CREATE INDEX native_stage_dispatchable
      ON native_stage(codebase_id, state, created_at, run_id)`,
    `CREATE TRIGGER native_stage_first_revision BEFORE INSERT ON native_stage
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first native stage revision must be 1'); END`,
    `CREATE TRIGGER native_stage_revision_advances BEFORE UPDATE ON native_stage
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'native stage update must advance revision by 1'); END`,
    `CREATE TRIGGER native_stage_identity_immutable BEFORE UPDATE ON native_stage
      WHEN NEW.stage_id <> OLD.stage_id OR NEW.codebase_id <> OLD.codebase_id
        OR NEW.repository_id <> OLD.repository_id OR NEW.artifact_path <> OLD.artifact_path
        OR NEW.base_sha <> OLD.base_sha
      BEGIN SELECT RAISE(ABORT, 'native stage identity is immutable'); END`,
    `CREATE TABLE native_stage_attempt (
      attempt_id             TEXT    NOT NULL PRIMARY KEY,
      run_id                 TEXT    NOT NULL REFERENCES native_stage(run_id),
      stage_id               TEXT    NOT NULL,
      attempt_ordinal        INTEGER NOT NULL,
      workspace_id           TEXT             REFERENCES workspace(workspace_id),
      readonly_baseline_json TEXT             CHECK (readonly_baseline_json IS NULL OR json_valid(readonly_baseline_json)),
      status                 TEXT    NOT NULL,
      result_json            TEXT             CHECK (result_json IS NULL OR json_valid(result_json)),
      failure_json           TEXT             CHECK (failure_json IS NULL OR json_valid(failure_json)),
      started_at             TEXT,
      finished_at            TEXT,
      created_at             TEXT    NOT NULL,
      updated_at             TEXT    NOT NULL,
      UNIQUE (run_id, attempt_ordinal),
      UNIQUE (attempt_id, run_id),
      CHECK (attempt_ordinal >= 1),
      CHECK (status IN ('running','waiting_on_user','recovery_required','succeeded','failed','cancelled')),
      CHECK ((status IN ('succeeded','failed','cancelled')) = (finished_at IS NOT NULL))
    ) STRICT`,
    `CREATE TABLE native_dispatch (
      dispatch_id            TEXT    NOT NULL PRIMARY KEY,
      run_id                 TEXT    NOT NULL,
      stage_id               TEXT    NOT NULL,
      attempt_id             TEXT    NOT NULL,
      session_id             TEXT    NOT NULL REFERENCES parent_session(session_id),
      state                  TEXT    NOT NULL,
      revision               INTEGER NOT NULL,
      terminal_reason        TEXT,
      outcome                TEXT,
      submission_id          TEXT,
      submission_digest      TEXT,
      result_json            TEXT             CHECK (result_json IS NULL OR json_valid(result_json)),
      issued_at              TEXT    NOT NULL,
      expires_at             TEXT    NOT NULL,
      settled_at             TEXT,
      updated_at             TEXT    NOT NULL,
      UNIQUE (dispatch_id, submission_id),
      FOREIGN KEY (attempt_id, run_id)
        REFERENCES native_stage_attempt(attempt_id, run_id),
      CHECK (state IN ('dispatched','waiting_on_user','submitted','revoked','abandoned')),
      CHECK (revision >= 1),
      CHECK (outcome IS NULL OR outcome IN ('succeeded','failed','cancelled')),
      CHECK ((state = 'submitted') = (outcome IS NOT NULL)),
      CHECK ((state = 'submitted') = (submission_id IS NOT NULL)),
      CHECK ((state = 'submitted') = (submission_digest IS NOT NULL)),
      CHECK ((state IN ('submitted','revoked','abandoned')) = (settled_at IS NOT NULL)),
      CHECK ((state IN ('revoked','abandoned')) = (terminal_reason IS NOT NULL))
    ) STRICT`,
    `CREATE UNIQUE INDEX native_dispatch_open_per_attempt
      ON native_dispatch(attempt_id) WHERE state IN ('dispatched','waiting_on_user')`,
    `CREATE INDEX native_dispatch_by_session
      ON native_dispatch(session_id, state, dispatch_id)`,
    `CREATE TRIGGER native_dispatch_binding_immutable BEFORE UPDATE ON native_dispatch
      WHEN NEW.run_id <> OLD.run_id OR NEW.stage_id <> OLD.stage_id
        OR NEW.attempt_id <> OLD.attempt_id OR NEW.issued_at <> OLD.issued_at
      BEGIN SELECT RAISE(ABORT, 'a dispatch binding is immutable'); END`,
    `CREATE TRIGGER native_dispatch_revision_advances BEFORE UPDATE ON native_dispatch
      WHEN NEW.revision < OLD.revision
      BEGIN SELECT RAISE(ABORT, 'a dispatch revision must never move backwards'); END`,
    `CREATE TRIGGER native_dispatch_settlement_final BEFORE UPDATE ON native_dispatch
      WHEN OLD.state IN ('submitted','revoked','abandoned') AND NEW.state <> OLD.state
      BEGIN SELECT RAISE(ABORT, 'a settled dispatch is terminal'); END`,
    `CREATE TABLE native_stage_question (
      run_id                 TEXT NOT NULL REFERENCES native_stage(run_id),
      interaction_id         TEXT NOT NULL,
      stage_id               TEXT NOT NULL,
      attempt_id             TEXT NOT NULL REFERENCES native_stage_attempt(attempt_id),
      dispatch_id            TEXT NOT NULL REFERENCES native_dispatch(dispatch_id),
      source_payload_json    TEXT NOT NULL CHECK (json_valid(source_payload_json)),
      canonical_payload_json TEXT NOT NULL CHECK (json_valid(canonical_payload_json)),
      requested_at           TEXT NOT NULL,
      timeout_at             TEXT,
      created_event_id       TEXT REFERENCES state_event(event_id),
      PRIMARY KEY (run_id, interaction_id)
    ) STRICT`,
    `CREATE TRIGGER native_stage_question_immutable_update BEFORE UPDATE ON native_stage_question
      BEGIN SELECT RAISE(ABORT, 'native stage questions are immutable'); END`,
    `CREATE TRIGGER native_stage_question_immutable_delete BEFORE DELETE ON native_stage_question
      BEGIN SELECT RAISE(ABORT, 'native stage questions are immutable'); END`,
    `CREATE TABLE native_question_projection (
      run_id                 TEXT    NOT NULL,
      interaction_id         TEXT    NOT NULL,
      state                  TEXT    NOT NULL,
      revision               INTEGER NOT NULL,
      delivery_state         TEXT    NOT NULL,
      cancellation_reason    TEXT,
      answer_json            TEXT             CHECK (answer_json IS NULL OR json_valid(answer_json)),
      answered_by_key_id     TEXT,
      answered_at            TEXT,
      resolved_at            TEXT,
      last_event_sequence    INTEGER NOT NULL REFERENCES state_event(sequence),
      updated_at             TEXT    NOT NULL,
      PRIMARY KEY (run_id, interaction_id),
      FOREIGN KEY (run_id, interaction_id)
        REFERENCES native_stage_question(run_id, interaction_id),
      CHECK (state IN ('pending','answered','cancelled')),
      CHECK (delivery_state IN ('not_applicable','pending','delivered')),
      CHECK (revision >= 1),
      CHECK ((state = 'answered') = (answer_json IS NOT NULL)),
      CHECK ((state = 'answered') = (answered_by_key_id IS NOT NULL)),
      CHECK ((state IN ('answered','cancelled')) = (resolved_at IS NOT NULL)),
      CHECK (cancellation_reason IS NULL OR cancellation_reason IN
        ('withdrawn','timed_out','run_terminal','migration_unresolved'))
    ) STRICT`,
    `CREATE INDEX native_question_inbox
      ON native_question_projection(state, updated_at, run_id, interaction_id)`,
    `CREATE INDEX native_question_undelivered
      ON native_question_projection(delivery_state, run_id, interaction_id)`,
    `CREATE TRIGGER native_question_first_revision BEFORE INSERT ON native_question_projection
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first native question revision must be 1'); END`,
    `CREATE TRIGGER native_question_causal_update BEFORE UPDATE ON native_question_projection
      WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'native question projection must advance revision by 1'); END`,
  ],
};
Object.freeze(MIGRATION_0011_NATIVE_BRIDGE.statements);
Object.freeze(MIGRATION_0011_NATIVE_BRIDGE);

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  MIGRATION_0001_JOURNAL,
  MIGRATION_0002_RUN_PROJECTION,
  MIGRATION_0003_IDENTITY,
  MIGRATION_0004_ARTIFACT,
  MIGRATION_0005_CODEBASE_REGISTRATION,
  MIGRATION_0006_WORKSPACE_LIFECYCLE,
  MIGRATION_0007_STAGE_EXECUTION,
  MIGRATION_0008_CAPABILITY_CACHE,
  MIGRATION_0009_DURABLE_INTERACTIONS,
  MIGRATION_0010_ACCOUNT_SCHEDULING,
  MIGRATION_0011_NATIVE_BRIDGE,
  MIGRATION_0012_PIPELINE_SCHEDULER,
  MIGRATION_0013_PIPELINE_RUNNER,
  MIGRATION_0014_PIPELINE_RUNNER_OPERATIONS,
  MIGRATION_0015_PIPELINE_RECOVERY,
  MIGRATION_0016_PIPELINE_FUSION,
  MIGRATION_0017_PIPELINE_FINDINGS,
  MIGRATION_0018_PIPELINE_ADMISSION,
  MIGRATION_0019_CAPABILITY_LANDING,
  MIGRATION_0020_WORKSPACE_VARIANTS,
  MIGRATION_0021_TASK_SOURCE,
]);
assertAppendOnly(MIGRATIONS);
