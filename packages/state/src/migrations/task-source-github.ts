import type { Migration } from "./migration.js";

/** Q046 immutable external observations, pending updates, and synchronization audit. */
export const MIGRATION_0027_TASK_SOURCE_GITHUB: Migration = {
  version: 27,
  name: "task-source-github",
  statements: [
    `CREATE TABLE task_source_component_observation (
      snapshot_id       TEXT NOT NULL REFERENCES task_source_snapshot(snapshot_id),
      component_id      TEXT NOT NULL,
      uri               TEXT NOT NULL,
      observed_version  TEXT NOT NULL,
      content_sha256    TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, component_id),
      CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')
    ) STRICT`,
    `CREATE TRIGGER task_source_component_observation_immutable_update
      BEFORE UPDATE ON task_source_component_observation
      BEGIN SELECT RAISE(ABORT, 'task source component observations are immutable'); END`,
    `CREATE TRIGGER task_source_component_observation_immutable_delete
      BEFORE DELETE ON task_source_component_observation
      BEGIN SELECT RAISE(ABORT, 'task source component observations are immutable'); END`,
    `CREATE TABLE task_source_update_proposal (
      proposal_id          TEXT NOT NULL PRIMARY KEY,
      source_work_item_id  TEXT NOT NULL,
      base_snapshot_id     TEXT NOT NULL REFERENCES task_source_snapshot(snapshot_id),
      observed_snapshot_id TEXT NOT NULL UNIQUE REFERENCES task_source_snapshot(snapshot_id),
      status               TEXT NOT NULL,
      proposal_json        TEXT NOT NULL CHECK (json_valid(proposal_json)),
      created_at           TEXT NOT NULL,
      decided_at           TEXT,
      CHECK (status IN ('pending','accepted','rejected')),
      CHECK ((status = 'pending') = (decided_at IS NULL))
    ) STRICT`,
    `CREATE INDEX task_source_update_proposal_source
      ON task_source_update_proposal(source_work_item_id, created_at, proposal_id)`,
    `CREATE TRIGGER task_source_update_proposal_causal_update
      BEFORE UPDATE ON task_source_update_proposal
      WHEN OLD.status <> 'pending' OR NEW.proposal_id <> OLD.proposal_id
        OR NEW.source_work_item_id <> OLD.source_work_item_id
        OR NEW.base_snapshot_id <> OLD.base_snapshot_id
        OR NEW.observed_snapshot_id <> OLD.observed_snapshot_id
        OR NEW.created_at <> OLD.created_at
        OR NEW.status NOT IN ('accepted','rejected') OR NEW.decided_at IS NULL
      BEGIN SELECT RAISE(ABORT, 'task source update proposal may only be decided once'); END`,
    `CREATE TRIGGER task_source_update_proposal_immutable_delete
      BEFORE DELETE ON task_source_update_proposal
      BEGIN SELECT RAISE(ABORT, 'task source update proposals cannot be deleted'); END`,
    `CREATE TABLE task_source_synchronization_claim (
      synchronization_id         TEXT NOT NULL PRIMARY KEY,
      source_work_item_id        TEXT NOT NULL,
      source_uri                 TEXT NOT NULL,
      idempotency_key            TEXT NOT NULL UNIQUE,
      proposal_sha256            TEXT NOT NULL,
      expected_observed_version  TEXT NOT NULL,
      actor                      TEXT NOT NULL,
      claimed_at                 TEXT NOT NULL,
      CHECK (length(proposal_sha256) = 64 AND proposal_sha256 NOT GLOB '*[^0-9a-f]*')
    ) STRICT`,
    `CREATE TRIGGER task_source_synchronization_claim_immutable_update
      BEFORE UPDATE ON task_source_synchronization_claim
      BEGIN SELECT RAISE(ABORT, 'task source synchronization claims are immutable'); END`,
    `CREATE TRIGGER task_source_synchronization_claim_immutable_delete
      BEFORE DELETE ON task_source_synchronization_claim
      BEGIN SELECT RAISE(ABORT, 'task source synchronization claims cannot be deleted'); END`,
    `CREATE TABLE task_source_synchronization_audit (
      synchronization_id  TEXT NOT NULL PRIMARY KEY
        REFERENCES task_source_synchronization_claim(synchronization_id),
      idempotency_key      TEXT NOT NULL UNIQUE,
      outcome              TEXT NOT NULL,
      audit_json           TEXT NOT NULL CHECK (json_valid(audit_json)),
      completed_at         TEXT NOT NULL,
      CHECK (outcome IN ('posted','adopted','conflict'))
    ) STRICT`,
    `CREATE TRIGGER task_source_synchronization_audit_immutable_update
      BEFORE UPDATE ON task_source_synchronization_audit
      BEGIN SELECT RAISE(ABORT, 'task source synchronization audits are immutable'); END`,
    `CREATE TRIGGER task_source_synchronization_audit_immutable_delete
      BEFORE DELETE ON task_source_synchronization_audit
      BEGIN SELECT RAISE(ABORT, 'task source synchronization audits cannot be deleted'); END`,
  ],
};
Object.freeze(MIGRATION_0027_TASK_SOURCE_GITHUB.statements);
Object.freeze(MIGRATION_0027_TASK_SOURCE_GITHUB);
