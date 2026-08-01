/**
 * The `built-in-defaults` layer: spec §27.1's confidential-code privacy block
 * and spec §24's limits, shipped as the least specific document so a caller
 * that supplies nothing at all still resolves to the values the spec states
 * (design §4).
 *
 * The values are transcribed from the spec's own YAML, including
 * `max_pipeline_duration: 4h` as the string the spec writes rather than a
 * pre-converted number of seconds — the document is what a user would see if
 * they wrote the defaults out by hand, and `hardLimitMagnitude` in `policy.ts`
 * is what makes `4h` comparable against a stricter `30m`.
 */

import type { JsonObject } from "../json.js";
import type { ConfigurationLayerDocument } from "./layer.js";

/** Spec §27.1 — the confidential-code default. */
export const HENIEK_BUILT_IN_PRIVACY_DEFAULTS: JsonObject = {
  mode: "confidential",
  telemetry: "off",
  crash_reports: "local",
  include_repository_content: false,
  include_prompts: false,
  include_paths: false,
  diagnostics_export: "explicit",
};

/** Spec §24 — the layered limits. */
export const HENIEK_BUILT_IN_LIMIT_DEFAULTS: JsonObject = {
  max_pipeline_duration: "4h",
  max_concurrent_workers: 4,
  max_repair_attempts: 3,
  max_graph_revisions: 5,
};

export const HENIEK_BUILT_IN_DEFAULT_VALUES: JsonObject = {
  limits: HENIEK_BUILT_IN_LIMIT_DEFAULTS,
  privacy: HENIEK_BUILT_IN_PRIVACY_DEFAULTS,
};

/**
 * The built-in defaults as a ready-to-pass document. It carries no
 * `sourcePath`: it comes from this module, not from a file, and giving it a
 * fake path would make diagnostics point at something a user cannot open.
 */
export const HENIEK_BUILT_IN_DEFAULTS: ConfigurationLayerDocument = {
  layer: "built-in-defaults",
  values: HENIEK_BUILT_IN_DEFAULT_VALUES,
};
