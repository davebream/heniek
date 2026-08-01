/**
 * The three special merge rules of spec §8.2 — "strictest hard limit wins",
 * "privacy tightened, never silently weakened", and "only pointers declared
 * overridable may be overridden at invocation" — expressed as data rather
 * than as branches inside the merge (design §4, "Policy rules").
 *
 * Rules are data because the merge must stay a pure fold over documents while
 * the *set* of protected pointers grows with the spec. A caller composes the
 * built-in policy with its own rules; nothing in `merge.ts` knows which
 * pointers are privacy pointers.
 */

import type { JsonPrimitive, JsonValue } from "../json.js";

export type ConfigurationRule =
  | {
      readonly kind: "hard-limit";
      readonly pointer: string;
      /** Which direction is *stricter*: a lower value, or a higher one. */
      readonly strictest: "lower" | "higher";
    }
  | {
      readonly kind: "ordered-privacy";
      readonly pointer: string;
      /** Allowed values, strictest first; index in this list *is* the strictness rank. */
      readonly strictestFirst: readonly JsonPrimitive[];
    }
  | { readonly kind: "overridable"; readonly pointer: string };

export interface ConfigurationPolicy {
  readonly rules: readonly ConfigurationRule[];
}

/**
 * Indexed view of a policy, built once per resolution so the merge does not
 * rescan the rule list per pointer. Separated from `ConfigurationPolicy`
 * because the public input stays a plain, hand-writable array while the
 * internal lookup can be a `Map`.
 */
export interface IndexedConfigurationPolicy {
  readonly hardLimits: ReadonlyMap<string, Extract<ConfigurationRule, { kind: "hard-limit" }>>;
  readonly privacy: ReadonlyMap<string, Extract<ConfigurationRule, { kind: "ordered-privacy" }>>;
  readonly overridable: ReadonlySet<string>;
}

/**
 * Indexes `policy`. Later rules of the same kind win for the same pointer, so
 * a caller can compose `{ rules: [...HENIEK_BUILT_IN_CONFIGURATION_POLICY.rules, ...mine] }`
 * and have its own rule replace a built-in one for that pointer — the same
 * "more specific last" convention the layers themselves use.
 */
export function indexConfigurationPolicy(policy: ConfigurationPolicy): IndexedConfigurationPolicy {
  const hardLimits = new Map<string, Extract<ConfigurationRule, { kind: "hard-limit" }>>();
  const privacy = new Map<string, Extract<ConfigurationRule, { kind: "ordered-privacy" }>>();
  const overridable = new Set<string>();
  for (const rule of policy.rules) {
    if (rule.kind === "hard-limit") {
      hardLimits.set(rule.pointer, rule);
      continue;
    }
    if (rule.kind === "ordered-privacy") {
      privacy.set(rule.pointer, rule);
      continue;
    }
    overridable.add(rule.pointer);
  }
  return { hardLimits, privacy, overridable };
}

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Normalises a hard-limit value to a single comparable number.
 *
 * Two kinds of value reach a §24 limit pointer: plain counts
 * (`max_concurrent_workers: 4`) and durations written the way the spec writes
 * them (`max_pipeline_duration: 4h`). Comparing durations as strings would be
 * actively wrong — `"30m" < "4h"` lexically, yet 30 minutes is the *stricter*
 * limit — so a duration is converted to milliseconds and compared as a
 * number. Anything else (a boolean, an unparseable string, a non-finite
 * number) returns `undefined`, and the caller reports it rather than guessing
 * an order for values that have none.
 */
export function hardLimitMagnitude(value: JsonValue): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const match = DURATION_PATTERN.exec(value);
  if (match === null) {
    return undefined;
  }
  // Both capture groups are guaranteed present by the pattern; the
  // non-null assertions the compiler would otherwise need are avoided by
  // reading through `?? ""` and letting `Number` reject the impossible case.
  const amount = Number(match[1] ?? "");
  const unit = DURATION_UNIT_MS[match[2] ?? ""];
  if (!Number.isFinite(amount) || unit === undefined) {
    return undefined;
  }
  return amount * unit;
}

/**
 * Strictness rank of `value` under an `ordered-privacy` rule: the index in
 * `strictestFirst`, where `0` is strictest. `undefined` means the value is not
 * one of the declared settings.
 *
 * An unranked value is *ignored* by the merge rather than allowed to win: it
 * cannot be shown to be a tightening, and a privacy setting that cannot be
 * shown to be a tightening must not take effect, or "never silently weakened"
 * would be defeated by any unrecognised string. Deciding whether such a value
 * is legal at all remains the schema layer's job; deciding that it may not
 * silently become the effective setting is this rule's.
 */
export function privacyRank(
  value: JsonValue,
  strictestFirst: readonly JsonPrimitive[],
): number | undefined {
  // `strictestFirst` only ever holds `JsonPrimitive`s (spec §27.1's privacy
  // values are all strings or booleans), so an array/object `value` can never
  // appear in it — narrowing here (rather than a `findIndex` predicate) is
  // both what lets `Array.prototype.indexOf` type-check against
  // `JsonPrimitive` and what Biome's `useIndexOf` rule prefers over an
  // equivalent `findIndex((candidate) => candidate === value)`.
  if (typeof value === "object" && value !== null) {
    return undefined;
  }
  const index = strictestFirst.indexOf(value);
  return index === -1 ? undefined : index;
}

/**
 * §24's four limits and §27.1's privacy block as policy, plus the pointers a
 * caller is allowed to override at invocation.
 *
 * Every limit is `strictest: "lower"`: each of the four caps an amount of
 * work or risk (duration, parallelism, repair attempts, graph revisions), so
 * a smaller number is always the safer one.
 *
 * The `overridable` set is deliberately narrow. Spec §8.2 makes "only
 * pointers declared overridable may be overridden at invocation" a *default
 * deny* — so the built-in policy declares only the limits, which §24 already
 * says a profile or stage may tighten. No privacy pointer is overridable at
 * invocation: `/privacy/*` is exactly the block §27.1 makes the confidential
 * default, and letting a command-line flag reach it would defeat both this
 * rule and the privacy rule above.
 */
export const HENIEK_BUILT_IN_CONFIGURATION_POLICY: ConfigurationPolicy = {
  rules: [
    { kind: "hard-limit", pointer: "/limits/max_pipeline_duration", strictest: "lower" },
    { kind: "hard-limit", pointer: "/limits/max_concurrent_workers", strictest: "lower" },
    { kind: "hard-limit", pointer: "/limits/max_repair_attempts", strictest: "lower" },
    { kind: "hard-limit", pointer: "/limits/max_graph_revisions", strictest: "lower" },
    {
      kind: "ordered-privacy",
      pointer: "/privacy/mode",
      strictestFirst: ["confidential", "internal", "open"],
    },
    {
      kind: "ordered-privacy",
      pointer: "/privacy/telemetry",
      strictestFirst: ["off", "anonymous"],
    },
    {
      kind: "ordered-privacy",
      pointer: "/privacy/crash_reports",
      strictestFirst: ["local", "upload"],
    },
    {
      kind: "ordered-privacy",
      pointer: "/privacy/include_repository_content",
      strictestFirst: [false, true],
    },
    { kind: "ordered-privacy", pointer: "/privacy/include_prompts", strictestFirst: [false, true] },
    { kind: "ordered-privacy", pointer: "/privacy/include_paths", strictestFirst: [false, true] },
    {
      kind: "ordered-privacy",
      pointer: "/privacy/diagnostics_export",
      strictestFirst: ["explicit", "automatic"],
    },
    { kind: "overridable", pointer: "/limits/max_pipeline_duration" },
    { kind: "overridable", pointer: "/limits/max_concurrent_workers" },
    { kind: "overridable", pointer: "/limits/max_repair_attempts" },
    { kind: "overridable", pointer: "/limits/max_graph_revisions" },
  ],
};
