/**
 * Redacting event-trace recorder.
 *
 * This module is the only barrier between engine-controlled data and a file
 * that gets **committed to this repository** as ADR evidence. The issue
 * excludes "factory runtime state, credentials, transcripts, or control
 * artifacts" from the repository, so redaction here is a security boundary,
 * not a formatting nicety.
 *
 * Two rules make that boundary hold:
 *
 *  1. **Deny before allow.** Every string — including field *names*, and
 *     including `ts`/`type`, which are engine-controlled — is first tested
 *     against a deny layer (whitespace, path separators, credential prefixes,
 *     long opaque runs, JWT shape, the daemon's own bearer token). Only what
 *     survives is then matched against a narrow allowlist.
 *  2. **Names are data too.** An object key can itself be the secret (a
 *     payload key that is a filesystem path, or a top-level key that is a
 *     token). Names are sanitised at every sink: kept payload keys,
 *     `droppedFields`, and the rendered Markdown.
 *
 * `droppedFields` records field **names only** — never a dropped value, and a
 * name that is itself unsafe is reported as a fixed placeholder. No dropped
 * value reaches `entries()`, `toMarkdown()`, `droppedFields`, or any thrown
 * error message.
 *
 * Real timestamps are recorded here, which is legal only because this file
 * lives under `src/smoke/` — `test/no-wall-clock.test.ts` exempts exactly that
 * first path segment. Do not relocate it.
 */

/** Shape a field name must have to be printable at all. */
const SAFE_FIELD_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Stand-in emitted whenever a field name is itself unsafe. */
const REDACTED_FIELD_NAME = "<redacted-field-name>";

/**
 * Credential prefixes, matched mid-string but only at a word boundary, so a
 * token embedded in a larger string is caught (`"note.ghp_…"`) while ordinary
 * identifiers are not.
 *
 * The word boundary is load-bearing, not cosmetic: `"task-a9b1ea142bc5"`
 * *contains* `"sk-"`, so an unanchored prefix test denies every real Claudexor
 * task id. That regression is pinned in `claudexor-trace.test.ts`.
 */
const CREDENTIAL_PREFIX_PATTERN = /\b(sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|Bearer\s)/i;

/**
 * An unbroken run of 32+ token characters, searched **anywhere** in the
 * string. A whole-string-anchored test would be defeated by a single
 * separator, which is exactly how an embedded PAT slips through.
 */
const TOKEN_RUN_PATTERN = /[A-Za-z0-9_-]{32,}/;

/**
 * Dot-separated base64url triple (JWT shape). Length-gated so ordinary dotted
 * event types such as `task.contract.created` are not mistaken for a token.
 */
const JWT_TRIPLE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_MINIMUM_LENGTH = 40;

/** Whitespace (including newlines, which could forge Markdown rows). */
const WHITESPACE_PATTERN = /\s/;

/** Path separators — a filesystem path is never admissible. */
const PATH_SEPARATOR_PATTERN = /[/\\]/;

/** Narrow allowlist for values that survived the deny layer. */
const ENUMISH_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Top-level event fields that may be recorded, in render order. */
const ALLOWED_EVENT_FIELDS = ["seq", "ts", "type", "run_id", "task_id"] as const;

/** A recorded process observation (the PID evidence the issue requires). */
export interface ProcessRecord {
  readonly kind: "process";
  readonly label: string;
  readonly pid: number;
  readonly at: string;
}

/** A recorded, redacted event observation. */
export interface EventRecord {
  readonly kind: "event";
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly payload: Readonly<Record<string, number | boolean | string>>;
  /** Field NAMES that were rejected. Never a rejected value. */
  readonly droppedFields: readonly string[];
}

export type TraceRecord = EventRecord | ProcessRecord;

export interface EventTraceOptions {
  /**
   * The daemon's bearer token. Any string value or field name that equals or
   * contains it is denied, regardless of any other match.
   */
  readonly daemonToken?: string;
}

export interface EventTrace {
  recordEvent(event: unknown): EventRecord;
  recordProcess(record: { label: string; pid: number; at: string }): ProcessRecord;
  entries(): readonly TraceRecord[];
  toMarkdown(): string;
}

/** A required top-level field was missing or unusable. Names the field only. */
export class InvalidTraceEventError extends Error {
  constructor(readonly field: string) {
    super(`trace event field "${field}" is missing or not admissible`);
    this.name = "InvalidTraceEventError";
  }
}

/** True when a string must never be recorded in any form. */
function isDeniedString(value: string, daemonToken: string | undefined): boolean {
  if (value.length === 0) return true;
  if (WHITESPACE_PATTERN.test(value)) return true;
  if (PATH_SEPARATOR_PATTERN.test(value)) return true;
  if (CREDENTIAL_PREFIX_PATTERN.test(value)) return true;
  if (TOKEN_RUN_PATTERN.test(value)) return true;
  if (value.length >= JWT_MINIMUM_LENGTH && JWT_TRIPLE_PATTERN.test(value)) return true;
  if (daemonToken !== undefined && daemonToken.length > 0 && value.includes(daemonToken))
    return true;
  return false;
}

/** A value admissible after the deny layer. */
function isAdmissibleString(value: string, daemonToken: string | undefined): boolean {
  return !isDeniedString(value, daemonToken) && ENUMISH_PATTERN.test(value);
}

/**
 * Render a field name safely. An unsafe name is replaced wholesale — it is
 * never echoed, because the name may itself be the secret.
 */
function safeFieldName(name: string, daemonToken: string | undefined): string {
  if (!SAFE_FIELD_NAME_PATTERN.test(name)) return REDACTED_FIELD_NAME;
  if (isDeniedString(name, daemonToken)) return REDACTED_FIELD_NAME;
  return name;
}

function requireAdmissibleString(
  record: Record<string, unknown>,
  field: string,
  daemonToken: string | undefined,
): string {
  const value = Object.hasOwn(record, field) ? record[field] : undefined;
  if (typeof value !== "string" || !isAdmissibleString(value, daemonToken)) {
    throw new InvalidTraceEventError(field);
  }
  return value;
}

function optionalAdmissibleString(
  record: Record<string, unknown>,
  field: string,
  daemonToken: string | undefined,
  dropped: string[],
): string | null {
  if (!Object.hasOwn(record, field)) return null;
  const value = record[field];
  if (typeof value === "string" && isAdmissibleString(value, daemonToken)) return value;
  dropped.push(safeFieldName(field, daemonToken));
  return null;
}

function sanitizePayload(
  payload: unknown,
  daemonToken: string | undefined,
  dropped: string[],
): Record<string, number | boolean | string> {
  // Null-prototype target so a `__proto__` key is an ordinary own property
  // rather than a silent no-op assignment that vanishes from the audit trail.
  const kept = Object.create(null) as Record<string, number | boolean | string>;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return kept;
  }

  for (const key of Object.keys(payload as Record<string, unknown>)) {
    const rendered = safeFieldName(key, daemonToken);
    const value = (payload as Record<string, unknown>)[key];

    if (rendered === REDACTED_FIELD_NAME) {
      dropped.push(`payload.${REDACTED_FIELD_NAME}`);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      kept[rendered] = value;
      continue;
    }
    if (typeof value === "string" && isAdmissibleString(value, daemonToken)) {
      kept[rendered] = value;
      continue;
    }
    dropped.push(`payload.${rendered}`);
  }
  return kept;
}

function renderPayload(payload: Readonly<Record<string, number | boolean | string>>): string {
  const parts = Object.keys(payload).map((key) => `${key}=${String(payload[key])}`);
  return parts.length > 0 ? parts.join(" ") : "-";
}

/** Create a redacting trace recorder. */
export function createEventTrace(options: EventTraceOptions = {}): EventTrace {
  const daemonToken = options.daemonToken;
  const records: TraceRecord[] = [];

  return {
    recordEvent(event: unknown): EventRecord {
      if (typeof event !== "object" || event === null || Array.isArray(event)) {
        throw new InvalidTraceEventError("<root>");
      }
      const record = event as Record<string, unknown>;
      const dropped: string[] = [];

      const seq = Object.hasOwn(record, "seq") ? record["seq"] : undefined;
      if (typeof seq !== "number" || !Number.isFinite(seq)) {
        throw new InvalidTraceEventError("seq");
      }

      // `ts` and `type` are engine-controlled strings and go through the very
      // same deny layer as payload values — a `type` carrying a newline could
      // otherwise forge an extra Markdown row.
      const ts = requireAdmissibleString(record, "ts", daemonToken);
      const type = requireAdmissibleString(record, "type", daemonToken);
      const runId = optionalAdmissibleString(record, "run_id", daemonToken, dropped);
      const taskId = optionalAdmissibleString(record, "task_id", daemonToken, dropped);

      const payload = sanitizePayload(
        Object.hasOwn(record, "payload") ? record["payload"] : undefined,
        daemonToken,
        dropped,
      );

      // Any top-level key outside the allowlist is dropped by name.
      for (const key of Object.keys(record)) {
        if ((ALLOWED_EVENT_FIELDS as readonly string[]).includes(key)) continue;
        if (key === "payload") continue;
        dropped.push(safeFieldName(key, daemonToken));
      }

      const entry: EventRecord = {
        kind: "event",
        seq,
        ts,
        type,
        runId,
        taskId,
        payload: Object.freeze(payload),
        droppedFields: Object.freeze([...dropped]),
      };
      records.push(Object.freeze(entry));
      return entry;
    },

    recordProcess({ label, pid, at }): ProcessRecord {
      if (!Number.isInteger(pid)) throw new InvalidTraceEventError("pid");
      const safeLabel = safeFieldName(label, daemonToken);
      if (!isAdmissibleString(at, daemonToken)) throw new InvalidTraceEventError("at");
      const entry: ProcessRecord = { kind: "process", label: safeLabel, pid, at };
      records.push(Object.freeze(entry));
      return entry;
    },

    entries(): readonly TraceRecord[] {
      return Object.freeze([...records]);
    },

    toMarkdown(): string {
      const lines = [
        "| # | timestamp | kind | type / label | run | task | pid | payload | dropped |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ];
      records.forEach((entry, index) => {
        if (entry.kind === "process") {
          lines.push(
            `| ${index + 1} | ${entry.at} | process | ${entry.label} | - | - | ${entry.pid} | - | - |`,
          );
          return;
        }
        lines.push(
          `| ${index + 1} | ${entry.ts} | event | ${entry.type} | ${entry.runId ?? "-"} | ` +
            `${entry.taskId ?? "-"} | - | ${renderPayload(entry.payload)} | ` +
            `${entry.droppedFields.length > 0 ? entry.droppedFields.join(", ") : "-"} |`,
        );
      });
      return lines.join("\n");
    },
  };
}
