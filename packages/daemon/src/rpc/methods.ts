/**
 * The method registry (design C8, plan Task 3 Step 6) — a
 * `Map<string, MethodHandler>` so a later HTTP+SSE adapter (design
 * Alternative F) can register against it without touching `dispatch.ts`.
 * This phase declares the namespace and the registry shape; the concrete
 * `daemon.status`/`daemon.recovery` handlers are wired in by a later
 * phase's composition root, once the lifecycle state machine (C9) and
 * reconciliation (C11/C12) they read from exist.
 */

export const DAEMON_HELLO_METHOD = "daemon.hello";
export const DAEMON_STATUS_METHOD = "daemon.status";
export const DAEMON_RECOVERY_METHOD = "daemon.recovery";
export const DAEMON_NEGOTIATE_METHOD = "daemon.negotiate";
export const DAEMON_STATUS_V1_METHOD = "daemon.status.v1";
export const DAEMON_RECOVERY_V1_METHOD = "daemon.recovery.v1";
export {
  ARTIFACT_GET_V1_METHOD,
  CODEBASE_DETECT_V1_METHOD,
  CODEBASE_ONBOARD_APPLY_V1_METHOD,
  CODEBASE_ONBOARD_PROPOSE_V1_METHOD,
  CODEBASE_REGISTER_V1_METHOD,
  DOCTOR_V1_METHOD,
  DOCTOR_V2_METHOD,
  ENGINE_CATALOGUE_V1_METHOD,
  INBOX_LIST_V1_METHOD,
  NATIVE_STAGE_POLL_V1_METHOD,
  NATIVE_STAGE_POLL_V2_METHOD,
  NATIVE_STAGE_QUESTION_V1_METHOD,
  NATIVE_STAGE_STATUS_V1_METHOD,
  NATIVE_STAGE_SUBMIT_V1_METHOD,
  PARENT_SESSION_ATTACH_V1_METHOD,
  PARENT_SESSION_DETACH_V1_METHOD,
  PIPELINE_ATTACH_V1_METHOD,
  PIPELINE_RUN_V1_METHOD,
  PIPELINE_VALIDATE_V1_METHOD,
  RUN_ANSWER_V1_METHOD,
  RUN_ANSWER_V2_METHOD,
  RUN_CANCEL_V1_METHOD,
  RUN_RESULT_V1_METHOD,
  RUN_RESULT_V2_METHOD,
  RUN_RESULT_V3_METHOD,
  RUN_RESULT_V4_METHOD,
  RUN_RESUME_V1_METHOD,
  RUN_RESUME_V2_METHOD,
  RUN_STATUS_V1_METHOD,
  RUN_STATUS_V2_METHOD,
  RUN_STATUS_V3_METHOD,
  RUN_STATUS_V4_METHOD,
  STAGE_START_V1_METHOD,
  STAGE_START_V2_METHOD,
  STAGE_START_V3_METHOD,
  STAGE_START_V4_METHOD,
} from "@heniek/protocol";
export const RPC_CANCEL_METHOD = "rpc.cancel";

/**
 * Authenticated methods. `daemon.hello` is pre-auth and is never registered
 * here. Q023 adds the native bridge's six methods; `stage.start`,
 * `run.status`, `run.result` already cover their v3/v4 negotiated variants
 * — a method family is named once here regardless of how many versions
 * `dispatch.ts`'s `availableByName` table offers for it.
 */
export const AUTHENTICATED_METHODS = [
  DAEMON_STATUS_METHOD,
  DAEMON_RECOVERY_METHOD,
  "codebase.detect",
  "codebase.register",
  "codebase.onboard.propose",
  "codebase.onboard.apply",
  "stage.start",
  "run.status",
  "inbox.list",
  "run.answer",
  "run.resume",
  "run.cancel",
  "run.result",
  "artifact.get",
  "doctor",
  "engine.catalogue",
  "parentSession.attach",
  "parentSession.detach",
  "nativeStage.poll",
  "nativeStage.question",
  "nativeStage.submit",
  "nativeStage.status",
  "pipeline.validate",
  "pipeline.run",
  "pipeline.attach",
] as const;

export interface MethodContext {
  readonly signal: AbortSignal;
  readonly authenticatedKeyId?: string;
}

export type MethodHandler = (params: unknown, context: MethodContext) => unknown | Promise<unknown>;

export type MethodRegistry = ReadonlyMap<string, MethodHandler>;

export function createMethodRegistry(
  entries: Iterable<readonly [string, MethodHandler]>,
): MethodRegistry {
  return new Map(entries);
}
