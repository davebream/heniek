import type {
  ArtifactId,
  BackendArtifactV1,
  BackendExecutionHandleV1,
  ExecutionBackendV5,
  ExecutionEventV3,
  ExecutionRequestV3,
  ExecutionResultV4,
  ExecutionStatus,
  InteractionAnswerSetV1,
  PendingInteractionV2,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import {
  type ClaudexorBackendOptions,
  ClaudexorControlError,
  type ClaudexorExecutionBackend,
  createClaudexorExecutionBackend,
} from "./backend.js";

/**
 * The external Claude route. This adapter deliberately has no API-key or
 * native-Claude configuration: the resolved profile is its complete routing
 * authority and the underlying control client rejects anything else.
 */
interface ProfileExecutionAdapter extends ExecutionBackendV5 {
  diagnoseCompatibility(): ReturnType<ClaudexorExecutionBackend["diagnoseCompatibility"]>;
  diagnoseRuntime(): ReturnType<ClaudexorExecutionBackend["diagnoseRuntime"]>;
  diagnoseAuthRoute(): ReturnType<ClaudexorExecutionBackend["diagnoseAuthRoute"]>;
}

export interface ClaudeProfileExecutionAdapter extends ProfileExecutionAdapter {}

export interface CodexProfileExecutionAdapter extends ProfileExecutionAdapter {}

export interface CursorProfileExecutionAdapter extends ProfileExecutionAdapter {}

type ProfileEngine = "claude" | "codex" | "cursor";

function createProfileExecutionAdapter(
  options: ClaudexorBackendOptions,
  engine: ProfileEngine,
): ProfileExecutionAdapter {
  const backend = createClaudexorExecutionBackend(options);
  return {
    start: async (
      request: Static<typeof ExecutionRequestV3>,
    ): Promise<Static<typeof BackendExecutionHandleV1>> => {
      if (request.profile.engine !== engine) {
        throw new ClaudexorControlError(400, "unsupported_profile", "startProfile");
      }
      return backend.startProfile(request);
    },
    status: (executionId: string): Promise<ExecutionStatus> => backend.status(executionId),
    interactions: (executionId: string): Promise<Static<typeof PendingInteractionV2>[]> =>
      backend.interactions(executionId),
    answer: (executionId: string, answer: Static<typeof InteractionAnswerSetV1>): Promise<void> =>
      backend.answer(executionId, answer),
    resume: (executionId: string, inputArtifactRefs: ArtifactId[]): Promise<void> =>
      backend.resumeProfile(executionId, inputArtifactRefs),
    result: (executionId: string): Promise<Static<typeof ExecutionResultV4>> =>
      backend.resultProfile(executionId),
    cancel: (executionId: string): Promise<void> => backend.cancel(executionId),
    artifacts: (executionId: string): Promise<Static<typeof BackendArtifactV1>[]> =>
      backend.artifacts(executionId),
    readArtifact: (executionId: string, artifactId: string): Promise<Uint8Array> =>
      backend.readArtifact(executionId, artifactId),
    events: (executionId: string, after?: string): AsyncIterable<Static<typeof ExecutionEventV3>> =>
      backend.events(executionId, after),
    diagnoseCompatibility: () => backend.diagnoseCompatibility(),
    diagnoseRuntime: () => backend.diagnoseRuntime(),
    diagnoseAuthRoute: () => {
      switch (engine) {
        case "claude":
          return backend.diagnoseAuthRoute();
        case "codex":
          return backend.diagnoseCodexAuthRoute();
        case "cursor":
          return backend.diagnoseCursorAuthRoute();
      }
    },
  };
}

export function createClaudeProfileExecutionAdapter(
  options: ClaudexorBackendOptions,
): ClaudeProfileExecutionAdapter {
  return createProfileExecutionAdapter(options, "claude");
}

/**
 * Codex runs through Claudexor's native ChatGPT session. Heniek never reads
 * the session material or asks callers to provide a Codex config home.
 */
export function createCodexProfileExecutionAdapter(
  options: ClaudexorBackendOptions,
): CodexProfileExecutionAdapter {
  return createProfileExecutionAdapter(options, "codex");
}

/**
 * Cursor runs through Claudexor's native, keychain-backed Cursor login. Heniek
 * never reads the session material and never names a credential profile:
 * Claudexor treats a cursor credential profile as exactly an API key, so
 * supplying one would move the run onto the metered route that §10.4's billing
 * guard forbids.
 */
export function createCursorProfileExecutionAdapter(
  options: ClaudexorBackendOptions,
): CursorProfileExecutionAdapter {
  return createProfileExecutionAdapter(options, "cursor");
}
