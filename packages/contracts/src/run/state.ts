import { defineStates } from "../kernel/index.js";

/**
 * Canonical run lifecycle status. Grounded in the §17.1 state diagram
 * (`QUEUED → RUNNING → {WAITING_ON_USER, WAITING_FOR_PARENT_SESSION,
 * SUCCEEDED, FAILED, CANCELLED}` — "questions are normal state", not a
 * side channel), extended with `recovery_required` per §18.2's restart
 * boundary so the run projection can honestly reflect an attempt awaiting
 * an explicit resume/retry/fail decision without callers reaching into
 * execution-backend internals.
 */
export const RunStatus = defineStates({
  nonTerminal: [
    "queued",
    "running",
    "waiting_on_user",
    "waiting_for_parent_session",
    "recovery_required",
  ],
  terminal: ["succeeded", "failed", "cancelled"],
});
export type RunStatus = (typeof RunStatus)["values"][number];
