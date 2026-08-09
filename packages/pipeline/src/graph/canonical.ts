/**
 * The two ordering primitives the normalizer and the renderer share.
 *
 * Both exist because sorting is what makes the graph a stable diff target,
 * and both are deliberately the *boring* implementations: a locale-aware
 * comparison or a bespoke serialiser would each reintroduce exactly the
 * nondeterminism they are here to remove.
 */

import type { JsonValue } from "@heniek/config";
import { canonicalJsonStringify } from "@heniek/config";

/**
 * Codepoint comparison, matching `@heniek/config`'s diagnostic ordering and
 * `canonicalJsonStringify`'s key sort. `localeCompare` is locale- and
 * ICU-version-dependent — the same two stage ids can order differently across
 * Node builds — which is the one property a canonical ordering may not have.
 */
export function compareCodepoints(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * A value's canonical text, used as a sort key and as an identity for
 * deduplication. Runs through the same serialiser the rendered graph uses, so
 * "these two sort as equal" and "these two render identically" can never
 * disagree.
 */
export function canonicalText(value: unknown): string {
  return canonicalJsonStringify(value as JsonValue);
}
