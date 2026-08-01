import { isDisallowedConfigurationEntry } from "@heniek/secrets";
import type { YAMLError } from "yaml";
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
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const lineCounter = new LineCounter();

  const docs = parseAllDocuments(source, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
    customTags: [],
    keepSourceTokens: true,
    lineCounter,
  });

  // An input with no documents at all (`""`, or a stream of only
  // comments/directives) is the empty-document case in design §3's
  // accepted-subset table — resolves to JSON `null`, matching how an empty
  // YAML document is conventionally interpreted.
  if ("empty" in docs) {
    return { ok: true, value: null, diagnostics: [] };
  }

  if (docs.length > 1) {
    const secondDocument = docs[1];
    const position =
      secondDocument !== undefined ? lineCounter.linePos(secondDocument.range[0]) : undefined;
    return {
      ok: false,
      diagnostics: [
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
      ],
    };
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
        if (AMBIGUOUS_SCALAR_WORDS.has(scalarSource) || LEADING_ZERO_PATTERN.test(scalarSource)) {
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
  return { ok: true, value: doc.toJS({ mapAsMap: false }) as JsonValue, diagnostics: sorted };
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
      ),
    );
    return;
  }

  const keyText = key.value;
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
  const rawValue = value instanceof Scalar ? value.value : undefined;
  // `isDisallowedConfigurationEntry` already returns `false` for any
  // non-string value, so a non-scalar or non-string `rawValue` is a no-op
  // here — no separate type guard needed before calling it.
  if (isDisallowedConfigurationEntry(keyText, rawValue)) {
    diagnostics.push(
      diagnosticAt(
        "yaml.sensitive-value-not-allowed",
        "error",
        `The value for "${keyText}" looks like a credential and is not allowed in YAML ` +
          "configuration — store it with the secret store and reference it by name instead.",
        value,
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

/** Duck-types `node` for a `[start, ...]` NodeBase-style `range`, since the callers pass a mix of typed and `unknown` nodes. */
function diagnosticAt(
  code: string,
  severity: DiagnosticSeverity,
  message: string,
  node: unknown,
  lineCounter: LineCounter,
  sourcePath: string | undefined,
): Diagnostic {
  const range = hasRange(node) ? node.range : undefined;
  const position =
    range !== null && range !== undefined ? lineCounter.linePos(range[0]) : undefined;
  return createDiagnostic(code, severity, message, {
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(position !== undefined ? { line: position.line, column: position.col } : {}),
  });
}

function hasRange(node: unknown): node is { range?: readonly [number, number, number] | null } {
  return typeof node === "object" && node !== null && "range" in node;
}
