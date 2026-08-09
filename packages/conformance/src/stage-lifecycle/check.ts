import type { RunStatus } from "@heniek/contracts";
import { STAGE_LIFECYCLE_TRANSITIONS, type StageLifecycleTrigger } from "./transitions.js";

/** One observed step of a native stage's lifecycle — a trigger and the `RunStatus` it moved to. */
export interface StageLifecycleEvent {
  readonly trigger: StageLifecycleTrigger;
  readonly from: RunStatus | null;
  readonly to: RunStatus;
}

export interface StageLifecycleViolation {
  readonly index: number;
  readonly event: StageLifecycleEvent;
  readonly reason: string;
}

export interface StageLifecycleCheckResult {
  readonly ok: boolean;
  readonly violations: readonly StageLifecycleViolation[];
}

function transitionKey(event: {
  readonly trigger: StageLifecycleTrigger;
  readonly from: RunStatus | null;
  readonly to: RunStatus;
}): string {
  return `${event.trigger}|${event.from ?? "<none>"}|${event.to}`;
}

const LEGAL_TRANSITIONS = new Set(STAGE_LIFECYCLE_TRANSITIONS.map(transitionKey));

/**
 * Checks a recorded sequence of native stage lifecycle events against
 * `STAGE_LIFECYCLE_TRANSITIONS`. Pure: no I/O, no clock, no randomness — a
 * trace collected anywhere (a store-level test, the real RPC canary) can be
 * checked here without pulling in whatever produced it.
 *
 * Two independent things can go wrong, and both are reported rather than
 * the first one found short-circuiting the rest: an event whose `(trigger,
 * from, to)` triple matches no declared transition (an emitter did
 * something the lifecycle table does not sanction), and a non-`null` `from`
 * that does not match the immediately preceding event's `to` (the trace was
 * assembled out of order). A `from: null` event never triggers this second
 * check — it asserts a fresh run starting, not a continuation of whatever
 * came before — which is what lets a caller concatenate several runs'
 * traces into one array (e.g. a canary that starts more than one native
 * stage) without a synthetic "reset" marker between them.
 */
export function checkStageLifecycleTrace(
  trace: readonly StageLifecycleEvent[],
): StageLifecycleCheckResult {
  const violations: StageLifecycleViolation[] = [];
  let previousTo: RunStatus | null = null;

  trace.forEach((event, index) => {
    if (event.from !== null && event.from !== previousTo) {
      violations.push({
        index,
        event,
        reason: `from (${event.from}) does not match the previous event's to (${previousTo ?? "<none>"}) — the trace is not one causally connected sequence`,
      });
    }
    if (!LEGAL_TRANSITIONS.has(transitionKey(event))) {
      violations.push({
        index,
        event,
        reason: `no STAGE_LIFECYCLE_TRANSITIONS entry for trigger "${event.trigger}" from ${event.from ?? "<none>"} to "${event.to}"`,
      });
    }
    previousTo = event.to;
  });

  return { ok: violations.length === 0, violations };
}
