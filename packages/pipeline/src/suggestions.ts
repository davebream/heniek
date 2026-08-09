/**
 * Suggestions for the diagnostics this package does not raise itself.
 *
 * A pipeline document passes through two layers before any pipeline rule
 * runs: `@heniek/config`'s restricted-YAML subset, and Ajv against
 * `PipelineDefinition/v1`. Both produce good, located, correctly-coded
 * diagnostics — and neither knows what a pipeline is, so neither can say what
 * to write instead. This module supplies that half, so the "every diagnostic
 * carries a suggested correction" guarantee holds across the whole surface
 * rather than only across the part this package authored.
 */

import type { Diagnostic } from "@heniek/config";
import type { PipelineDiagnostic } from "./diagnostics.js";

const STAGE_TYPES = "agent, command, approval, integration, verify, publish";

/**
 * One suggestion per code raised by the YAML subset and the schema layer.
 * `configuration.schema-violation` is absent on purpose: it is the one code
 * whose useful advice depends on *where* the violation is, and it is routed
 * through `suggestionForPointer` instead.
 */
const INHERITED_SUGGESTIONS: ReadonlyMap<string, string> = new Map([
  [
    "yaml.syntax-error",
    "Fix the YAML syntax at this position — check indentation, a missing colon, or an unclosed quote.",
  ],
  [
    "yaml.duplicate-key",
    "Remove one of the two entries with this key; a pipeline document may not set the same key twice.",
  ],
  [
    "yaml.alias-not-supported",
    "Write the value out in full. Aliases (`*name`) are outside the restricted YAML subset, so a pipeline file always reads the same way it runs.",
  ],
  [
    "yaml.anchor-not-supported",
    "Remove the anchor (`&name`) and write the value out in full; share repeated configuration through a profile instead.",
  ],
  [
    "yaml.merge-key-not-supported",
    "Remove the `<<` merge key and write the merged keys out in full.",
  ],
  [
    "yaml.custom-tag-not-supported",
    "Remove the `!tag`. Only the seven core YAML types are accepted.",
  ],
  ["yaml.non-string-key-not-supported", "Use a plain string key, for example `id: critique`."],
  [
    "yaml.unsafe-key-not-supported",
    "Rename the key — `__proto__`, `constructor`, and `prototype` are reserved.",
  ],
  [
    "yaml.ambiguous-scalar",
    'Quote the value ("yes", "007") so every YAML reader interprets it the same way.',
  ],
  [
    "yaml.non-json-value",
    "Quote the value so it stays a string; a pipeline graph is serialised as JSON, which has no representation for this scalar.",
  ],
  [
    "yaml.sensitive-value-not-allowed",
    "Move the value into the secret store and reference it by name; credentials never belong in a pipeline file.",
  ],
  [
    "yaml.multiple-documents-not-supported",
    "Split the documents into one file each — a pipeline file holds exactly one definition.",
  ],
  [
    "yaml.max-depth-exceeded",
    "Flatten the document; nesting this deep is beyond the supported pipeline shape.",
  ],
  [
    "yaml.source-too-large",
    "Split the pipeline into smaller definitions — a hand-authored pipeline file is never legitimately this large.",
  ],
  [
    "configuration.schema-invalid",
    "This is a defect in the pipeline schema itself, not in the document; report it with the message above.",
  ],
]);

/**
 * Pointer-shaped advice for `configuration.schema-violation`, keyed by the
 * *normalized* pointer — every array index replaced by a star, so one entry
 * covers `/stages/0/type` and `/stages/17/type` alike.
 *
 * Resolution walks up: an unmatched `/stages/3/completion/require/1/artifact`
 * falls back to its parent (the starred `completion/require` entry below),
 * and only a pointer with no matching ancestor reaches the generic advice.
 * That keeps the table small without leaving deep pointers unhelped.
 */
const POINTER_SUGGESTIONS: ReadonlyMap<string, string> = new Map([
  ["", "A pipeline document is a mapping with at least `schemaVersion`, `id`, and `stages`."],
  ["/schemaVersion", "Declare the schema version explicitly: `schemaVersion: 1`."],
  ["/id", "Give the pipeline a name like `careful-epic` — letters, digits, `.`, `_`, and `-`."],
  ["/name", "Use a non-empty string, or remove the key."],
  ["/description", "Use a non-empty string, or remove the key."],
  ["/mode", "Use `autonomous` or `hitl` (§14.5)."],
  ["/stages", "Declare at least one stage under `stages:`."],
  ["/stages/*", "A stage is a mapping with at least `id` and `type`."],
  ["/stages/*/id", "Give the stage a name like `critique` — letters, digits, `.`, `_`, and `-`."],
  ["/stages/*/type", `Use one of the v1 stage types: ${STAGE_TYPES}.`],
  ["/stages/*/mode", "Use `autonomous` or `hitl`, or remove the key to inherit the pipeline mode."],
  ["/stages/*/optional", "Use `true` or `false`."],
  ["/stages/*/profile", "Name a profile declared in your configuration, for example `sol-critic`."],
  ["/stages/*/needs", "List the stage ids this stage waits for, for example `needs: [design]`."],
  [
    "/stages/*/reads",
    "List dotted state references, for example `task.current` or `artifacts.design.selected`.",
  ],
  [
    "/stages/*/writes",
    "List dotted state references this stage produces, for example `artifacts.critique`.",
  ],
  [
    "/stages/*/overridable",
    "List field names an invocation may override, for example `[effort, max_duration]`.",
  ],
  ["/stages/*/session", "Declare `session: { policy: fresh }` or `policy: resume` (§15.2)."],
  ["/stages/*/session/policy", "Use `fresh` or `resume`."],
  [
    "/stages/*/limits/max_duration",
    "Write a duration like `30m`, `4h`, or `500ms` — a positive number followed by ms, s, m, h, or d.",
  ],
  ["/stages/*/limits/max_repair_attempts", "Use a whole number of attempts, for example `2`."],
  [
    "/stages/*/command",
    "A command stage declares `command: { argv: [...] }`, optionally with `cwd` and `env`.",
  ],
  [
    "/stages/*/command/argv",
    "List the executable and its arguments separately, for example `[pnpm, test]` — argv is never a shell string.",
  ],
  [
    "/stages/*/completion/require",
    "List completion requirements, for example `[valid_result_envelope, { artifact: critique-report }]` (§19.5).",
  ],
  [
    "/stages/*/completion/require/*",
    "Use `valid_result_envelope`, `non_empty_diff`, or a single-key mapping: `artifact`, `schema_check`, `sections`, `command`, `repository_state`, or `verdict`.",
  ],
  [
    "/stages/*/on_validation_failure/strategy",
    "Use `pause`, `fail`, `repair`, `repair_fresh`, or `delegate` (§19.6).",
  ],
  ["/stages/*/on_validation_failure/session", "Use `fresh` or `resume`."],
  [
    "/stages/*/on_validation_failure/max_attempts",
    "Use a positive whole number — repair is bounded, never open-ended.",
  ],
  [
    "/stages/*/on_validation_failure/delegate_to",
    "Name the profile repair is delegated to; required only when `strategy: delegate`.",
  ],
  ["/stages/*/transitions/*", "A transition is `{ when: { ... }, then: <stage id> }` (§14.4)."],
  [
    "/stages/*/transitions/*/when",
    'Use either `{ expression: "..." }` for a deterministic condition or `{ evaluator: <profile>, question: "..." }` for a judged one — never both.',
  ],
  ["/stages/*/transitions/*/then", "Name the stage this transition leads to."],
  ["/edges", "List explicit edges as `{ from: <stage id>, to: <stage id> }`."],
  ["/edges/*", "An edge is `{ from: <stage id>, to: <stage id> }`, optionally with `when`."],
  ["/edges/*/from", "Name the stage this edge leaves."],
  ["/edges/*/to", "Name the stage this edge enters."],
  [
    "/edges/*/when",
    'Use either `{ expression: "..." }` for a deterministic condition or `{ evaluator: <profile>, question: "..." }` for a judged one — never both.',
  ],
  [
    "/limits/max_pipeline_duration",
    "Write a duration like `4h` — a positive number followed by ms, s, m, h, or d.",
  ],
  ["/limits/max_concurrent_workers", "Use a positive whole number, for example `4`."],
  ["/limits/max_repair_attempts", "Use a whole number of attempts, for example `3`."],
  ["/limits/max_graph_revisions", "Use a positive whole number, for example `5`."],
  ["/limits", "Declare only §24's four limits under `limits:`."],
  [
    "/context/handoff_soft_threshold",
    "Use a fraction between 0 and 1, for example `0.65` (§15.3).",
  ],
  [
    "/context/handoff_hard_threshold",
    "Use a fraction between 0 and 1, for example `0.80` (§15.3).",
  ],
]);

const GENERIC_SCHEMA_SUGGESTION =
  "Check this value against the pipeline schema (heniek://contract/PipelineDefinition/v1).";

/** Replaces every all-digit pointer segment with `*`, so one table entry covers every index. */
function normalizePointer(pointer: string): string {
  if (pointer === "") {
    return "";
  }
  return pointer
    .split("/")
    .map((segment, index) => (index > 0 && /^[0-9]+$/.test(segment) ? "*" : segment))
    .join("/");
}

/**
 * Advice for a schema violation at `pointer`, falling back to the nearest
 * ancestor with an entry and finally to the generic message. Never returns
 * `undefined`: a violation the table has never seen still gets pointed at the
 * published schema, which beats saying nothing.
 */
export function suggestionForPointer(pointer: string | undefined): string {
  let current = normalizePointer(pointer ?? "");
  // The walk stops *above* the document root rather than at it. The root
  // entry describes the document as a whole, which is the right advice for a
  // violation reported at the root and useless for one reported six levels
  // down under a key the table has never seen — falling through to it would
  // answer "what should `/nothing/like/this` be?" with "a pipeline document
  // is a mapping", which is true and unhelpful.
  while (current !== "") {
    const match = POINTER_SUGGESTIONS.get(current);
    if (match !== undefined) {
      return match;
    }
    const lastSlash = current.lastIndexOf("/");
    /* c8 ignore next 3 -- a normalized pointer always starts with "/", so the index is never negative */
    if (lastSlash < 0) {
      break;
    }
    current = current.slice(0, lastSlash);
  }
  if (normalizePointer(pointer ?? "") === "") {
    return POINTER_SUGGESTIONS.get("") ?? GENERIC_SCHEMA_SUGGESTION;
  }
  return GENERIC_SCHEMA_SUGGESTION;
}

/** Ajv's own wording for a failed union, matched so it can be replaced and used as a collapse marker. */
const ANY_OF_SUFFIX = "must match a schema in anyOf";

const SCHEMA_VIOLATION = "configuration.schema-violation";

/**
 * Collapses the diagnostic storm Ajv's `allErrors: true` produces for a union.
 *
 * A stage `type` outside the six v1 values fails all six literal branches
 * *and* the enclosing `anyOf`, so a single typo arrives as seven diagnostics
 * with the same pointer, the same position, and — because the suggestion is
 * keyed by pointer — the same correction repeated seven times. A reader
 * scanning that output learns nothing from occurrences two through seven, and
 * a checked-in diagnostic corpus grows by six lines that say nothing.
 *
 * Two rules, in order:
 *
 * 1. where a pointer has an `anyOf` summary, the per-branch explanations of
 *    that same summary are dropped — they are the *reasons* the union failed,
 *    one per alternative, and naming every alternative that did not match is
 *    not how a person diagnoses "which alternative did I mean";
 * 2. anything still exactly identical to something already kept is dropped.
 *
 * Distinct violations at one pointer that are *not* union branches (a
 * `minLength` and a `pattern` on the same string, say) survive both rules,
 * because they are genuinely two different things to fix.
 */
export function collapseSchemaViolations<T extends Diagnostic>(
  diagnostics: readonly T[],
): readonly T[] {
  const summarised = new Set(
    diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.code === SCHEMA_VIOLATION && diagnostic.message.endsWith(ANY_OF_SUFFIX),
      )
      .map((diagnostic) => diagnostic.pointer ?? ""),
  );

  const seen = new Set<string>();
  const kept: T[] = [];
  for (const diagnostic of diagnostics) {
    if (
      diagnostic.code === SCHEMA_VIOLATION &&
      summarised.has(diagnostic.pointer ?? "") &&
      !diagnostic.message.endsWith(ANY_OF_SUFFIX)
    ) {
      continue;
    }
    const identity = JSON.stringify([
      diagnostic.code,
      diagnostic.severity,
      diagnostic.message,
      diagnostic.pointer,
      diagnostic.line,
      diagnostic.column,
    ]);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    kept.push(diagnostic);
  }
  return kept;
}

/**
 * Attaches a suggestion to a diagnostic produced by the YAML or schema layer,
 * and rewrites Ajv's union wording.
 *
 * "must match a schema in anyOf" describes the validator's internals, not the
 * author's mistake; the suggestion right beneath it already enumerates the
 * accepted alternatives, so the message only has to say which value is wrong.
 *
 * A diagnostic that already carries a suggestion is returned untouched, so a
 * caller that knows better than the table always wins.
 */
export function withSuggestion(diagnostic: Diagnostic): PipelineDiagnostic {
  if ("suggestion" in diagnostic && typeof diagnostic.suggestion === "string") {
    return diagnostic as PipelineDiagnostic;
  }
  const suggestion =
    INHERITED_SUGGESTIONS.get(diagnostic.code) ??
    (diagnostic.code === SCHEMA_VIOLATION
      ? suggestionForPointer(diagnostic.pointer)
      : GENERIC_SCHEMA_SUGGESTION);
  const message =
    diagnostic.code === SCHEMA_VIOLATION && diagnostic.message.endsWith(ANY_OF_SUFFIX)
      ? `${diagnostic.pointer === undefined || diagnostic.pointer === "" ? "(root)" : diagnostic.pointer} does not match any of the accepted alternatives.`
      : diagnostic.message;
  return { ...diagnostic, message, suggestion };
}
