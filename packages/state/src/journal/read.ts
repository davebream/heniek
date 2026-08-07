/**
 * Named journal reads (design D4, D6, D10; plan Task 3.3).
 *
 * Every query orders by `sequence` ascending and binds its parameters — never
 * string interpolation (V15). `readEventsForRun` rides the
 * `(run_id, sequence)` index from migration 1, so per-run order falls out of
 * the global order for free (D4).
 *
 * `ReadEventsOptions` deliberately has **no** `limit` (finding MIN-04):
 * nothing in this package pages the journal — `replayJournal` walks it whole
 * through `throughSequence` — and a speculative parameter with no caller is
 * exactly the over-reach X4 bans. Add one in a later issue against a real
 * paging consumer.
 */

import { internalHandle, type StateDatabase } from "../database/open.js";
import { toSafeInteger } from "../database/pragma.js";
import { type StateEvent, toStateEvent } from "./event.js";

export interface ReadEventsOptions {
  /** Exclusive lower bound. */
  readonly afterSequence?: number;
  /** Inclusive upper bound. */
  readonly throughSequence?: number;
}

/**
 * Builds the shared `sequence` window as a SQL fragment plus its bound
 * parameters, in a fixed order, so both readers below apply the bounds
 * identically. Returning the parameters alongside the text keeps the binding
 * positional and impossible to desynchronise from the fragment.
 */
function sequenceWindow(
  options: ReadEventsOptions | undefined,
  leading: "WHERE" | "AND",
): { readonly sql: string; readonly parameters: readonly number[] } {
  const clauses: string[] = [];
  const parameters: number[] = [];
  if (options?.afterSequence !== undefined) {
    clauses.push("sequence > ?");
    parameters.push(options.afterSequence);
  }
  if (options?.throughSequence !== undefined) {
    clauses.push("sequence <= ?");
    parameters.push(options.throughSequence);
  }
  if (clauses.length === 0) {
    return { sql: "", parameters };
  }
  return { sql: ` ${leading} ${clauses.join(" AND ")}`, parameters };
}

const EVENT_COLUMNS =
  "sequence, event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload";

export function readEvents(db: StateDatabase, options?: ReadEventsOptions): readonly StateEvent[] {
  const window = sequenceWindow(options, "WHERE");
  const rows = internalHandle(db)
    .prepare(`SELECT ${EVENT_COLUMNS} FROM state_event${window.sql} ORDER BY sequence`)
    .all(...window.parameters);
  return rows.map((row) => toStateEvent(row));
}

export function readEventsForRun(
  db: StateDatabase,
  runId: string,
  options?: ReadEventsOptions,
): readonly StateEvent[] {
  const window = sequenceWindow(options, "AND");
  const rows = internalHandle(db)
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM state_event WHERE run_id = ?${window.sql} ORDER BY sequence`,
    )
    .all(runId, ...window.parameters);
  return rows.map((row) => toStateEvent(row));
}

/** `0` when the journal is empty — `MAX()` over no rows is NULL, not an error. */
export function latestSequence(db: StateDatabase): number {
  const row = internalHandle(db)
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS s FROM state_event")
    .get();
  if (row === undefined) {
    // Unreachable in practice — an aggregate with no GROUP BY always returns
    // exactly one row — but `.get()` is typed `| undefined` and silently
    // treating that as 0 would hide a genuinely broken query.
    throw new Error("latestSequence: aggregate query returned no row");
  }
  return toSafeInteger(row.s, "latestSequence");
}

/**
 * Internal — `commitStateChange` uses this to copy a parent event's
 * correlation ID (D6). Exported from this module but **not** from
 * `src/index.ts`.
 */
export function readEventById(db: StateDatabase, eventId: string): StateEvent | undefined {
  const row = internalHandle(db)
    .prepare(`SELECT ${EVENT_COLUMNS} FROM state_event WHERE event_id = ?`)
    .get(eventId);
  return row === undefined ? undefined : toStateEvent(row);
}
