import {
  isDisallowedConfigurationEntry,
  looksLikeCredentialKey,
  looksLikeCredentialValue,
  redactText,
} from "@heniek/secrets";
import type { Document, YAMLError } from "yaml";
import { Alias, LineCounter, Pair, parseAllDocuments, Scalar, visit, YAMLMap, YAMLSeq } from "yaml";
import type { Diagnostic, DiagnosticSeverity } from "../diagnostics.js";
import { createDiagnostic, sortDiagnostics } from "../diagnostics.js";
import type { JsonValue } from "../json.js";

export interface RestrictedYamlOptions {
  /** Attached to every diagnostic's `sourcePath`, e.g. the file this source came from. */
  readonly sourcePath?: string;
  /**
   * Rejects documents nested deeper than this (design §3). Depth is counted
   * as the length of `visit`'s ancestry path at a given node, which grows by
   * one for every Map/Seq/Pair boundary crossed — a coarser count than "YAML
   * indentation levels", but monotonic, which is all a "too deep" guard
   * needs.
   */
  readonly maxDepth?: number;
}

export type RestrictedYamlResult =
  | { readonly ok: true; readonly value: JsonValue; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

const DEFAULT_MAX_DEPTH = 32;

// A hard ceiling on caller-supplied `maxDepth`, independent of
// `DEFAULT_MAX_DEPTH`: without one, `{ maxDepth: Infinity }` (or any very
// large caller value) defeats the in-band `path.length > maxDepth` guard
// entirely, so pathologically deep input reaches `visit`'s own recursion —
// and, worse, `doc.toJS()`/the AST walk below — with no depth guard active
// at all. Chosen well above any legitimate configuration document's nesting
// (the deepest canonical layout in this package nests four or five levels)
// but low enough that reaching it cannot itself exhaust the call stack.
const MAX_DEPTH_CEILING = 1000;

// A hard ceiling on `source.length` (UTF-16 code units), checked before any
// parsing work begins. Restricted-YAML documents are hand-authored
// configuration — profiles, roles, pipeline templates — never legitimately
// more than a few tens of kilobytes; this ceiling exists purely so a
// pathological input (a scripted stress probe, a corrupted or
// accidentally-concatenated file) fails fast with a diagnostic instead of
// letting the underlying parser's internal work scale with an unbounded
// input size. 2,000,000 code units (~2 MiB of ASCII-heavy YAML) is generous
// for any legitimate document while still bounding worst-case parse cost.
const MAX_SOURCE_LENGTH = 2_000_000;

/** The literal key that signals a YAML 1.1 merge-key mapping (`<<: *anchor`). */
const MERGE_KEY = "<<";

/**
 * Plain scalars that are YAML-1.1 booleans but *not* YAML-1.2 (core schema)
 * booleans — `true`/`false` (any case) are excluded deliberately: the core
 * schema already resolves those to real JS booleans, so there is no
 * cross-parser disagreement to warn about. `y`/`yes`/`n`/`no`/`on`/`off` stay
 * plain strings under core but would silently become booleans under a
 * YAML-1.1 reader, which is exactly the ambiguity §8.1 asks to flag.
 *
 * An exact, enumerated set — not a case-insensitive regex — because the
 * YAML 1.1 boolean grammar itself only recognises these specific casings
 * (`yes`/`Yes`/`YES`, not e.g. `yEs`); matching more broadly would warn
 * about spellings no real YAML 1.1 parser would actually read as a boolean.
 */
const AMBIGUOUS_SCALAR_WORDS = new Set([
  "y",
  "Y",
  "yes",
  "Yes",
  "YES",
  "n",
  "N",
  "no",
  "No",
  "NO",
  "on",
  "On",
  "ON",
  "off",
  "Off",
  "OFF",
]);

/** A plain integer-looking scalar with a leading zero — ambiguous with YAML 1.1 octal notation. */
const LEADING_ZERO_PATTERN = /^[+-]?0[0-9]+$/;

/**
 * A plain scalar in YAML-1.1's sexagesimal (base-60) int/float notation
 * (`12:30`, `1:20:30.5`) — the core (YAML 1.2) schema does not recognise this
 * shape at all and leaves it as an ordinary string, but a YAML-1.1 reader
 * resolves it to a number (`12:30` → `750`), which is exactly the kind of
 * cross-parser disagreement this rule exists to flag (C8b).
 */
const SEXAGESIMAL_PATTERN = /^[+-]?[0-9][0-9_]*(:[0-5]?[0-9])+(\.[0-9_]*)?$/;

/**
 * The less-common core-schema spellings of `null` (`~`, `Null`, `NULL`) — the
 * core schema's own null-resolution grammar (`^(?:~|[Nn]ull|NULL)?$`, see
 * `yaml`'s `schema/common/null.js`) already treats every one of these
 * identically to the canonical `null`, so unlike the boolean-word set above
 * there is no cross-*parser* disagreement here. The ambiguity is readability:
 * an unquoted `~`, `Null`, or `NULL` is easy to misread as a sentinel string
 * rather than the null value it actually resolves to. `null` itself is
 * excluded, mirroring how `true`/`false` are excluded from the boolean set —
 * the single obviously-canonical spelling stays silent (C8b).
 */
const AMBIGUOUS_NULL_WORDS = new Set(["~", "Null", "NULL"]);

/**
 * The three property names that collide with `Object.prototype` and would
 * land as an *own* property on a plain-object merge accumulator (design §4's
 * key-wise layer merge) if a mapping key were allowed to use them —
 * `{__proto__: {...}}["__proto__"] = ...` reassigns the accumulator's own
 * prototype via bracket assignment's `__proto__` setter, and `constructor`/
 * `prototype` are the two-step variant of the same hazard
 * (`constructor.prototype.polluted = true` reaches every object sharing that
 * constructor). Rejected here, at the one place every restricted-YAML
 * document passes through, rather than trusted to every future consumer of
 * the parsed value (C2).
 */
const RESERVED_KEY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The explicit tag URIs the core schema itself resolves (`tag:yaml.org,2002:…`
 * for each of the seven core kinds). An explicit tag naming one of these
 * (`!!str`, `!!int`, …) is not "custom" — it is redundant with what the
 * scalar would already resolve to — so only a tag *outside* this set is
 * rejected (design §3, "an explicit tag outside the core set").
 */
const CORE_TAG_URIS = new Set([
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:null",
]);

const SENSITIVE_VALUE_MESSAGE =
  "This value looks like a credential and is not allowed in YAML configuration " +
  "— store it with the secret store and reference it by name instead.";

/** Builds the `yaml.max-depth-exceeded` diagnostic used by both the ordinary in-band guard and the `RangeError` fallback (C3). */
function maxDepthExceededDiagnostic(maxDepth: number, sourcePath: string | undefined): Diagnostic {
  return createDiagnostic(
    "yaml.max-depth-exceeded",
    "error",
    `Document nesting exceeds the maximum supported depth of ${maxDepth}.`,
    sourcePath !== undefined ? { sourcePath } : {},
  );
}

/**
 * The message for a `yaml.sensitive-value-not-allowed` diagnostic raised
 * against a mapping *key* (a credential-shaped key name, or a key whose text
 * itself matches a credential value shape). `keyText` is routed through
 * `redactText` before interpolation: for the credential-shaped-key-name case
 * (`password`, `api_key`, …) `redactText` is a no-op, but for the
 * credential-*in-key-position* case (`ghp_<36 chars>: enabled`) the key text
 * itself is the credential, and interpolating it verbatim would leak it right
 * back out through the diagnostic message, logs, and the required snapshot
 * (C6b).
 */
function credentialKeyMessage(keyText: string): string {
  return (
    `The value for "${redactText(keyText)}" looks like a credential and is not allowed in YAML ` +
    "configuration — store it with the secret store and reference it by name instead."
  );
}

/**
 * Parses `source` under the restricted YAML subset (spec §8.1, design §3):
 * a single document, no anchors/aliases/merge keys, no explicit tags, string
 * mapping keys only, no duplicate keys, no YAML-1.1-only booleans or
 * leading-zero integers left unquoted, and no credential-shaped entries
 * (delegated to `@heniek/secrets`' `isDisallowedConfigurationEntry`, so the
 * YAML guard and the redaction layer can never disagree about what counts as
 * a credential).
 */
export function parseRestrictedYaml(
  source: string,
  options: RestrictedYamlOptions = {},
): RestrictedYamlResult {
  const sourcePath = options.sourcePath;
  // Clamped, not trusted verbatim: a caller-supplied `maxDepth: Infinity`
  // (or any absurdly large value) would otherwise disable both the in-band
  // `path.length > maxDepth` guard below and the `RangeError` fallback
  // above (which reports `maxDepth` back to the caller, so it must itself
  // be finite).
  const maxDepth = Math.min(options.maxDepth ?? DEFAULT_MAX_DEPTH, MAX_DEPTH_CEILING);
  const lineCounter = new LineCounter();

  // Checked before any parsing work begins — see `MAX_SOURCE_LENGTH`'s
  // docstring. `RangeError` is deliberately not relied on for this case:
  // an oversized-but-shallow document (e.g. one enormous scalar) would
  // never trip the depth-related `RangeError` path at all, so it needs its
  // own explicit guard.
  if (source.length > MAX_SOURCE_LENGTH) {
    return {
      ok: false,
      diagnostics: [
        createDiagnostic(
          "yaml.source-too-large",
          "error",
          `Source exceeds the maximum supported length of ${MAX_SOURCE_LENGTH} characters.`,
          sourcePath !== undefined ? { sourcePath } : {},
        ),
      ],
    };
  }

  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(source, {
      version: "1.2",
      schema: "core",
      uniqueKeys: true,
      merge: false,
      customTags: [],
      keepSourceTokens: true,
      lineCounter,
    });
  } catch (error) {
    // `yaml`'s own composer catches its own stack exhaustion for most
    // pathological inputs and reports it as a `RESOURCE_EXHAUSTION`
    // `doc.error` (handled below, in the ordinary error-mapping path) rather
    // than throwing — but that self-protection is not guaranteed for every
    // shape of deeply nested input, so a `RangeError` that does escape here
    // is still converted to a diagnostic rather than propagating out of this
    // Result-typed function (C3).
    if (error instanceof RangeError) {
      return {
        ok: false,
        diagnostics: [maxDepthExceededDiagnostic(maxDepth, sourcePath)],
      };
    }
    throw error;
  }

  // An input with no documents at all (`""`, or a stream of only
  // comments/directives) is the empty-document case in design §3's
  // accepted-subset table — resolves to JSON `null`, matching how an empty
  // YAML document is conventionally interpreted. `docs.errors`/`docs.warnings`
  // (the stream-level errors `yaml` attaches to the empty-array result, e.g. a
  // malformed `%` directive) must still be reported here — without this, a
  // hard parse error on a stream that composed zero documents was silently
  // swallowed as success (C1).
  if ("empty" in docs) {
    const diagnostics: Diagnostic[] = [
      ...docs.errors.map((error) => diagnosticFromYamlError(error, sourcePath)),
      ...docs.warnings.map((warning) => diagnosticFromYamlError(warning, sourcePath)),
    ];
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
    }
    return { ok: true, value: null, diagnostics: sortDiagnostics(diagnostics) };
  }

  if (docs.length > 1) {
    const [firstDocument, secondDocument] = docs;
    const secondDocumentStart = secondDocument?.range?.[0];
    const position =
      secondDocumentStart !== undefined ? lineCounter.linePos(secondDocumentStart) : undefined;
    // The second (and any later) document is rejected outright, but the
    // *first* document can independently be malformed too — without
    // surfacing `firstDocument.errors` here, "the first document was also
    // malformed" was invisible, since this branch returned before the loop
    // that normally reports `doc.errors` ever ran (C8a).
    const diagnostics: Diagnostic[] = (firstDocument?.errors ?? []).map((error) =>
      diagnosticFromYamlError(error, sourcePath),
    );
    diagnostics.push(
      createDiagnostic(
        "yaml.multiple-documents-not-supported",
        "error",
        "Only a single YAML document is supported per source; found more than one, " +
          'separated by "---".',
        {
          ...(sourcePath !== undefined ? { sourcePath } : {}),
          ...(position !== undefined ? { line: position.line, column: position.col } : {}),
        },
      ),
    );
    return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  const doc = docs[0];
  /* c8 ignore next 3 -- unreachable: docs.length === 1 was just checked above */
  if (doc === undefined) {
    throw new Error("Invariant violated: parseAllDocuments returned a length-1 array with no [0].");
  }

  const diagnostics: Diagnostic[] = [];
  for (const error of doc.errors) {
    diagnostics.push(diagnosticFromYamlError(error, sourcePath));
  }

  let maxDepthReported = false;

  visit(doc, (key, node, path) => {
    if (node instanceof Alias) {
      diagnostics.push(
        diagnosticAt(
          "yaml.alias-not-supported",
          "error",
          "Alias nodes are not supported by the restricted YAML subset.",
          node,
          lineCounter,
          sourcePath,
        ),
      );
      return;
    }

    if (node instanceof Pair) {
      handlePair(node, diagnostics, lineCounter, sourcePath);
      return;
    }

    if (node instanceof Scalar || node instanceof YAMLMap || node instanceof YAMLSeq) {
      if (node.anchor !== undefined) {
        diagnostics.push(
          diagnosticAt(
            "yaml.anchor-not-supported",
            "error",
            "Anchors are not supported by the restricted YAML subset.",
            node,
            lineCounter,
            sourcePath,
          ),
        );
      }
      if (node.tag !== undefined && !CORE_TAG_URIS.has(node.tag)) {
        diagnostics.push(
          diagnosticAt(
            "yaml.custom-tag-not-supported",
            "error",
            "Custom YAML tags are not supported by the restricted YAML subset.",
            node,
            lineCounter,
            sourcePath,
          ),
        );
      }
      if (!maxDepthReported && path.length > maxDepth) {
        maxDepthReported = true;
        diagnostics.push(
          diagnosticAt(
            "yaml.max-depth-exceeded",
            "error",
            `Document nesting exceeds the maximum supported depth of ${maxDepth}.`,
            node,
            lineCounter,
            sourcePath,
          ),
        );
        // The guard must actually guard: without terminating traversal here,
        // `visit` keeps recursing arbitrarily deep past the point already
        // known to be too deep, which both wastes work and risks the
        // recursive `visit` implementation itself overflowing the call stack
        // on pathologically deep input (C3). `visit.BREAK` stops the whole
        // traversal, not just this node's children.
        return visit.BREAK;
      }
    }

    if (node instanceof Scalar) {
      // Checked against the *resolved* value, not the source text: this is
      // exactly "did this scalar resolve to something JSON cannot
      // represent", which is what the rule is actually about, and is
      // immune to drift if a future `yaml` release changes which spellings
      // the core schema's float-NaN/Inf rule accepts.
      if (typeof node.value === "number" && !Number.isFinite(node.value)) {
        diagnostics.push(
          diagnosticAt(
            "yaml.non-json-value",
            "error",
            "'.nan'/'.inf' scalars have no JSON representation and are not supported.",
            node,
            lineCounter,
            sourcePath,
          ),
        );
      }

      if (node.type === "PLAIN") {
        // The ambiguity check, unlike the one above, has to look at the
        // literal source text: under the core schema "yes"/"on"/"007" all
        // resolve to ordinary strings/numbers with no distinguishing trace
        // left in `.value`, so the only way to tell "was this written
        // unquoted in a way a YAML-1.1 reader would interpret differently"
        // is to inspect what was actually typed.
        const scalarSource =
          typeof node.source === "string" ? node.source : String(node.value ?? "");
        if (
          AMBIGUOUS_SCALAR_WORDS.has(scalarSource) ||
          LEADING_ZERO_PATTERN.test(scalarSource) ||
          SEXAGESIMAL_PATTERN.test(scalarSource) ||
          AMBIGUOUS_NULL_WORDS.has(scalarSource)
        ) {
          diagnostics.push(
            diagnosticAt(
              "yaml.ambiguous-scalar",
              "warning",
              `"${scalarSource}" should be quoted — its unquoted form is read differently by other YAML parsers.`,
              node,
              lineCounter,
              sourcePath,
            ),
          );
        }
      }

      // A scalar string with no enclosing mapping key at all — a top-level
      // document body, or a sequence item — still needs the value-shape half
      // of `isDisallowedConfigurationEntry` (the key-shape half is
      // meaningless without a key). Pair *values* are excluded here
      // (`key === "value"`) because `handlePair` already covers them with
      // the actual key text, which lets the key-shape half of the predicate
      // fire too; checking them again here with an empty key would miss
      // that half. Pair *keys* (`key === "key"`) are never themselves
      // sensitivity-checked — a key name being credential-shaped is not
      // itself a leak.
      if (typeof node.value === "string" && (key === null || typeof key === "number")) {
        if (isDisallowedConfigurationEntry("", node.value)) {
          diagnostics.push(
            diagnosticAt(
              "yaml.sensitive-value-not-allowed",
              "error",
              SENSITIVE_VALUE_MESSAGE,
              node,
              lineCounter,
              sourcePath,
            ),
          );
        }
      }
    }
  });

  const sorted = sortDiagnostics(diagnostics);
  if (sorted.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics: sorted };
  }

  let value: JsonValue;
  try {
    value = doc.toJS({ mapAsMap: false }) as JsonValue;
  } catch (error) {
    // `visit.BREAK` above stops traversal as soon as the in-band guard fires,
    // but `doc.toJS` walks the retained AST independently and would still
    // recurse past `maxDepth` on a document that never triggered the in-band
    // guard at all (a `maxDepth` set higher than the actual nesting `visit`
    // saw, or nesting introduced only by tags/aliases `visit` does not
    // descend into the same way) — converting a `RangeError` here, rather
    // than letting it escape, keeps this a Result-typed function under every
    // input shape (C3).
    if (error instanceof RangeError) {
      return {
        ok: false,
        diagnostics: sortDiagnostics([
          ...diagnostics,
          maxDepthExceededDiagnostic(maxDepth, sourcePath),
        ]),
      };
    }
    throw error;
  }
  return { ok: true, value, diagnostics: sorted };
}

/**
 * Re-parses `source` purely to retain the composed `Document` and its
 * `LineCounter` — used by `../yaml/validate.ts` to resolve an Ajv
 * `instancePath` back to a source position (D2). Kept separate from
 * `parseRestrictedYaml`'s own parse (rather than threading the document
 * through `RestrictedYamlResult`) so the public result shape stays exactly
 * `{ ok, value, diagnostics }` — tests assert on that shape with `toEqual`,
 * and validate.ts only needs position information on the (comparatively
 * rare) schema-violation path, so the cost of a second parse there is
 * acceptable. Returns `undefined` when `source` does not compose into
 * exactly one document — the caller (already holding an `ok: true` result
 * from `parseRestrictedYaml`) falls back to pointer-only diagnostics in that
 * case rather than fabricating a position.
 */
export function parseYamlDocumentForPointerResolution(
  source: string,
): { readonly document: Document.Parsed; readonly lineCounter: LineCounter } | undefined {
  const lineCounter = new LineCounter();
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(source, {
      version: "1.2",
      schema: "core",
      uniqueKeys: true,
      merge: false,
      customTags: [],
      keepSourceTokens: true,
      lineCounter,
    });
  } catch {
    return undefined;
  }
  if ("empty" in docs || docs.length !== 1) {
    return undefined;
  }
  const document = docs[0];
  // `ReturnType<typeof parseAllDocuments>` (used for `docs` above, since this
  // function calls `parseAllDocuments` without explicit type arguments)
  // resolves the library's `Contents`/`Strict` generics less precisely than a
  // direct `Document.Parsed` reference does; the runtime value is exactly a
  // `Document.Parsed` (this branch has already excluded the `EmptyStream` and
  // multi-document cases), so the assertion only narrows a type-inference
  // artifact, not runtime behaviour.
  return document !== undefined
    ? { document: document as Document.Parsed, lineCounter }
    : undefined;
}

function handlePair(
  pair: Pair,
  diagnostics: Diagnostic[],
  lineCounter: LineCounter,
  sourcePath: string | undefined,
): void {
  const key: unknown = pair.key;
  if (!(key instanceof Scalar) || typeof key.value !== "string") {
    diagnostics.push(
      diagnosticAt(
        "yaml.non-string-key-not-supported",
        "error",
        "Mapping keys must be plain strings.",
        key,
        lineCounter,
        sourcePath,
        // An explicit-empty key (`? \n: v`) parses `pair.key` as the JS
        // literal `null`, which carries no `range` of its own — without a
        // fallback, this diagnostic silently lost its `line`/`column`. The
        // pair's own source offset (the `?` indicator token, when present)
        // is the next-best position (B6).
        pairOffset(pair),
      ),
    );
    return;
  }

  const keyText = key.value;

  if (RESERVED_KEY_NAMES.has(keyText)) {
    diagnostics.push(
      diagnosticAt(
        "yaml.reserved-key-not-supported",
        "error",
        `"${keyText}" is not supported as a mapping key — it collides with a JavaScript object prototype property.`,
        key,
        lineCounter,
        sourcePath,
      ),
    );
    return;
  }

  if (keyText === MERGE_KEY) {
    diagnostics.push(
      diagnosticAt(
        "yaml.merge-key-not-supported",
        "error",
        'The "<<" merge key is not supported by the restricted YAML subset.',
        key,
        lineCounter,
        sourcePath,
      ),
    );
    return;
  }

  const value: unknown = pair.value;

  // A credential-shaped key holding a *sequence* of scalar strings
  // (`api_keys:\n  - hunter2\n`) is just as much a leak as the single-scalar
  // case below — the guard was scoped to scalar values only, which left this
  // shape unguarded. Deliberately narrower than the scalar case: only
  // sequences are covered here, never mappings — `credentials: { store:
  // "file", name: "github" }` is the sanctioned reference form and must stay
  // legal (design §3, decision #1) (C5).
  if (value instanceof YAMLSeq && looksLikeCredentialKey(keyText)) {
    for (const item of value.items) {
      if (item instanceof Scalar && typeof item.value === "string") {
        diagnostics.push(
          diagnosticAt(
            "yaml.sensitive-value-not-allowed",
            "error",
            credentialKeyMessage(keyText),
            item,
            lineCounter,
            sourcePath,
          ),
        );
      }
    }
    return;
  }

  const rawValue = value instanceof Scalar ? value.value : undefined;
  // `isDisallowedConfigurationEntry` already returns `false` for any
  // non-string value, so a non-scalar or non-string `rawValue` is a no-op
  // here — no separate type guard needed before calling it. `keyText` is also
  // checked against the *value*-shape patterns (`looksLikeCredentialValue`),
  // not just the key-shape ones `isDisallowedConfigurationEntry` already
  // covers: a credential accepted in *key* position (`ghp_<36 chars>:
  // enabled`) was previously invisible to this scan entirely, since it only
  // ever looked at the key's *shape as a key name*, never at whether the key
  // *text itself* happens to be a credential value (C6a).
  const keyIsCredentialShaped = looksLikeCredentialValue(keyText);
  if (keyIsCredentialShaped || isDisallowedConfigurationEntry(keyText, rawValue)) {
    diagnostics.push(
      diagnosticAt(
        "yaml.sensitive-value-not-allowed",
        "error",
        credentialKeyMessage(keyText),
        keyIsCredentialShaped ? key : value,
        lineCounter,
        sourcePath,
      ),
    );
  }
}

/**
 * `error.message` is not used here even though `YAMLError` carries one:
 * because a `lineCounter` was supplied to `parseAllDocuments`, `yaml`'s own
 * `prettifyError` has already mutated it to embed a rendered excerpt of the
 * offending source line (see `errors.js` in the `yaml` package). A restricted-
 * YAML syntax error can occur on a line holding a credential-shaped value
 * (`password: not:valid:yaml`, say), so that excerpt is never surfaced — only
 * the error code and position, which this diagnostic's `line`/`column`
 * fields already carry structurally.
 */
function diagnosticFromYamlError(error: YAMLError, sourcePath: string | undefined): Diagnostic {
  const code = error.code === "DUPLICATE_KEY" ? "yaml.duplicate-key" : "yaml.syntax-error";
  const message =
    error.code === "DUPLICATE_KEY"
      ? "Duplicate mapping key is not allowed."
      : `YAML syntax error (${error.code}).`;
  const position = error.linePos?.[0];
  return createDiagnostic(code, "error", message, {
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(position !== undefined ? { line: position.line, column: position.col } : {}),
  });
}

/**
 * Duck-types `node` for a `[start, ...]` NodeBase-style `range`, since the
 * callers pass a mix of typed and `unknown` nodes. `fallbackOffset`, when
 * `node` itself carries no usable range, is used instead — see `pairOffset`
 * (B6).
 */
function diagnosticAt(
  code: string,
  severity: DiagnosticSeverity,
  message: string,
  node: unknown,
  lineCounter: LineCounter,
  sourcePath: string | undefined,
  fallbackOffset?: number,
): Diagnostic {
  const range = hasRange(node) ? node.range : undefined;
  const offset = range !== null && range !== undefined ? range[0] : fallbackOffset;
  const position = offset !== undefined ? lineCounter.linePos(offset) : undefined;
  return createDiagnostic(code, severity, message, {
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(position !== undefined ? { line: position.line, column: position.col } : {}),
  });
}

function hasRange(node: unknown): node is { range?: readonly [number, number, number] | null } {
  return typeof node === "object" && node !== null && "range" in node;
}

/**
 * Best-effort source offset for `pair` itself, used as a position fallback
 * when `pair.key` carries no range of its own — an explicit-empty key
 * (`? \n: v`) parses `pair.key` as the JS literal `null`, not a `Scalar`
 * node (B6). Prefers the position of the pair's first source token (the `?`
 * indicator, when present) over the value's, so the reported position
 * points at the key side of the pair rather than the unrelated value.
 */
function pairOffset(pair: Pair): number | undefined {
  const start = pair.srcToken?.start;
  if (start !== undefined && start.length > 0) {
    return start[0]?.offset;
  }
  return pair.srcToken?.value?.offset;
}
