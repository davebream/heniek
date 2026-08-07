import type { TSchema } from "@sinclair/typebox";

/**
 * Every public versioned contract schema, keyed by its `$id`. Populated
 * exclusively by `versioned()` — never write to this map directly.
 */
export const SCHEMA_REGISTRY: Map<string, TSchema> = new Map();
