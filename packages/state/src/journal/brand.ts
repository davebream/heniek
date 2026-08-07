/**
 * The package's **one and only sanctioned assertion site** for the four
 * journal brands (plan Task 3.2, finding MIN-03).
 *
 * `Brand` from `@heniek/contracts` is a phantom tag with no runtime
 * constructor, so turning a plain `string`/`number` into an
 * `EventId`/`CorrelationId`/`CausationEventId`/`EventSequence` requires *some*
 * unchecked cast. The rule Tasks 1.5/3.4 enforce — "no `as` on a raw row" —
 * bans casting inside a row narrower; it cannot ban brand construction
 * outright. Rather than scatter that cast across `toStateEvent`,
 * `appendEvent` and `commitStateChange`, all four live here, exhaustively
 * enumerated, so a reviewer auditing every unchecked cast in `@heniek/state`
 * has exactly one file to read.
 *
 * Each body is exactly `return value as <Brand>` and nothing else. These are
 * **not** validators: the caller is responsible for having narrowed `value`
 * to a `string`/`number` first (via `toText`/`toSafeInteger`), and the brand
 * is a compile-time claim about provenance, not a runtime check. Adding
 * validation here would be a silent behaviour change for every call site —
 * if a brand ever needs enforcing, that belongs in an explicitly named
 * validator, not smuggled into these one-liners.
 */

import type { CausationEventId, CorrelationId, EventId, EventSequence } from "./event.js";

export function asEventId(value: string): EventId {
  return value as EventId;
}

export function asCorrelationId(value: string): CorrelationId {
  return value as CorrelationId;
}

export function asCausationEventId(value: string): CausationEventId {
  return value as CausationEventId;
}

export function asEventSequence(value: number): EventSequence {
  return value as EventSequence;
}
