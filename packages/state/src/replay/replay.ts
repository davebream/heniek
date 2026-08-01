/**
 * Journal replay (design D11; plan Task 5.1) — the fold half of AC3.
 *
 * Events are folded from `EMPTY_PROJECTION_STATE` **into an in-memory
 * `ProjectionState`**, not into a scratch database.
 *
 * *Rejected (D11.2), do not implement:* replay into a scratch SQLite database
 * via `serialize`/`deserialize`. The scratch database would have to carry the
 * journal too, because the projection's foreign key requires it — so it either
 * copies every event or `ATTACH`es the source, which is real complexity for no
 * gain when the comparison is between two *values*. *Also rejected:*
 * `createSession`/`applyChangeset`, which detects byte differences between two
 * databases rather than reducer-versus-stored disagreement.
 *
 * `commitStateChange` and `replayJournal` call the **same** reducer on
 * purpose. A divergence can therefore only mean the stored state was reached
 * by some route other than that reducer — exactly what AC3 asks the tool to
 * detect. Two independent reducers would weaken "converged" into "two
 * implementations happen to agree".
 */

import type { StateDatabase } from "../database/open.js";
import { latestSequence, readEvents } from "../journal/read.js";
import { applyEvent, type Reducer } from "../projection/reducer.js";
import { EMPTY_PROJECTION_STATE, type ProjectionState } from "../projection/state.js";

export interface ReplayOptions {
  /**
   * Defaults to `applyEvent`. Present so a test can inject a deliberately
   * wrong reducer (D11.4) — that injection is what makes the "detects
   * divergence" half of AC3 a real claim rather than an untested branch.
   */
  readonly reducer?: Reducer;
  /** Inclusive. Defaults to `latestSequence(db)`. */
  readonly throughSequence?: number;
}

export interface ReplayResult {
  readonly state: ProjectionState;
  readonly eventsReplayed: number;
  /** `0` when the journal is empty. */
  readonly throughSequence: number;
}

export function replayJournal(db: StateDatabase, options?: ReplayOptions): ReplayResult {
  const throughSequence = options?.throughSequence ?? latestSequence(db);
  const reducer = options?.reducer ?? applyEvent;
  const events = readEvents(db, { throughSequence });

  let state: ProjectionState = EMPTY_PROJECTION_STATE;
  for (const event of events) {
    state = reducer(state, event);
  }

  return { state, eventsReplayed: events.length, throughSequence };
}
