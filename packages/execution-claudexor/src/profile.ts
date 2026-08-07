import type {
  ArtifactId,
  BackendArtifactV1,
  BackendExecutionHandleV1,
  ExecutionBackendV3,
  ExecutionEventV1,
  ExecutionRequestV3,
  ExecutionResultV2,
  ExecutionStatus,
  InteractionAnswerSetV1,
  PendingInteractionV2,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import {
  type ClaudexorBackendOptions,
  type ClaudexorExecutionBackend,
  createClaudexorExecutionBackend,
} from "./backend.js";

/**
 * The external Claude route. This adapter deliberately has no API-key or
 * native-Claude configuration: the resolved profile is its complete routing
 * authority and the underlying control client rejects anything else.
 */
export interface ClaudeProfileExecutionAdapter extends ExecutionBackendV3 {
  diagnoseCompatibility(): ReturnType<ClaudexorExecutionBackend["diagnoseCompatibility"]>;
  diagnoseRuntime(): ReturnType<ClaudexorExecutionBackend["diagnoseRuntime"]>;
  diagnoseAuthRoute(): ReturnType<ClaudexorExecutionBackend["diagnoseAuthRoute"]>;
}

export function createClaudeProfileExecutionAdapter(
  options: ClaudexorBackendOptions,
): ClaudeProfileExecutionAdapter {
  const backend = createClaudexorExecutionBackend(options);
  return {
    start: (
      request: Static<typeof ExecutionRequestV3>,
    ): Promise<Static<typeof BackendExecutionHandleV1>> => backend.startProfile(request),
    status: (executionId: string): Promise<ExecutionStatus> => backend.status(executionId),
    interactions: (executionId: string): Promise<Static<typeof PendingInteractionV2>[]> =>
      backend.interactions(executionId),
    answer: (executionId: string, answer: Static<typeof InteractionAnswerSetV1>): Promise<void> =>
      backend.answer(executionId, answer),
    resume: (executionId: string, inputArtifactRefs: ArtifactId[]): Promise<void> =>
      backend.resumeProfile(executionId, inputArtifactRefs),
    result: (executionId: string): Promise<Static<typeof ExecutionResultV2>> =>
      backend.result(executionId),
    cancel: (executionId: string): Promise<void> => backend.cancel(executionId),
    artifacts: (executionId: string): Promise<Static<typeof BackendArtifactV1>[]> =>
      backend.artifacts(executionId),
    readArtifact: (executionId: string, artifactId: string): Promise<Uint8Array> =>
      backend.readArtifact(executionId, artifactId),
    events: (executionId: string, after?: string): AsyncIterable<Static<typeof ExecutionEventV1>> =>
      backend.events(executionId, after),
    diagnoseCompatibility: () => backend.diagnoseCompatibility(),
    diagnoseRuntime: () => backend.diagnoseRuntime(),
    diagnoseAuthRoute: () => backend.diagnoseAuthRoute(),
  };
}
