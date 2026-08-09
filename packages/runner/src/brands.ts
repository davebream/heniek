/** Cast helpers for opaque contract brands at runner boundaries. */

import type {
  ArtifactId,
  BackendExecutionId,
  PipelineAttemptId,
  ProfileId,
  RoleId,
  StageId,
  WorkerId,
  WorkspaceId,
} from "@heniek/contracts";

export function asAttemptId(value: string): PipelineAttemptId {
  return value as PipelineAttemptId;
}

export function asWorkspaceId(value: string): WorkspaceId {
  return value as WorkspaceId;
}

export function asStageId(value: string): StageId {
  return value as StageId;
}

export function asArtifactId(value: string): ArtifactId {
  return value as ArtifactId;
}

export function asBackendExecutionId(value: string): BackendExecutionId {
  return value as BackendExecutionId;
}

export function asProfileId(value: string): ProfileId {
  return value as ProfileId;
}

export function asWorkerId(value: string): WorkerId {
  return value as WorkerId;
}

export function asRoleId(value: string): RoleId {
  return value as RoleId;
}
