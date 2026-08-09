import { defineStates } from "../kernel/index.js";

/**
 * Lifecycle of an attached parent session.
 *
 * `stalled` exists because a lease TTL answers "did it stop polling?", which
 * has three causes and only one of them is safe to treat as "nobody is
 * executing this stage". When the owner liveness witness still reports
 * `alive` — a parent busy inside one long tool call rather than a departed
 * one — the session is stalled and its dispatches stay open. Collapsing that
 * case into `expired` is what would let a woken parent submit against a
 * superseded attempt (ADR 0021 D7).
 */
export const ParentSessionState = defineStates({
  nonTerminal: ["attached", "stalled"],
  terminal: ["detached", "expired", "superseded"],
});
export type ParentSessionState = (typeof ParentSessionState)["values"][number];

/**
 * Lifecycle of one dispatch. Deliberately one-shot: the only exits from
 * `dispatched`/`waiting_on_user` are terminal, and every terminal exit is
 * recorded with a reason, so "we cancelled it" and "we lost you" are never
 * confused after the fact.
 *
 * `abandoned` is reached by lease expiry and by a corroborated detach;
 * `revoked` by cancellation and by fencing. Both bump the dispatch revision
 * on the way out, which is what makes a late submit from a woken parent
 * unmatchable rather than merely unlikely.
 */
export const NativeDispatchState = defineStates({
  nonTerminal: ["dispatched", "waiting_on_user"],
  terminal: ["submitted", "revoked", "abandoned"],
});
export type NativeDispatchState = (typeof NativeDispatchState)["values"][number];

/**
 * Lifecycle of a native stage, distinct from both `RunStatus` (what callers
 * see) and `NativeDispatchState` (what one handover is doing). A stage
 * outlives its dispatches: it returns to `waiting_for_parent` after a
 * corroborated detach and is redispatched as a new attempt ordinal, which is
 * exactly §9.5's "a new attempt rather than guaranteed hidden-context
 * continuation".
 *
 * `waiting_for_parent` is the stage-level fact behind the run-level
 * `waiting_for_parent_session`; the run status stays the public vocabulary
 * and this one stays internal to the bridge.
 */
export const NativeStageState = defineStates({
  nonTerminal: ["waiting_for_parent", "dispatched", "waiting_on_user", "recovery_required"],
  terminal: ["settled"],
});
export type NativeStageState = (typeof NativeStageState)["values"][number];
