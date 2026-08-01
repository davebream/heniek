/**
 * The journal's event shape and the one raw-row → `StateEvent` narrowing
 * (design D4, D6; plan Task 3.2).
 *
 * Brands reuse `@heniek/contracts`'s `Brand` helper rather than inventing a
 * second nominal-typing mechanism — the precedent is
 * `packages/conformance/src/kernel/seed.ts`. Construction of those brands is
 * confined to `./brand.js`; this module calls those helpers rather than
 * casting locally.
 */

import type { Brand } from "@heniek/contracts";
import { toNullableText, toSafeInteger, toText } from "../database/pragma.js";
import { type JsonValue, parseJsonValue } from "../json.js";
import { asCausationEventId, asCorrelationId, asEventId, asEventSequence } from "./brand.js";

export type EventId = Brand<string, "StateEventId">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type CausationEventId = Brand<string, "CausationEventId">;
export type EventSequence = Brand<number, "EventSequence">;

export interface StateEvent {
  readonly sequence: EventSequence;
  readonly eventId: EventId;
  /**
   * `null` for identity events (`codebase.registered`,
   * `repository.registered`, `workspace.registered`), which are not
   * run-scoped (finding C5). Present for every `run.*` event.
   */
  readonly runId: string | null;
  readonly correlationId: CorrelationId;
  /** `null` only at a chain root. */
  readonly causationEventId: CausationEventId | null;
  readonly type: string;
  /** ISO-8601 UTC with ms. **Not** an ordering key — `sequence` is. */
  readonly recordedAt: string;
  readonly payload: JsonValue;
}

/**
 * What `appendEvent` consumes.
 *
 * `correlationId` is deliberately **absent**: D6's propagation rule is
 * executed, not documented — a caller cannot supply a wrong correlation ID
 * for a non-root event because there is no parameter for it.
 * `commitStateChange` copies it from the parent event.
 *
 * `runId` and `causationEventId` are `?:` rather than `: T | null` (finding
 * C5): under `exactOptionalPropertyTypes` a caller emitting an identity
 * event, or an event at a chain root, **omits** the key entirely — typically
 * via a conditional spread, `...(runId !== undefined ? { runId } : {})` —
 * and never passes an explicit `undefined`.
 */
export interface AppendEventInput {
  readonly runId?: string;
  readonly type: string;
  readonly payload: JsonValue;
  readonly causationEventId?: CausationEventId;
}

/**
 * The one place a raw journal row becomes a `StateEvent`. No `as` on the row:
 * every column goes through `toSafeInteger`/`toText`/`toNullableText`, and the
 * four brands are applied by `./brand.js`'s helpers.
 *
 * `run_id` and `causation_event_id` read as `null` via `toNullableText`,
 * never coerced to `""` — an empty string is a distinct, valid value the
 * schema would happily store, so collapsing the two would make an
 * unset-vs-empty bug invisible.
 */
export function toStateEvent(raw: Record<string, unknown>): StateEvent {
  const causationEventId = toNullableText(raw.causation_event_id, "state_event.causation_event_id");
  return {
    sequence: asEventSequence(toSafeInteger(raw.sequence, "state_event.sequence")),
    eventId: asEventId(toText(raw.event_id, "state_event.event_id")),
    runId: toNullableText(raw.run_id, "state_event.run_id"),
    correlationId: asCorrelationId(toText(raw.correlation_id, "state_event.correlation_id")),
    causationEventId: causationEventId === null ? null : asCausationEventId(causationEventId),
    type: toText(raw.type, "state_event.type"),
    recordedAt: toText(raw.recorded_at, "state_event.recorded_at"),
    payload: parseJsonValue(toText(raw.payload, "state_event.payload"), "state_event.payload"),
  };
}
