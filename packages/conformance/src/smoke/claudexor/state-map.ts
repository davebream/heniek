import type { RunStatus } from "@heniek/contracts";

/**
 * Claudexor run lifecycle -> the canonical Heniek `RunStatus` vocabulary.
 *
 * The target vocabulary is deliberately **not** redeclared here: it is
 * `RunStatus` from `@heniek/contracts` (§17.1's diagram extended with
 * `recovery_required` per §18.2). A parallel copy would typecheck fine and
 * still fail to transfer to a production adapter, and would go stale silently
 * when the contract gains a state.
 *
 * The two vocabularies are not isomorphic, and that asymmetry is the spike's
 * contract-shaping output:
 *
 *  - Claudexor's lifecycle has **no waiting state**. Waiting is carried
 *    out-of-band on `summary.waitingOnUser` plus the interactions
 *    sub-resource, so `waiting_on_user` must be *derived* from both, never
 *    mapped one-to-one.
 *  - Claudexor has `interrupted`, which Heniek does not.
 *  - Heniek's `waiting_for_parent_session` has no Claudexor source at all: it
 *    belongs to native stages (§18.3) and stays Heniek-owned, so this function
 *    never returns it.
 *
 * Pure: no network, filesystem, process, or clock access.
 */

/** Run lifecycle states the pinned Claudexor control API reports. */
export const CLAUDEXOR_RUN_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type ClaudexorRunState = (typeof CLAUDEXOR_RUN_STATES)[number];

/**
 * PROVISIONAL mapping: `interrupted` -> `recovery_required`.
 *
 * Nothing has yet observed what *produces* `interrupted` on the pinned engine
 * — only that the enum contains it. §18.2's `recovery_required` describes
 * *Heniek's* uncertainty about an attempt's outcome, which is not obviously
 * the same thing as a state Claudexor asserts with knowledge (a deliberate
 * user interrupt would be certain and finished, and `recovery_required` is
 * non-terminal, so such a run would never settle without intervention).
 *
 * Canary 4 (daemon restart / recovery) is the experiment that decides this.
 * Until it reports, this mapping is a hypothesis, must be labelled as such in
 * the ADR, and must not be counted as a satisfied "bounded fallback".
 */
export const INTERRUPTED_MAPPING_IS_PROVISIONAL = true;

/** The observation this mapping consumes. */
export interface ClaudexorRunObservation {
  readonly state: string;
  readonly waitingOnUser: boolean;
  /**
   * Number of open interactions on the run. Spec §17 treats questions as
   * normal state, and the flag alone can lag or race a question raised as the
   * run settles, so the derivation consults both.
   */
  readonly openInteractions?: number;
}

/** The control API reported a lifecycle state this mapping does not know. */
export class UnknownClaudexorRunStateError extends Error {
  constructor(readonly observed: string) {
    // Bounded and sanitised: this message reaches CI logs and possibly the
    // ADR, and the observed value is engine-controlled.
    super(
      `unknown Claudexor run state ${quoteBounded(observed)}; known states are ${CLAUDEXOR_RUN_STATES.join(", ")}`,
    );
    this.name = "UnknownClaudexorRunStateError";
  }
}

/** Render an engine-controlled value for an error message, bounded and safe. */
function quoteBounded(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, "");
  if (cleaned.length === 0) return "<unprintable>";
  return `"${cleaned.slice(0, 64)}"`;
}

function isClaudexorRunState(value: string): value is ClaudexorRunState {
  return (CLAUDEXOR_RUN_STATES as readonly string[]).includes(value);
}

/**
 * Map one Claudexor run observation onto the canonical `RunStatus`.
 *
 * Throws on an unrecognised state rather than coercing it: a silently
 * mis-mapped terminal state would let a failed attempt read as healthy.
 */
export function toHeniekRunState(observation: ClaudexorRunObservation): RunStatus {
  const { state, waitingOnUser } = observation;
  if (!isClaudexorRunState(state)) {
    throw new UnknownClaudexorRunStateError(state);
  }

  const awaitingUser = waitingOnUser || (observation.openInteractions ?? 0) > 0;

  switch (state) {
    case "queued":
      // A question can be raised before the run leaves the queue; the
      // derivation applies to every non-terminal state, not just `running`.
      return awaitingUser ? "waiting_on_user" : "queued";
    case "running":
      return awaitingUser ? "waiting_on_user" : "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      // PROVISIONAL — see INTERRUPTED_MAPPING_IS_PROVISIONAL.
      return "recovery_required";
  }
}
