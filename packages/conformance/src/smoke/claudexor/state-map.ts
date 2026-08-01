/**
 * Claudexor run lifecycle -> Heniek run-state vocabulary.
 *
 * The two vocabularies are not isomorphic, and that asymmetry is the point:
 *
 *  - Claudexor's lifecycle has **no waiting state**. Waiting is carried
 *    out-of-band on `summary.waitingOnUser` plus the interactions
 *    sub-resource, so Heniek's `WAITING_ON_USER` (spec §17.1) must be
 *    *derived*, never mapped one-to-one.
 *  - Claudexor has `interrupted`, which Heniek does not. It means an attempt
 *    whose outcome is unknown, so it maps to `RECOVERY_REQUIRED` (spec §18.2):
 *    the runtime must offer an explicit resume/retry/fail decision and must
 *    never silently duplicate a write attempt.
 *  - Heniek's `WAITING_FOR_PARENT_SESSION` has no Claudexor source at all. It
 *    belongs to native stages (spec §18.3) and stays Heniek-owned, so this
 *    function never returns it.
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

/** Heniek's run-state vocabulary (spec §17.1). */
export type HeniekRunState =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_ON_USER"
  | "WAITING_FOR_PARENT_SESSION"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "RECOVERY_REQUIRED";

/** The observation this mapping consumes. */
export interface ClaudexorRunObservation {
  readonly state: string;
  readonly waitingOnUser: boolean;
}

/** The control API reported a lifecycle state this mapping does not know. */
export class UnknownClaudexorRunStateError extends Error {
  constructor(readonly observed: string) {
    super(
      `unknown Claudexor run state "${observed}"; known states are ${CLAUDEXOR_RUN_STATES.join(", ")}`,
    );
    this.name = "UnknownClaudexorRunStateError";
  }
}

function isClaudexorRunState(value: string): value is ClaudexorRunState {
  return (CLAUDEXOR_RUN_STATES as readonly string[]).includes(value);
}

/**
 * Map one Claudexor run observation onto Heniek's vocabulary.
 *
 * Throws on an unrecognised state rather than coercing it: a silently
 * mis-mapped terminal state would let a failed attempt read as healthy.
 */
export function toHeniekRunState(observation: ClaudexorRunObservation): HeniekRunState {
  const { state, waitingOnUser } = observation;
  if (!isClaudexorRunState(state)) {
    throw new UnknownClaudexorRunStateError(state);
  }

  switch (state) {
    case "queued":
      return "QUEUED";
    case "running":
      // Derived, not mapped: Claudexor has no waiting lifecycle state.
      return waitingOnUser ? "WAITING_ON_USER" : "RUNNING";
    case "succeeded":
      return "SUCCEEDED";
    case "failed":
      return "FAILED";
    case "cancelled":
      return "CANCELLED";
    case "interrupted":
      // Uncertain attempt: explicit operator decision, never a silent retry.
      return "RECOVERY_REQUIRED";
  }
}
