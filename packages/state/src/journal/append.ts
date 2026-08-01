/**
 * INTERNAL — the journal's only writer, reachable only from
 * `commitStateChange` (design D4, D7; plan Task 4.3). **Not** exported from
 * `src/index.ts`: the whole structural claim behind AC2 is that there is no
 * exported way to write an event without also writing the projection in the
 * same transaction.
 */

import { internalHandle, internalIds, type StateDatabase } from "../database/open.js";
import { toSafeInteger } from "../database/pragma.js";
import { PayloadTooLargeError, StateStoreError } from "../errors.js";
import { type JsonValue, stringifyCanonical, utf8ByteLength } from "../json.js";
import { asCausationEventId, asCorrelationId, asEventId, asEventSequence } from "./brand.js";
import type { CausationEventId, CorrelationId, StateEvent } from "./event.js";

/**
 * 64 KiB of UTF-8, from CloudEvents' "Size Limits" — the same rule X1 and
 * §16.3 state in different words. Measured in *bytes*, never in
 * `String.length`: a payload of astral-plane characters is two UTF-16 code
 * units per character and would slip a cap expressed in `.length`.
 */
const MAX_PAYLOAD_BYTES = 65_536;

/**
 * `namespace.name`, both segments lowercase-alphanumeric with underscores.
 * The six-member vocabulary already conforms; this guard exists to stop a
 * free-form string reaching `state_event.type`, the reducer's `switch`, and
 * every error message derived from it (finding M6).
 */
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * Generous relative to any real id shape — just enough to stop an unbounded
 * string reaching a `TEXT` column and every log line derived from it.
 */
const MAX_RUN_ID_BYTES = 256;

export interface AppendEventFields {
  /**
   * `?:`, not `: string | null` (finding C5) — omit it entirely for an
   * identity event; never pass `{ runId: undefined }` under
   * `exactOptionalPropertyTypes`.
   */
  readonly runId?: string;
  readonly type: string;
  readonly payload: JsonValue;
  readonly correlationId: CorrelationId;
  readonly causationEventId: CausationEventId | null;
  readonly recordedAt: string;
}

export function appendEvent(db: StateDatabase, input: AppendEventFields): StateEvent {
  const handle = internalHandle(db);
  // Step 1 — this function must never write outside a transaction. Writing
  // the event without the projection write that has to accompany it is
  // exactly the split AC2 forbids.
  if (!handle.isTransaction) {
    throw new StateStoreError("appendEvent: must be called inside an open transaction");
  }

  // Step 2 — validate `type` and `runId` (finding M6).
  if (!EVENT_TYPE_PATTERN.test(input.type)) {
    throw new StateStoreError(
      `appendEvent: event type must match ${EVENT_TYPE_PATTERN.source} (got "${input.type}")`,
    );
  }
  if (input.runId !== undefined) {
    if (input.runId.length === 0) {
      throw new StateStoreError("appendEvent: runId must not be empty");
    }
    const runIdBytes = utf8ByteLength(input.runId);
    if (runIdBytes > MAX_RUN_ID_BYTES) {
      // Names the field and the length, never the value — an over-length id
      // is exactly the kind of thing that should not be echoed into a log.
      throw new StateStoreError(
        `appendEvent: runId is ${runIdBytes} bytes, exceeding the ${MAX_RUN_ID_BYTES}-byte bound`,
      );
    }
  }

  // Steps 3-4 — canonical text, then the byte cap. The error names the event
  // type and the byte count and never the payload itself.
  const text = stringifyCanonical(input.payload);
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(input.type, bytes);
  }

  // Step 5 — the injected generator, never an ambient source.
  const eventId = internalIds(db).next("evt");

  // Step 6 — `sequence` is omitted so SQLite assigns the rowid. `runId ??
  // null` is all the special-casing a nullable TEXT column needs.
  const result = handle
    .prepare(
      "INSERT INTO state_event" +
        " (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      eventId,
      input.runId ?? null,
      input.correlationId,
      input.causationEventId,
      input.type,
      input.recordedAt,
      text,
    );

  // Step 7 — D4's boundary assertion. Reading an INTEGER above 2^53 throws
  // ERR_OUT_OF_RANGE rather than silently losing precision (V3/STD-2), so
  // this turns a RangeError from deep inside a read path into a typed error
  // at a known statement. `setReadBigInts` stays off everywhere (V4).
  const sequence = toSafeInteger(result.lastInsertRowid, "state_event.sequence");

  return {
    sequence: asEventSequence(sequence),
    eventId: asEventId(eventId),
    runId: input.runId ?? null,
    correlationId: asCorrelationId(input.correlationId),
    causationEventId:
      input.causationEventId === null ? null : asCausationEventId(input.causationEventId),
    type: input.type,
    recordedAt: input.recordedAt,
    payload: input.payload,
  };
}
