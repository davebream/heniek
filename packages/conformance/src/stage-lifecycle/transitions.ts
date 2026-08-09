import type { RunStatus } from "@heniek/contracts";

/**
 * Q023's native stage lifecycle (ADR 0021), expressed as data rather than as
 * imperative CAS logic — `@heniek/state`'s `native-bridge/store.ts` enforces
 * every one of these transitions at the row level (`WHERE state = ? AND
 * revision = ?`, `changes === 1`), but nothing there is checkable from
 * outside that package. This table is the portable, dependency-light
 * restatement a trace collected anywhere in the repo (a service-level test,
 * a real RPC canary) can be checked against without pulling in `@heniek/state`
 * or `@heniek/daemon`.
 *
 * `from: null` marks the transition that creates the run — there is no prior
 * `RunStatus` to compare against. Every other entry's `from`/`to` pair is
 * exactly what `packages/daemon/test/native-bridge-rpc.test.ts`'s real
 * assembled-daemon canary observes over a live socket, cross-checked against
 * the store functions that produce it (`createNativeStage`, `pollNativeBridge`,
 * `raiseNativeQuestion`, `answerNativeQuestion`, `settleNativeDispatch`,
 * `detachParentSession`, `reapExpirations`, `resumeNativeStage`,
 * `cancelNativeStage`).
 */
export type StageLifecycleTrigger =
  | "stage_start_admitted_waiting"
  | "stage_start_admitted_dispatched"
  | "poll_claim"
  | "raise_question"
  | "answer_question"
  | "submit_succeeded"
  | "submit_failed"
  | "graceful_detach_corroborated"
  | "expiry_dead_or_unknown"
  | "expiry_alive"
  | "resume"
  | "cancel";

export interface StageLifecycleTransition {
  readonly trigger: StageLifecycleTrigger;
  readonly from: RunStatus | null;
  readonly to: RunStatus;
}

function transition(
  trigger: StageLifecycleTrigger,
  from: RunStatus | null,
  to: RunStatus,
): StageLifecycleTransition {
  return { trigger, from, to };
}

/**
 * Every `RunStatus` a native stage can be cancelled from — every non-terminal
 * status this lifecycle actually reaches. `queued` is excluded on purpose: a
 * native stage never queues (it has no capacity/account resource to wait on
 * — that is exactly D1's "native has no account by construction"), so
 * `queued -> cancelled` would assert a transition this lifecycle can never
 * produce.
 */
const CANCELLABLE_FROM: readonly RunStatus[] = [
  "running",
  "waiting_on_user",
  "waiting_for_parent_session",
  "recovery_required",
];

export const STAGE_LIFECYCLE_TRANSITIONS: readonly StageLifecycleTransition[] = [
  transition("stage_start_admitted_waiting", null, "waiting_for_parent_session"),
  transition("stage_start_admitted_dispatched", null, "running"),
  transition("poll_claim", "waiting_for_parent_session", "running"),
  transition("raise_question", "running", "waiting_on_user"),
  transition("answer_question", "waiting_on_user", "running"),
  transition("submit_succeeded", "running", "succeeded"),
  transition("submit_failed", "running", "failed"),
  transition("graceful_detach_corroborated", "running", "waiting_for_parent_session"),
  transition("expiry_dead_or_unknown", "running", "recovery_required"),
  // Self-loop, deliberately: CR6's "alive -> do not expire the attempt" —
  // the session is marked stalled, but the run/stage/attempt are untouched.
  transition("expiry_alive", "running", "running"),
  transition("resume", "recovery_required", "waiting_for_parent_session"),
  ...CANCELLABLE_FROM.map((from) => transition("cancel", from, "cancelled")),
];
