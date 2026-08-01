/**
 * Layer resolution (spec §8.2, design §4): fold the seven configuration
 * layers into one frozen JSON document, record where every leaf came from and
 * what it overrode, and enforce the three policy rules.
 *
 * The whole module is a pure function of its inputs — no filesystem, no
 * environment, no clock. Reading the documents off disk is the caller's job
 * (the imperative shell); deciding what wins is this file's (the functional
 * core), which is what makes "same documents in, byte-identical snapshot out"
 * testable without touching a disk.
 */

import { redactJson } from "@heniek/secrets";
import { createDiagnostic, type Diagnostic, sortDiagnostics } from "../diagnostics.js";
import { deepFreeze, type JsonObject, type JsonValue, joinPointer } from "../json.js";
import {
  CONFIGURATION_LAYERS,
  type ConfigurationLayer,
  type ConfigurationLayerDocument,
  INVOCATION_OVERRIDE_LAYER,
  sortConfigurationDocuments,
} from "./layer.js";
import {
  type ConfigurationPolicy,
  hardLimitMagnitude,
  type IndexedConfigurationPolicy,
  indexConfigurationPolicy,
  privacyRank,
} from "./policy.js";

export interface ConfigurationProvenanceEntry {
  readonly layer: ConfigurationLayer;
  readonly sourcePath?: string;
  readonly value: JsonValue;
}

export interface ConfigurationProvenance {
  readonly pointer: string;
  readonly layer: ConfigurationLayer;
  readonly sourcePath?: string;
  readonly value: JsonValue;
  /** Every other layer that wrote this pointer, least specific first. */
  readonly overridden: readonly ConfigurationProvenanceEntry[];
}

export interface ResolvedConfiguration {
  /** The layers that actually contributed a document, in precedence order. */
  readonly layers: readonly ConfigurationLayer[];
  readonly values: JsonObject;
  readonly provenance: readonly ConfigurationProvenance[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface ResolveConfigurationInput {
  readonly documents: readonly ConfigurationLayerDocument[];
  /**
   * Defaults to the empty policy. Note what that means for the third §8.2
   * rule, which is a *default deny*: with no rules, no pointer is declared
   * `overridable`, so every `invocation-override` write is dropped and
   * reported. That is the safe direction to fail — an override silently
   * taking effect because the caller forgot to pass a policy would be the
   * dangerous one — and callers wanting the spec's behaviour pass
   * `HENIEK_BUILT_IN_CONFIGURATION_POLICY`.
   */
  readonly policy?: ConfigurationPolicy;
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges `incoming` over `base`.
 *
 * Objects merge key-wise; **arrays and scalars replace wholesale**. Arrays are
 * atomic by decision (design §4): element-wise list merging has no unambiguous
 * semantics — there is no answer to "is the third element of the base list the
 * same entity as the third element of the override" — and it would make
 * "which layer produced this value" unanswerable, which is exactly what AC2
 * requires an answer to. `null` is a value like any other, not a deletion
 * marker: a layer that sets `null` wins with `null`.
 */
function mergeJsonValue(base: JsonValue | undefined, incoming: JsonValue): JsonValue {
  if (!isPlainObject(incoming) || !isPlainObject(base)) {
    return incoming;
  }
  // Null-prototype accumulator, not `{ ...base }` followed by bracket
  // assignment. `{...base}` itself would be safe on its own — object spread
  // uses `CopyDataProperties`/`[[DefineOwnProperty]]`, which never invokes an
  // inherited setter — but the loop below assigns into the accumulator with
  // ordinary bracket assignment (`merged[key] = ...`), which *is* a `[[Set]]`
  // and, on an `Object.prototype`-rooted object, invokes the inherited
  // `__proto__` accessor's setter when `key === "__proto__"` — reassigning
  // `merged`'s own prototype instead of creating a data property. A document
  // carrying an own `__proto__` key is reachable here: `HENIEK_BUILT_IN_DEFAULTS`
  // and an `invocation-override` document built programmatically never pass
  // through the restricted-YAML guard's `RESERVED_KEY_NAMES` check (that
  // guard only runs on file-sourced YAML). `Object.create(null)` has no
  // inherited setter to invoke, so the assignment always creates an ordinary
  // own property — matching `@heniek/secrets`' `redactJson`
  // (`packages/secrets/src/redaction.ts`).
  const merged = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(base)) {
    merged[key] = base[key] as JsonValue;
  }
  for (const key of Object.keys(incoming)) {
    // `incoming[key]` is present by construction (the key came from
    // `Object.keys`), but reading it through a local keeps the index
    // signature's `JsonValue` type without a non-null assertion.
    const incomingChild = incoming[key] as JsonValue;
    merged[key] = mergeJsonValue(merged[key], incomingChild);
  }
  return merged;
}

function pathToPointer(path: readonly string[]): string {
  return path.reduce<string>((pointer, segment) => joinPointer(pointer, segment), "");
}

/**
 * Collects the path of every **leaf** in `value` — a scalar or an array,
 * arrays being atomic. Paths are collected as raw segment arrays rather than
 * as encoded JSON Pointers so that looking the same location up inside a
 * source document never has to *un*escape a pointer; the encoded form is
 * produced once, at the edge, for output.
 */
function collectLeafPaths(value: JsonValue, path: readonly string[], out: string[][]): void {
  if (!isPlainObject(value)) {
    out.push([...path]);
    return;
  }
  for (const key of Object.keys(value)) {
    collectLeafPaths(value[key] as JsonValue, [...path, key], out);
  }
}

type Lookup = { readonly found: true; readonly value: JsonValue } | { readonly found: false };

const NOT_FOUND: Lookup = { found: false };

/** Reads `path` out of `document`, reporting absence distinctly from a `null` value. */
function lookupPath(document: JsonValue, path: readonly string[]): Lookup {
  let current: JsonValue = document;
  for (const segment of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
      return NOT_FOUND;
    }
    current = current[segment] as JsonValue;
  }
  return { found: true, value: current };
}

function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((item, index) => jsonEquals(item, b[index] as JsonValue))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every(
        (key) => Object.hasOwn(b, key) && jsonEquals(a[key] as JsonValue, b[key] as JsonValue),
      )
    );
  }
  return false;
}

/**
 * Renders a value for a diagnostic message, **redacted first**. Diagnostics
 * are the most likely place for a configured value to reach a log, so every
 * value embedded in a message goes through `redactJson` — a credential-shaped
 * string becomes `[redacted]` before it is ever concatenated into text.
 */
function describeValue(value: JsonValue): string {
  return JSON.stringify(redactJson(value)) ?? "undefined";
}

function describeSource(entry: ConfigurationProvenanceEntry): string {
  return entry.sourcePath === undefined ? entry.layer : `${entry.layer} (${entry.sourcePath})`;
}

function entryOf(
  document: ConfigurationLayerDocument,
  value: JsonValue,
): ConfigurationProvenanceEntry {
  // Conditional spread rather than `sourcePath: document.sourcePath`:
  // `exactOptionalPropertyTypes` makes `{ sourcePath: undefined }` distinct
  // from an absent property, and an explicit `undefined` would make
  // `"sourcePath" in entry` true for in-memory documents that have none.
  return {
    layer: document.layer,
    ...(document.sourcePath !== undefined ? { sourcePath: document.sourcePath } : {}),
    value,
  };
}

type LeafEdit = { readonly kind: "set"; readonly value: JsonValue } | { readonly kind: "delete" };

const REMOVED = Symbol("removed");

/**
 * Rebuilds `value`, applying policy edits keyed by JSON Pointer. Deleted
 * leaves vanish; an object left empty by a deletion is kept rather than
 * cascading upward, so the shape of the document still shows that the section
 * existed — a caller inspecting `/privacy` should see an empty object, not
 * silently lose the key and be unable to tell the section from one that was
 * never configured.
 */
function applyEdits(
  value: JsonValue,
  path: readonly string[],
  edits: ReadonlyMap<string, LeafEdit>,
): JsonValue | typeof REMOVED {
  if (!isPlainObject(value)) {
    const edit = edits.get(pathToPointer(path));
    if (edit === undefined) {
      return value;
    }
    return edit.kind === "delete" ? REMOVED : edit.value;
  }
  // Null-prototype accumulator — same rationale as `mergeJsonValue` above.
  const rebuilt = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value)) {
    const child = applyEdits(value[key] as JsonValue, [...path, key], edits);
    if (child !== REMOVED) {
      rebuilt[key] = child;
    }
  }
  return rebuilt;
}

interface ChainResolution {
  readonly winner: ConfigurationProvenanceEntry;
  readonly overridden: readonly ConfigurationProvenanceEntry[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Picks the winning entry of one pointer's chain, applying whichever policy
 * rule covers that pointer.
 *
 * `chain` is ordered least specific first, so the *default* winner is the last
 * entry. A policy rule can move the winner earlier — that, and not a separate
 * "clamped value" field, is how "the strictest hard limit wins" is
 * represented: the resolved value and the layer credited for it stay
 * consistent, because the credited layer really is the one that supplied the
 * value now in `values`.
 */
function resolveChain(
  pointer: string,
  chain: readonly ConfigurationProvenanceEntry[],
  policy: IndexedConfigurationPolicy,
): ChainResolution {
  const lastIndex = chain.length - 1;
  const last = chain[lastIndex] as ConfigurationProvenanceEntry;
  const diagnostics: Diagnostic[] = [];

  let winnerIndex = lastIndex;

  const hardLimit = policy.hardLimits.get(pointer);
  const privacy = policy.privacy.get(pointer);

  // Gap: a non-numeric hard-limit value or a privacy value absent from
  // `strictestFirst` is reachable from any layer, not only `last` — most
  // notably from `invocation-override`, which bypasses the restricted-YAML
  // guard entirely when built programmatically. The original single-entry
  // check below only ever inspected `last`, which had two real defects: (1)
  // an invalid *non-last* entry was silently skipped with no diagnostic at
  // all, and (2) when `last` itself was invalid, `winnerIndex` was never
  // moved off `lastIndex` — the invalid value would still "win" and reach
  // `values` unchanged, which is precisely the "silently coerced" outcome
  // this rule exists to prevent. Both blocks below now scan the *whole*
  // chain unconditionally, diagnose every invalid entry, and only ever let a
  // *valid* entry become the winner.
  if (hardLimit !== undefined) {
    let strictestIndex: number | undefined;
    let strictestMagnitude = 0;
    for (let index = 0; index < chain.length; index += 1) {
      const entry = chain[index] as ConfigurationProvenanceEntry;
      const magnitude = hardLimitMagnitude(entry.value);
      if (magnitude === undefined) {
        diagnostics.push(
          createDiagnostic(
            "configuration.hard-limit-incomparable",
            "warning",
            `Hard limit ${pointer} has value ${describeValue(entry.value)} from ${describeSource(entry)}, which is neither a number nor a duration; it was ignored rather than compared.`,
            {
              pointer,
              ...(entry.sourcePath !== undefined ? { sourcePath: entry.sourcePath } : {}),
            },
          ),
        );
        continue;
      }
      const stricter =
        strictestIndex === undefined ||
        (hardLimit.strictest === "lower"
          ? magnitude < strictestMagnitude
          : magnitude > strictestMagnitude);
      if (stricter) {
        strictestMagnitude = magnitude;
        strictestIndex = index;
      }
    }
    if (strictestIndex !== undefined && strictestIndex !== winnerIndex) {
      const strictestEntry = chain[strictestIndex] as ConfigurationProvenanceEntry;
      // Only a warning when `last` was a genuine (valid, but looser)
      // loosening attempt — not when `last` simply could not be compared at
      // all, which the `hard-limit-incomparable` diagnostic above already
      // explains (design §4: "tightening is applied silently", and an
      // incomparable value is neither a tightening nor a loosening).
      if (hardLimitMagnitude(last.value) !== undefined) {
        diagnostics.push(
          createDiagnostic(
            "configuration.hard-limit-clamped",
            "warning",
            `Hard limit ${pointer} kept at ${describeValue(strictestEntry.value)} from ${describeSource(strictestEntry)}; ${describeSource(last)} attempted to relax it to ${describeValue(last.value)}.`,
            { pointer, ...(last.sourcePath !== undefined ? { sourcePath: last.sourcePath } : {}) },
          ),
        );
      }
      winnerIndex = strictestIndex;
    }
  }

  if (privacy !== undefined) {
    let strictestIndex: number | undefined;
    let strictestRank = 0;
    for (let index = 0; index < chain.length; index += 1) {
      const entry = chain[index] as ConfigurationProvenanceEntry;
      const rank = privacyRank(entry.value, privacy.strictestFirst);
      if (rank === undefined) {
        diagnostics.push(
          createDiagnostic(
            "configuration.privacy-incomparable",
            "warning",
            `Privacy setting ${pointer} has value ${describeValue(entry.value)} from ${describeSource(entry)}, which is not one of this pointer's declared settings; it was ignored rather than compared.`,
            {
              pointer,
              ...(entry.sourcePath !== undefined ? { sourcePath: entry.sourcePath } : {}),
            },
          ),
        );
        continue;
      }
      if (strictestIndex === undefined || rank < strictestRank) {
        strictestRank = rank;
        strictestIndex = index;
      }
    }
    if (strictestIndex !== undefined && strictestIndex !== winnerIndex) {
      const strictestEntry = chain[strictestIndex] as ConfigurationProvenanceEntry;
      if (privacyRank(last.value, privacy.strictestFirst) !== undefined) {
        diagnostics.push(
          createDiagnostic(
            "configuration.privacy-weakening-blocked",
            "error",
            `Privacy setting ${pointer} kept at ${describeValue(strictestEntry.value)} from ${describeSource(strictestEntry)}; ${describeSource(last)} attempted to weaken it to ${describeValue(last.value)}.`,
            { pointer, ...(last.sourcePath !== undefined ? { sourcePath: last.sourcePath } : {}) },
          ),
        );
      }
      winnerIndex = strictestIndex;
    }
  }

  const winner = chain[winnerIndex] as ConfigurationProvenanceEntry;
  const overridden = chain.filter((_, index) => index !== winnerIndex);

  for (const entry of overridden) {
    if (!jsonEquals(entry.value, winner.value)) {
      diagnostics.push(
        createDiagnostic(
          "configuration.value-overridden",
          "info",
          `${pointer}: ${describeSource(winner)} sets ${describeValue(winner.value)}, overriding ${describeValue(entry.value)} from ${describeSource(entry)}.`,
          { pointer, ...(entry.sourcePath !== undefined ? { sourcePath: entry.sourcePath } : {}) },
        ),
      );
    }
  }

  return { winner, overridden, diagnostics };
}

// ---------------------------------------------------------------------------
// Gap: `HENIEK_BUILT_IN_DEFAULTS` and a programmatically-built
// `invocation-override` document are plain JS objects that never pass
// through the restricted-YAML guard (only a file-sourced document does), so
// they can carry `undefined`, `NaN`/`Infinity`, or any other value with no
// JSON representation. Left unchecked, such a value would either reach
// `canonicalJsonStringify` later (`json.ts`, which *throws* for exactly
// these two shapes — breaking this module's "always well-formed" contract)
// or, for a plain `JSON.stringify` caller bypassing this package's own
// serializer, silently turn a non-finite number into the JSON literal
// `null`. `sanitizeConfigurationValue` prunes every such value out of a
// document *before* the fold, replacing it with a
// `configuration.invalid-value` diagnostic that names the offending pointer
// and layer. An object is pruned key-by-key (an unaffected sibling
// survives); an array is dropped *wholesale* on any invalid element, since
// arrays are atomic everywhere else in this module and there is no
// unambiguous way to merge a "partially valid" array with a competing
// layer's array.
// ---------------------------------------------------------------------------

function isJsonRepresentable(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonRepresentable);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonRepresentable);
  }
  return false;
}

function invalidValueDiagnostic(
  pointer: string,
  document: ConfigurationLayerDocument,
  reason: string,
): Diagnostic {
  return createDiagnostic(
    "configuration.invalid-value",
    "error",
    `Configuration value at "${pointer || "(root)"}" from layer "${document.layer}"` +
      `${document.sourcePath !== undefined ? ` (${document.sourcePath})` : ""} ${reason}; it was ignored.`,
    { pointer, ...(document.sourcePath !== undefined ? { sourcePath: document.sourcePath } : {}) },
  );
}

function sanitizeConfigurationValue(
  value: unknown,
  path: readonly string[],
  document: ConfigurationLayerDocument,
  diagnostics: Diagnostic[],
): JsonValue | typeof REMOVED {
  const pointer = pathToPointer(path);
  if (value === undefined) {
    diagnostics.push(
      invalidValueDiagnostic(pointer, document, "is undefined, which has no JSON representation"),
    );
    return REMOVED;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      diagnostics.push(
        invalidValueDiagnostic(pointer, document, `is not a finite number (${String(value)})`),
      );
      return REMOVED;
    }
    return value;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (!value.every(isJsonRepresentable)) {
      diagnostics.push(
        invalidValueDiagnostic(
          pointer,
          document,
          "contains an undefined, non-finite, or otherwise non-JSON element — the whole array " +
            "(arrays are replaced wholesale)",
        ),
      );
      return REMOVED;
    }
    return value as JsonValue;
  }
  if (typeof value === "object") {
    // Null-prototype accumulator — same rationale as `mergeJsonValue` above.
    const out = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const sanitized = sanitizeConfigurationValue(
        (value as Record<string, unknown>)[key],
        [...path, key],
        document,
        diagnostics,
      );
      if (sanitized !== REMOVED) {
        out[key] = sanitized;
      }
    }
    return out as JsonObject;
  }
  diagnostics.push(
    invalidValueDiagnostic(pointer, document, `has an unsupported type ("${typeof value}")`),
  );
  return REMOVED;
}

/**
 * Gap: "the overridden chain shape when a layer replaces an object with a
 * scalar or vice versa". The *object-shadowed-by-a-later-scalar* direction
 * already surfaces through the ordinary per-leaf `configuration.value-overridden`
 * diagnostic in `resolveChain`, because `lookupPath` returns a document's
 * *whole* object value verbatim when a leaf's exact pointer lands inside it
 * (a shorter path than the document actually has). The reverse direction —
 * a *scalar shadowed by a later object* — has no such leaf: the merged
 * document is an object at that pointer, so `collectLeafPaths` never visits
 * it, and the shadowed document's scalar is invisible to the whole
 * leaf-chain walk (`lookupPath` reports it as simply not found at any
 * *deeper* path, since a scalar has no properties to descend into). This
 * pass closes that gap by walking the merged tree's *branch* pointers
 * directly and, for each one, comparing every document's own value at that
 * exact pointer against the branch shape — any document with a non-object
 * value there gets one `configuration.value-overridden` diagnostic, naming
 * both the shadowed layer/value and the layer whose object structurally
 * replaced it.
 */
function collectShadowedByObjectDiagnostics(
  merged: JsonValue,
  path: readonly string[],
  documents: readonly ConfigurationLayerDocument[],
  policy: IndexedConfigurationPolicy,
  diagnostics: Diagnostic[],
): void {
  if (!isPlainObject(merged) || Object.keys(merged).length === 0) {
    return;
  }
  const pointer = pathToPointer(path);

  // An `invocation-override` document that was itself blocked by the
  // overridable gate at this pointer contributed nothing to `merged`, so it
  // must not be credited as the "winning" object layer nor reported as a
  // shadowed one — both readings would describe a document whose value here
  // was never actually applied.
  const permitted = (document: ConfigurationLayerDocument): boolean =>
    document.layer !== INVOCATION_OVERRIDE_LAYER || policy.overridable.has(pointer);

  let winningLayer: ConfigurationLayer | undefined;
  for (const document of documents) {
    if (!permitted(document)) continue;
    const lookup = lookupPath(document.values, path);
    if (lookup.found && isPlainObject(lookup.value)) {
      winningLayer = document.layer;
    }
  }

  if (winningLayer !== undefined) {
    for (const document of documents) {
      if (!permitted(document)) continue;
      const lookup = lookupPath(document.values, path);
      if (!lookup.found || isPlainObject(lookup.value)) {
        continue;
      }
      diagnostics.push(
        createDiagnostic(
          "configuration.value-overridden",
          "info",
          `${pointer || "(root)"}: layer "${winningLayer}" sets an object here, structurally replacing ` +
            `${describeValue(lookup.value)} from layer "${document.layer}"` +
            `${document.sourcePath !== undefined ? ` (${document.sourcePath})` : ""}.`,
          {
            pointer,
            ...(document.sourcePath !== undefined ? { sourcePath: document.sourcePath } : {}),
          },
        ),
      );
    }
  }

  for (const key of Object.keys(merged)) {
    collectShadowedByObjectDiagnostics(
      merged[key] as JsonValue,
      [...path, key],
      documents,
      policy,
      diagnostics,
    );
  }
}

/**
 * `true` when `resolved` carries at least one `error`-severity diagnostic.
 * `resolveConfiguration` is total and never throws (see its own docstring):
 * an offending value is always blocked, clamped, or dropped rather than
 * applied, so `resolved.values` is always well-formed JSON — but "well-formed"
 * is not the same as "trustworthy". This is the caller's gate on the latter:
 * a caller that must not proceed on a resolution with a blocked override, a
 * blocked privacy weakening, or a pruned invalid value calls this first,
 * rather than inspecting `resolved.diagnostics` by hand.
 */
export function hasBlockingDiagnostics(resolved: ResolvedConfiguration): boolean {
  return resolved.diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

/**
 * Resolves the configuration layers into one frozen document.
 *
 * The pass is: sort documents by layer, fold them into a merged value, then —
 * for every leaf of that merged value — walk the documents again to recover
 * the chain of layers that wrote it.
 *
 * Recovering provenance *after* the fold, rather than threading it through the
 * merge, is what keeps the merge a plain recursive function. It is also
 * exactly equivalent: for a pointer that is a leaf of the merged document, the
 * last document holding a value there is necessarily the one that supplied it
 * (a later document holding an *object* there would have made the pointer an
 * object in the merged document too, not a leaf).
 */
export function resolveConfiguration(input: ResolveConfigurationInput): ResolvedConfiguration {
  // `HENIEK_BUILT_IN_DEFAULTS` is *not* implicitly prepended here — design §4
  // states it "ships ... as the first layer, so a caller that supplies
  // nothing still resolves to the spec's stated defaults", meaning it is an
  // available `built-in-defaults`-layer document a caller includes in
  // `input.documents` (as `HENIEK_BUILT_IN_DEFAULTS` itself does in every
  // call site and test that wants the spec defaults), not a value this pure
  // function injects unconditionally. `resolveConfiguration` must stay a
  // plain fold over exactly what it was given: forcing the defaults in here
  // would make every resolution — including ones that deliberately test
  // "only this one pointer, nothing else" — carry the full limits/privacy
  // block whether the caller asked for it or not, and would make a caller
  // that *also* passes its own `HENIEK_BUILT_IN_DEFAULTS` (as several tests
  // legitimately do, to exercise the built-in policy) see its own document
  // compared against a second, implicit copy of itself.
  const sortedDocuments = sortConfigurationDocuments(input.documents);
  const policy = indexConfigurationPolicy(input.policy ?? { rules: [] });
  const diagnostics: Diagnostic[] = [];

  // Gap: sanitize before folding — see the block comment above
  // `sanitizeConfigurationValue`. `documents` (used below for the fold, the
  // leaf-chain walk, and the shadow pass) is the *sanitized* copy; only the
  // originally-sorted `sortedDocuments` is needed again, for the `layers`
  // summary, and either copy answers that the same way.
  const documents = sortedDocuments.map((document) => {
    const sanitizedValues = sanitizeConfigurationValue(document.values, [], document, diagnostics);
    return {
      layer: document.layer,
      ...(document.sourcePath !== undefined ? { sourcePath: document.sourcePath } : {}),
      values: (sanitizedValues === REMOVED ? {} : sanitizedValues) as JsonObject,
    };
  });

  let merged: JsonValue = {};
  for (const document of documents) {
    merged = mergeJsonValue(merged, document.values);
  }

  const leafPaths: string[][] = [];
  collectLeafPaths(merged, [], leafPaths);

  const edits = new Map<string, LeafEdit>();
  const provenance: ConfigurationProvenance[] = [];

  for (const path of leafPaths) {
    const pointer = pathToPointer(path);
    const chain: ConfigurationProvenanceEntry[] = [];

    for (const document of documents) {
      const lookup = lookupPath(document.values, path);
      if (!lookup.found) {
        continue;
      }
      // An `invocation-override` write to a pointer the policy has not
      // declared `overridable` never enters the chain at all: §8.2 makes this
      // a default deny, so the value is dropped rather than merely
      // deprioritised, and the next-most-specific layer wins as if the
      // override had not been supplied.
      if (document.layer === INVOCATION_OVERRIDE_LAYER && !policy.overridable.has(pointer)) {
        diagnostics.push(
          createDiagnostic(
            "configuration.override-not-permitted",
            "error",
            `${pointer} is not declared overridable, so the invocation override ${describeValue(lookup.value)} was dropped.`,
            {
              pointer,
              ...(document.sourcePath !== undefined ? { sourcePath: document.sourcePath } : {}),
            },
          ),
        );
        continue;
      }
      chain.push(entryOf(document, lookup.value));
    }

    if (chain.length === 0) {
      // Every layer that wrote this pointer was an impermissible invocation
      // override, so the pointer has no legitimate value and leaves the
      // resolved document entirely.
      edits.set(pointer, { kind: "delete" });
      continue;
    }

    const resolution = resolveChain(pointer, chain, policy);
    diagnostics.push(...resolution.diagnostics);

    const winner = resolution.winner;
    provenance.push({
      pointer,
      layer: winner.layer,
      ...(winner.sourcePath !== undefined ? { sourcePath: winner.sourcePath } : {}),
      value: winner.value,
      overridden: resolution.overridden,
    });

    edits.set(pointer, { kind: "set", value: winner.value });
  }

  const edited = applyEdits(merged, [], edits);
  const values = (edited === REMOVED ? {} : edited) as JsonObject;

  // Gap: the scalar-shadowed-by-a-later-object direction of "the overridden
  // chain shape when a layer replaces an object with a scalar or vice
  // versa" — see `collectShadowedByObjectDiagnostics`'s own docstring.
  collectShadowedByObjectDiagnostics(merged, [], documents, policy, diagnostics);

  const contributing = new Set(documents.map((document) => document.layer));
  const layers = CONFIGURATION_LAYERS.filter((layer) => contributing.has(layer));

  provenance.sort((a, b) => (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0));

  return deepFreeze({
    layers,
    values,
    provenance,
    diagnostics: sortDiagnostics(diagnostics),
  });
}
