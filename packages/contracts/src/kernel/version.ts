import { type TProperties, Type } from "@sinclair/typebox";
import { SCHEMA_REGISTRY } from "./registry.js";

/**
 * Declares one versioned public contract schema. Every call site produces
 * an object schema carrying:
 *
 * - `$id` — schema identity, stable across versions of the same contract;
 * - `schemaVersion` — a runtime discriminator literal, bumped whenever the
 *   shape changes incompatibly;
 * - `additionalProperties: false` — closed shape, rejects unknown fields.
 *
 * `$id` and `schemaVersion` are deliberately non-redundant: `$id` identifies
 * *which* contract a payload claims to be, `schemaVersion` identifies
 * *which revision* of it. The schema is also registered into
 * `SCHEMA_REGISTRY` for codegen and manifest generation.
 */
export function versioned<Name extends string, Version extends number, P extends TProperties>(
  name: Name,
  version: Version,
  properties: P,
) {
  const schemaId = `heniek://contract/${name}/v${version}`;
  if (SCHEMA_REGISTRY.has(schemaId)) {
    throw new Error(`Duplicate contract schema id: ${schemaId}`);
  }

  const schema = Type.Object(
    { schemaVersion: Type.Literal(version), ...properties },
    { $id: schemaId, additionalProperties: false },
  );

  SCHEMA_REGISTRY.set(schemaId, schema);
  return schema;
}
