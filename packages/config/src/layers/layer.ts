/**
 * The seven configuration layers of spec §8.2, least specific first, and the
 * document shape a caller hands to `resolveConfiguration` (design §4).
 *
 * The array order *is* the precedence order: a layer later in
 * `CONFIGURATION_LAYERS` overrides one earlier in it. Keeping precedence in a
 * single ordered constant — rather than a separate rank table that could drift
 * out of step with the union type — means adding a layer is one edit, and the
 * type and the ranking can never disagree.
 */

import type { JsonObject } from "../json.js";

export const CONFIGURATION_LAYERS = [
  "built-in-defaults",
  "global-defaults",
  "codebase",
  "repository",
  "pipeline-template",
  "profile-or-stage",
  "invocation-override",
] as const;

export type ConfigurationLayer = (typeof CONFIGURATION_LAYERS)[number];

/**
 * The most specific layer, named once here so the `overridable` policy gate
 * (design §4) does not hard-code the string at its use site.
 */
export const INVOCATION_OVERRIDE_LAYER: ConfigurationLayer = "invocation-override";

export interface ConfigurationLayerDocument {
  readonly layer: ConfigurationLayer;
  /**
   * Where the document came from, when it came from a file. Absent for
   * documents built in memory (the built-in defaults, an invocation override
   * assembled from CLI flags), which is why it is optional rather than an
   * empty string — `""` would render as a real-but-blank path in diagnostics.
   */
  readonly sourcePath?: string;
  readonly values: JsonObject;
}

const LAYER_RANK: ReadonlyMap<ConfigurationLayer, number> = new Map(
  CONFIGURATION_LAYERS.map((layer, index) => [layer, index] as const),
);

/**
 * Precedence rank of `layer`: lower is less specific. Unknown layers (only
 * reachable when a caller casts past the union) rank `-1`, sorting before
 * every real layer rather than throwing — a resolution pass should not crash
 * on a stray document, and ranking it least-specific means it can never
 * silently win over a declared layer.
 */
export function configurationLayerRank(layer: ConfigurationLayer): number {
  return LAYER_RANK.get(layer) ?? -1;
}

/**
 * Sorts `documents` by layer precedence, **stably**: several documents in the
 * same layer (several repositories, several stage settings) keep the caller's
 * order relative to each other, and precedence never depends on the caller
 * having sorted first (design §4, "Ordering").
 *
 * `Array.prototype.sort` is specified as stable since ES2019, so the explicit
 * index tiebreak other codebases add is unnecessary here; the copy is taken
 * because `sort` mutates in place and the input is `readonly`.
 */
export function sortConfigurationDocuments(
  documents: readonly ConfigurationLayerDocument[],
): readonly ConfigurationLayerDocument[] {
  return [...documents].sort(
    (a, b) => configurationLayerRank(a.layer) - configurationLayerRank(b.layer),
  );
}
