/** Migration 19 — durable capability landing and scheduling request context. */

import type { Migration } from "./migration.js";

/** Schema version that introduces capability landing columns. */
export const CAPABILITY_LANDING_SCHEMA_VERSION = 19;

export const MIGRATION_0019_CAPABILITY_LANDING: Migration = {
  version: CAPABILITY_LANDING_SCHEMA_VERSION,
  name: "capability-landing",
  statements: [
    "ALTER TABLE run_projection ADD COLUMN capability_landing_json TEXT CHECK (capability_landing_json IS NULL OR json_valid(capability_landing_json))",
    "ALTER TABLE execution_schedule ADD COLUMN capability_request_json TEXT CHECK (capability_request_json IS NULL OR json_valid(capability_request_json))",
    "ALTER TABLE execution_candidate ADD COLUMN capability_delta_json TEXT CHECK (capability_delta_json IS NULL OR json_valid(capability_delta_json))",
  ],
};
Object.freeze(MIGRATION_0019_CAPABILITY_LANDING.statements);
Object.freeze(MIGRATION_0019_CAPABILITY_LANDING);
