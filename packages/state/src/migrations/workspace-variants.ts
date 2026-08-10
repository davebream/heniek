import type { Migration } from "./migration.js";

/** Durable composite-variant inventory and append-only integration observations (Q036). */
export const MIGRATION_0020_WORKSPACE_VARIANTS: Migration = {
  version: 20,
  name: "workspace-variants",
  statements: [
    `CREATE TABLE workspace_variant_projection (
      variant_id        TEXT    NOT NULL PRIMARY KEY,
      workspace_id      TEXT    NOT NULL REFERENCES workspace(workspace_id),
      lifecycle_status  TEXT    NOT NULL,
      revision          INTEGER NOT NULL,
      manifest_json     TEXT    NOT NULL CHECK (json_valid(manifest_json)),
      updated_at        TEXT    NOT NULL,
      CHECK (revision >= 1),
      CHECK (lifecycle_status IN
        ('provisioning','ready','prepared','integrated','conflict','partial-progress','recovery-required'))
    ) STRICT`,
    `CREATE INDEX workspace_variant_workspace
      ON workspace_variant_projection(workspace_id, updated_at, variant_id)`,
    `CREATE TRIGGER workspace_variant_first_revision
      BEFORE INSERT ON workspace_variant_projection WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first workspace variant revision must be 1'); END`,
    `CREATE TRIGGER workspace_variant_causal_update
      BEFORE UPDATE ON workspace_variant_projection WHEN NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'workspace variant projection must advance revision by 1'); END`,
    `CREATE TRIGGER workspace_variant_immutable_delete
      BEFORE DELETE ON workspace_variant_projection
      BEGIN SELECT RAISE(ABORT, 'workspace variant projections cannot be deleted'); END`,
    `CREATE TABLE workspace_variant_integration_trace (
      variant_id       TEXT    NOT NULL REFERENCES workspace_variant_projection(variant_id),
      sequence         INTEGER NOT NULL,
      trace_json       TEXT    NOT NULL CHECK (json_valid(trace_json)),
      recorded_at      TEXT    NOT NULL,
      PRIMARY KEY (variant_id, sequence)
    ) STRICT`,
    `CREATE TRIGGER workspace_variant_trace_immutable_update
      BEFORE UPDATE ON workspace_variant_integration_trace
      BEGIN SELECT RAISE(ABORT, 'workspace variant traces are immutable'); END`,
    `CREATE TRIGGER workspace_variant_trace_immutable_delete
      BEFORE DELETE ON workspace_variant_integration_trace
      BEGIN SELECT RAISE(ABORT, 'workspace variant traces are immutable'); END`,
  ],
};
Object.freeze(MIGRATION_0020_WORKSPACE_VARIANTS.statements);
Object.freeze(MIGRATION_0020_WORKSPACE_VARIANTS);
