import {
  EXPECTED_ENGINE_SHA,
  EXPECTED_ENGINE_VERSION,
  EXPECTED_PROTOCOL_MAJOR,
} from "./protocol.js";

/**
 * Redacting event-trace recorder.
 *
 * This module is the only barrier between engine-controlled data and a file
 * that gets **committed to this repository** as ADR evidence. The issue
 * excludes "factory runtime state, credentials, transcripts, or control
 * artifacts" from the repository, so redaction here is a security boundary.
 *
 * Four rules make that boundary hold:
 *
 *  1. **Allowlist, not deny-list, for structure.** Top-level fields and
 *     payload *keys* are both enumerated. "Redacted" is not the same as "safe
 *     to publish": an ordinary, well-behaved engine emitting an ordinary
 *     metadata scalar (`user`, `hostname`, `project`, `input_tokens`) is a
 *     more realistic disclosure than an adversarial one crafting a JWT, so
 *     unknown payload keys are dropped even when their values look harmless.
 *  2. **Deny layer for values.** Whatever clears the structural allowlist is
 *     still tested for whitespace, path separators, credential prefixes, long
 *     opaque runs, JWT shape, and the daemon's own bearer token.
 *  3. **Names are data too.** A key can itself be the secret, so names are
 *     sanitised at every sink: kept payload keys, `droppedFields`, Markdown.
 *  4. **Total, never throwing.** `recordEvent` consumes a live SSE stream from
 *     a >=20-minute, expensive, effectively non-repeatable run. A recorder
 *     that throws on one nonconforming frame at minute 18 destroys the very
 *     artifact it exists to produce, so a rejected frame is *recorded as a
 *     rejection* and the stream continues.
 *
 * `droppedFields` records field **names only** — never a dropped value, and a
 * name that is itself unsafe becomes a fixed placeholder.
 *
 * The `ts` values recorded here are supplied by the caller; this module reads
 * no clock and performs no I/O.
 */

/** Shape a field name must have to be printable at all. */
const SAFE_FIELD_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Stand-in emitted whenever a field name is itself unsafe. */
const REDACTED_FIELD_NAME = "<redacted-field-name>";

/**
 * Credential prefixes, matched mid-string but only at a word boundary.
 *
 * The word boundary is load-bearing: `"task-a9b1ea142bc5"` *contains*
 * `"sk-"`, so an unanchored test denies every real Claudexor task id.
 */
const CREDENTIAL_PREFIX_PATTERN = /\b(sk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|Bearer\s)/i;

/**
 * An unbroken run of 32+ token characters, searched anywhere in the string.
 *
 * The class deliberately **excludes `-`**: including it made a canonical UUID
 * (`550e8400-e29b-41d4-a716-446655440000`, 36 unbroken chars) look like a
 * token, so a UUID-shaped `run_id` would be silently dropped and the committed
 * trace would lose the correlation key every row needs.
 */
const TOKEN_RUN_PATTERN = /[A-Za-z0-9_]{32,}/;

/**
 * Dot-separated base64url triple (JWT shape), length-gated so ordinary dotted
 * event types such as `task.contract.created` are not mistaken for a token.
 */
const JWT_TRIPLE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_MINIMUM_LENGTH = 40;

const WHITESPACE_PATTERN = /\s/;
const PATH_SEPARATOR_PATTERN = /[/\\]/;

/** Narrow allowlist for values that survived the deny layer. */
const ENUMISH_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * ISO-8601 instants, in `Z` **and** numeric-offset form. `+` is absent from
 * `ENUMISH_PATTERN`, so without this an offset-form `ts` would be rejected —
 * and, before this module was made total, would have thrown mid-stream.
 */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Top-level event fields that may be recorded, in render order. */
const ALLOWED_EVENT_FIELDS = ["seq", "ts", "type", "run_id", "task_id"] as const;

/**
 * Payload keys permitted into the committed evidence — the disclosure budget.
 *
 * Chosen so the trace can support the ADR's claims (lifecycle, routing,
 * cancellation, auth route) while carrying nothing about *who* ran it, *what*
 * project it ran against, or *how large* the workload was. Anything not listed
 * is dropped by name, including numbers.
 */
const ALLOWED_PAYLOAD_KEYS = [
  "state",
  "mode",
  "phase",
  "attempt",
  "kind",
  "reason",
  "outcome",
  "harness",
  "route",
  "source",
  "effective",
  "requested",
  "status",
  "code",
  "signal",
  "cancelled",
  "waiting_on_user",
] as const;

/** A recorded process observation (the PID evidence the issue requires). */
export interface ProcessRecord {
  readonly kind: "process";
  readonly label: string;
  readonly pid: number;
  readonly at: string;
}

/** Provenance of the engine that produced the trace. */
export interface ProvenanceRecord {
  readonly kind: "provenance";
  readonly protocolMajor: number;
  readonly operationsPath: string;
  readonly engineVersion: string;
  readonly engineSha: string;
  readonly matchesPin: boolean;
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

/** A frame that could not be recorded. Names the offending field only. */
export interface RejectedRecord {
  readonly kind: "rejected";
  readonly field: string;
  readonly seq: number | null;
}

export type TraceRecord = EventRecord | ProcessRecord | ProvenanceRecord | RejectedRecord;

export interface EventTraceOptions {
  /**
   * The daemon's bearer token. Any string value or field name that equals or
   * contains it is denied, regardless of any other match.
   */
  readonly daemonToken?: string;
}

export interface EventTrace {
  recordEvent(event: unknown): EventRecord | RejectedRecord;
  recordProcess(record: { label: string; pid: number; at: string }): ProcessRecord | RejectedRecord;
  recordProvenance(input: {
    protocolMajor: number;
    operationsPath: string;
    engineVersion: string;
    engineSha: string;
  }): ProvenanceRecord;
  entries(): readonly TraceRecord[];
  toMarkdown(): string;
}

/** True when a string must never be recorded in any form. */
function isDeniedString(value: string, daemonToken: string | undefined): boolean {
  if (value.length === 0) return true;
  if (WHITESPACE_PATTERN.test(value)) return true;
  if (PATH_SEPARATOR_PATTERN.test(value)) return true;
  if (CREDENTIAL_PREFIX_PATTERN.test(value)) return true;
  if (TOKEN_RUN_PATTERN.test(value)) return true;
  if (value.length >= JWT_MINIMUM_LENGTH && JWT_TRIPLE_PATTERN.test(value)) return true;
  if (daemonToken !== undefined && daemonToken.length > 0 && value.includes(daemonToken)) {
    return true;
  }
  return false;
}

function isAdmissibleString(value: string, daemonToken: string | undefined): boolean {
  return !isDeniedString(value, daemonToken) && ENUMISH_PATTERN.test(value);
}

/** Timestamps get their own allowlist so offset form survives. */
function admissibleTimestamp(value: unknown, daemonToken: string | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return `epoch:${value}`;
  if (typeof value !== "string") return null;
  if (isDeniedString(value, daemonToken)) return null;
  if (TIMESTAMP_PATTERN.test(value)) return value;
  return ENUMISH_PATTERN.test(value) ? value : null;
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

function sanitizePayload(
  payload: unknown,
  daemonToken: string | undefined,
  dropped: string[],
): Record<string, number | boolean | string> {
  // Null-prototype target so a `__proto__` key is an ordinary own property
  // rather than a silent no-op assignment that vanishes from the audit trail.
  const kept = Object.create(null) as Record<string, number | boolean | string>;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    // A non-object payload is withheld in full; say so rather than rendering
    // an empty `dropped` column that implies nothing was hidden.
    if (payload !== undefined) dropped.push("payload");
    return kept;
  }

  for (const key of Object.keys(payload as Record<string, unknown>)) {
    const rendered = safeFieldName(key, daemonToken);
    if (rendered === REDACTED_FIELD_NAME) {
      dropped.push(`payload.${REDACTED_FIELD_NAME}`);
      continue;
    }
    // Structural allowlist first: an unenumerated key is dropped whatever its
    // value looks like. This is what keeps `user`, `hostname`, `project` and
    // `input_tokens` out of a committed artifact.
    if (!(ALLOWED_PAYLOAD_KEYS as readonly string[]).includes(rendered)) {
      dropped.push(`payload.${rendered}`);
      continue;
    }

    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "number" ? Number.isFinite(value) : typeof value === "boolean") {
      kept[rendered] = value as number | boolean;
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

  function reject(field: string, seq: number | null): RejectedRecord {
    const entry: RejectedRecord = { kind: "rejected", field, seq };
    records.push(Object.freeze(entry));
    return entry;
  }

  return {
    recordEvent(event: unknown): EventRecord | RejectedRecord {
      try {
        if (typeof event !== "object" || event === null || Array.isArray(event)) {
          return reject("<root>", null);
        }
        const record = event as Record<string, unknown>;
        const dropped: string[] = [];

        const rawSeq = Object.hasOwn(record, "seq") ? record["seq"] : undefined;
        const seq =
          typeof rawSeq === "number" && Number.isInteger(rawSeq) && rawSeq >= 0 ? rawSeq : null;
        if (seq === null) return reject("seq", null);

        const ts = admissibleTimestamp(
          Object.hasOwn(record, "ts") ? record["ts"] : undefined,
          daemonToken,
        );
        if (ts === null) return reject("ts", seq);

        const rawType = Object.hasOwn(record, "type") ? record["type"] : undefined;
        if (typeof rawType !== "string" || !isAdmissibleString(rawType, daemonToken)) {
          return reject("type", seq);
        }

        const runId = readOptionalId(record, "run_id", daemonToken, dropped);
        const taskId = readOptionalId(record, "task_id", daemonToken, dropped);

        const payload = sanitizePayload(
          Object.hasOwn(record, "payload") ? record["payload"] : undefined,
          daemonToken,
          dropped,
        );

        for (const key of Object.keys(record)) {
          if ((ALLOWED_EVENT_FIELDS as readonly string[]).includes(key)) continue;
          if (key === "payload") continue;
          dropped.push(safeFieldName(key, daemonToken));
        }

        const entry: EventRecord = {
          kind: "event",
          seq,
          ts,
          type: rawType,
          runId,
          taskId,
          payload: Object.freeze(payload),
          droppedFields: Object.freeze([...dropped]),
        };
        records.push(Object.freeze(entry));
        return entry;
      } catch {
        // A throwing accessor on an engine-supplied object must not surface
        // its message, and must not abort the stream.
        return reject("<unreadable>", null);
      }
    },

    recordProcess({ label, pid, at }): ProcessRecord | RejectedRecord {
      if (!Number.isInteger(pid)) return reject("pid", null);
      const normalisedAt = admissibleTimestamp(at, daemonToken);
      if (normalisedAt === null) return reject("at", null);
      const entry: ProcessRecord = {
        kind: "process",
        label: safeFieldName(label, daemonToken),
        pid,
        at: normalisedAt,
      };
      records.push(Object.freeze(entry));
      return entry;
    },

    /**
     * Record the engine's self-reported identity.
     *
     * The pinned sha is 40 unbroken token characters, so it is denied by the
     * generic heuristics on purpose — yet it is the single most important
     * provenance fact in the spike. It is admitted here by *equality with the
     * compile-time pin constants*, never by pattern, so only known public
     * values can ever be printed; a mismatch is recorded as a flag, and the
     * observed value is not echoed.
     */
    recordProvenance({
      protocolMajor,
      operationsPath,
      engineVersion,
      engineSha,
    }): ProvenanceRecord {
      const matchesPin =
        engineVersion === EXPECTED_ENGINE_VERSION &&
        engineSha === EXPECTED_ENGINE_SHA &&
        protocolMajor === EXPECTED_PROTOCOL_MAJOR;
      const entry: ProvenanceRecord = {
        kind: "provenance",
        protocolMajor: matchesPin ? protocolMajor : EXPECTED_PROTOCOL_MAJOR,
        operationsPath: /^\/v2\/[A-Za-z0-9_-]{1,40}$/.test(operationsPath)
          ? operationsPath
          : "<rejected>",
        engineVersion: matchesPin ? EXPECTED_ENGINE_VERSION : "<mismatch>",
        engineSha: matchesPin ? EXPECTED_ENGINE_SHA : "<mismatch>",
        matchesPin,
      };
      records.push(Object.freeze(entry));
      return entry;
    },

    entries(): readonly TraceRecord[] {
      return Object.freeze([...records]);
    },

    toMarkdown(): string {
      const lines: string[] = [];
      const provenance = records.find(
        (entry): entry is ProvenanceRecord => entry.kind === "provenance",
      );
      if (provenance) {
        lines.push(
          "**Engine provenance**",
          "",
          `- protocol major: \`${provenance.protocolMajor}\``,
          `- operations path: \`${provenance.operationsPath}\``,
          `- engine version: \`${provenance.engineVersion}\``,
          `- engine sha: \`${provenance.engineSha}\``,
          `- matches pin: \`${provenance.matchesPin}\``,
          "",
        );
      }
      lines.push(
        "| # | timestamp | kind | type / label | run | task | pid | payload | dropped |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      );
      records.forEach((entry, index) => {
        const row = index + 1;
        if (entry.kind === "provenance") return;
        if (entry.kind === "rejected") {
          lines.push(`| ${row} | - | rejected | ${entry.field} | - | - | - | - | ${entry.field} |`);
          return;
        }
        if (entry.kind === "process") {
          lines.push(
            `| ${row} | ${entry.at} | process | ${entry.label} | - | - | ${entry.pid} | - | - |`,
          );
          return;
        }
        lines.push(
          `| ${row} | ${entry.ts} | event | ${entry.type} | ${entry.runId ?? "-"} | ` +
            `${entry.taskId ?? "-"} | - | ${renderPayload(entry.payload)} | ` +
            `${entry.droppedFields.length > 0 ? entry.droppedFields.join(", ") : "-"} |`,
        );
      });
      return lines.join("\n");
    },
  };
}

function readOptionalId(
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
