import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { ApplicationHome } from "@heniek/config";
import type {
  ArtifactGetResultV1,
  ArtifactId,
  CapabilityCatalogueV1,
  CodebaseDetectionResult,
  CodebaseOnboardApplyResult,
  CodebaseOnboardProposeResult,
  DoctorReportV1,
  DoctorReportV2,
  ExecutionFailureV1,
  ExternalStageResultV1,
  InteractionAnswerSetV1,
  InteractionAnswerSubmissionV2,
  InteractionInboxResultV1,
  NativeStagePollResultV1,
  NativeStagePollResultV2,
  NativeStageQuestionResultV1,
  NativeStageStatusResultV1,
  NativeStageSubmitResultV1,
  ParentSessionAttachmentV1,
  ParentSessionDetachResultV1,
  PendingInteractionV2,
  PipelineAttachRequestV1,
  PipelineAttachResultV1,
  PipelineRunRequestV1,
  PipelineRunResultV1,
  PipelineValidateRequestV1,
  PipelineValidateResultV1,
  RegisteredCodebase,
  StageRunAnswerResultV2,
  StageRunMutationResultV1,
  StageRunResultV1,
  StageRunResultV2,
  StageRunResultV3,
  StageRunResultV4,
  StageRunResumeResultV2,
  StageRunStatusResultV1,
  StageRunStatusResultV2,
  StageRunStatusResultV3,
  StageRunStatusResultV4,
  StageStartResultV1,
  StageStartResultV2,
  StageStartResultV3,
} from "@heniek/contracts";
import {
  ARTIFACT_GET_METHOD,
  ARTIFACT_GET_SCHEMA_ID,
  ARTIFACT_GET_SCHEMA_SHA256,
  ARTIFACT_GET_V1_METHOD,
  buildSignedRequest,
  CAPABILITY_CATALOGUE_SCHEMA_ID,
  CAPABILITY_CATALOGUE_SCHEMA_SHA256,
  CODEBASE_DETECT_METHOD,
  CODEBASE_DETECT_V1_METHOD,
  CODEBASE_DETECTION_SCHEMA_ID,
  CODEBASE_DETECTION_SCHEMA_SHA256,
  CODEBASE_ONBOARD_APPLY_METHOD,
  CODEBASE_ONBOARD_APPLY_RESULT_SCHEMA_ID,
  CODEBASE_ONBOARD_APPLY_RESULT_SCHEMA_SHA256,
  CODEBASE_ONBOARD_APPLY_V1_METHOD,
  CODEBASE_ONBOARD_PROPOSE_METHOD,
  CODEBASE_ONBOARD_PROPOSE_RESULT_SCHEMA_ID,
  CODEBASE_ONBOARD_PROPOSE_RESULT_SCHEMA_SHA256,
  CODEBASE_ONBOARD_PROPOSE_V1_METHOD,
  CODEBASE_REGISTER_METHOD,
  CODEBASE_REGISTER_V1_METHOD,
  credentialFromPersisted,
  DAEMON_HELLO_METHOD,
  DAEMON_NEGOTIATE_METHOD,
  DAEMON_STATUS_SCHEMA_ID,
  DAEMON_STATUS_SCHEMA_SHA256,
  DAEMON_STATUS_V1_METHOD,
  type DaemonCredential,
  DOCTOR_METHOD,
  DOCTOR_SCHEMA_ID,
  DOCTOR_SCHEMA_SHA256,
  DOCTOR_V1_METHOD,
  DOCTOR_V2_METHOD,
  DOCTOR_V2_SCHEMA_ID,
  DOCTOR_V2_SCHEMA_SHA256,
  ENGINE_CATALOGUE_METHOD,
  ENGINE_CATALOGUE_V1_METHOD,
  INBOX_LIST_METHOD,
  INBOX_LIST_SCHEMA_ID,
  INBOX_LIST_SCHEMA_SHA256,
  INBOX_LIST_V1_METHOD,
  JSON_RPC_VERSION,
  MAX_LINE_BYTES,
  NATIVE_STAGE_POLL_METHOD,
  NATIVE_STAGE_POLL_SCHEMA_ID,
  NATIVE_STAGE_POLL_SCHEMA_SHA256,
  NATIVE_STAGE_POLL_V1_METHOD,
  NATIVE_STAGE_POLL_V2_METHOD,
  NATIVE_STAGE_POLL_V2_SCHEMA_ID,
  NATIVE_STAGE_POLL_V2_SCHEMA_SHA256,
  NATIVE_STAGE_QUESTION_METHOD,
  NATIVE_STAGE_QUESTION_SCHEMA_ID,
  NATIVE_STAGE_QUESTION_SCHEMA_SHA256,
  NATIVE_STAGE_QUESTION_V1_METHOD,
  NATIVE_STAGE_STATUS_METHOD,
  NATIVE_STAGE_STATUS_SCHEMA_ID,
  NATIVE_STAGE_STATUS_SCHEMA_SHA256,
  NATIVE_STAGE_STATUS_V1_METHOD,
  NATIVE_STAGE_SUBMIT_METHOD,
  NATIVE_STAGE_SUBMIT_SCHEMA_ID,
  NATIVE_STAGE_SUBMIT_SCHEMA_SHA256,
  NATIVE_STAGE_SUBMIT_V1_METHOD,
  PARENT_SESSION_ATTACH_METHOD,
  PARENT_SESSION_ATTACH_SCHEMA_ID,
  PARENT_SESSION_ATTACH_SCHEMA_SHA256,
  PARENT_SESSION_ATTACH_V1_METHOD,
  PARENT_SESSION_DETACH_METHOD,
  PARENT_SESSION_DETACH_SCHEMA_ID,
  PARENT_SESSION_DETACH_SCHEMA_SHA256,
  PARENT_SESSION_DETACH_V1_METHOD,
  PIPELINE_ATTACH_METHOD,
  PIPELINE_ATTACH_SCHEMA_ID,
  PIPELINE_ATTACH_SCHEMA_SHA256,
  PIPELINE_ATTACH_V1_METHOD,
  PIPELINE_RUN_METHOD,
  PIPELINE_RUN_SCHEMA_ID,
  PIPELINE_RUN_SCHEMA_SHA256,
  PIPELINE_RUN_V1_METHOD,
  PIPELINE_VALIDATE_METHOD,
  PIPELINE_VALIDATE_SCHEMA_ID,
  PIPELINE_VALIDATE_SCHEMA_SHA256,
  PIPELINE_VALIDATE_V1_METHOD,
  REGISTERED_CODEBASE_SCHEMA_ID,
  REGISTERED_CODEBASE_SCHEMA_SHA256,
  RPC_CANCEL_METHOD,
  RUN_ANSWER_METHOD,
  RUN_ANSWER_V1_METHOD,
  RUN_ANSWER_V2_METHOD,
  RUN_ANSWER_V2_SCHEMA_ID,
  RUN_ANSWER_V2_SCHEMA_SHA256,
  RUN_CANCEL_METHOD,
  RUN_CANCEL_V1_METHOD,
  RUN_MUTATION_SCHEMA_ID,
  RUN_MUTATION_SCHEMA_SHA256,
  RUN_RESULT_METHOD,
  RUN_RESULT_SCHEMA_ID,
  RUN_RESULT_SCHEMA_SHA256,
  RUN_RESULT_V1_METHOD,
  RUN_RESULT_V2_METHOD,
  RUN_RESULT_V2_SCHEMA_ID,
  RUN_RESULT_V2_SCHEMA_SHA256,
  RUN_RESULT_V3_METHOD,
  RUN_RESULT_V3_SCHEMA_ID,
  RUN_RESULT_V3_SCHEMA_SHA256,
  RUN_RESULT_V4_METHOD,
  RUN_RESULT_V4_SCHEMA_ID,
  RUN_RESULT_V4_SCHEMA_SHA256,
  RUN_RESUME_METHOD,
  RUN_RESUME_V1_METHOD,
  RUN_RESUME_V2_METHOD,
  RUN_RESUME_V2_SCHEMA_ID,
  RUN_RESUME_V2_SCHEMA_SHA256,
  RUN_STATUS_METHOD,
  RUN_STATUS_SCHEMA_ID,
  RUN_STATUS_SCHEMA_SHA256,
  RUN_STATUS_V1_METHOD,
  RUN_STATUS_V2_METHOD,
  RUN_STATUS_V2_SCHEMA_ID,
  RUN_STATUS_V2_SCHEMA_SHA256,
  RUN_STATUS_V3_METHOD,
  RUN_STATUS_V3_SCHEMA_ID,
  RUN_STATUS_V3_SCHEMA_SHA256,
  RUN_STATUS_V4_METHOD,
  RUN_STATUS_V4_SCHEMA_ID,
  RUN_STATUS_V4_SCHEMA_SHA256,
  STAGE_START_METHOD,
  STAGE_START_SCHEMA_ID,
  STAGE_START_SCHEMA_SHA256,
  STAGE_START_V1_METHOD,
  STAGE_START_V2_METHOD,
  STAGE_START_V2_SCHEMA_ID,
  STAGE_START_V2_SCHEMA_SHA256,
  STAGE_START_V3_METHOD,
  STAGE_START_V3_SCHEMA_ID,
  STAGE_START_V3_SCHEMA_SHA256,
  STAGE_START_V4_METHOD,
  TRANSPORT_VERSION,
  zeroCredential,
} from "@heniek/protocol";
import { createFileSecretStore } from "@heniek/secrets";
import type { Static } from "@sinclair/typebox";

export type ClientFailureCode =
  | "DAEMON_UNAVAILABLE"
  | "AUTHENTICATION_FAILED"
  | "INCOMPATIBLE_PROTOCOL"
  | "REQUEST_CANCELLED"
  | "RPC_FAILURE";

export class HeniekClientError extends Error {
  constructor(
    readonly code: ClientFailureCode,
    message: string,
    readonly retryable: boolean,
    readonly observed?: { readonly daemonVersion?: number; readonly schemaCompatibility?: string },
  ) {
    super(message);
    this.name = "HeniekClientError";
  }
}

export interface DaemonStatus {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly lifecycleState: string;
  readonly startedAt: string;
  readonly reconciliation: Readonly<
    Record<"probed" | "resumable" | "failed" | "cancelled" | "unknown", number>
  >;
  readonly artifactRecovery: Readonly<
    Record<"removedIncoming" | "skippedIncoming" | "unreferencedBlobs", number>
  >;
}

export interface StatusSnapshot {
  readonly status: DaemonStatus;
  readonly daemonVersion: number;
  readonly daemonManifestVersion: string;
  readonly schemaCompatibility: "exact" | "incompatible";
}

export type {
  CodebaseDetectionResult,
  CodebaseOnboardApplyResult,
  CodebaseOnboardProposeResult,
  RegisteredCodebase,
} from "@heniek/contracts";

interface RpcRequirement {
  readonly name: string;
  readonly methodVersion?: number;
  readonly wireMethod: string;
  readonly schemaId: string;
  readonly sha256: string;
}

interface HelloResult {
  readonly protocolVersion: number;
  readonly challenge: string;
  readonly keyId: string;
}

interface Response {
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseResult(response: Response): unknown {
  if (response.error !== undefined) {
    const code = response.error.code;
    if (code === -32001) {
      throw new HeniekClientError(
        "AUTHENTICATION_FAILED",
        "Heniek daemon authentication failed.",
        false,
      );
    }
    if (code === -32002) {
      throw new HeniekClientError("REQUEST_CANCELLED", "Heniek status was cancelled.", false);
    }
    if (code === -32003) {
      throw new HeniekClientError(
        "INCOMPATIBLE_PROTOCOL",
        "Heniek daemon protocol is incompatible.",
        false,
      );
    }
    throw new HeniekClientError("RPC_FAILURE", "The Heniek daemon rejected the request.", false);
  }
  if (response.result === undefined) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned a malformed response.",
      false,
    );
  }
  return response.result;
}

function parseHello(value: unknown): HelloResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "challenge",
      "instanceId",
      "keyId",
      "macAlgorithm",
      "protocolVersion",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.protocolVersion !== "number" ||
    typeof value.instanceId !== "string" ||
    value.macAlgorithm !== "hmac-sha256"
  ) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid hello response.",
      false,
    );
  }
  if (typeof value.challenge !== "string" || !/^[a-f0-9]{64}$/.test(value.challenge)) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid hello response.",
      false,
    );
  }
  if (typeof value.keyId !== "string" || value.keyId.length === 0) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid hello response.",
      false,
    );
  }
  return { protocolVersion: value.protocolVersion, challenge: value.challenge, keyId: value.keyId };
}

function parseNegotiation(
  value: unknown,
  requirement: RpcRequirement,
): { readonly manifestVersion: string } {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "compatibility",
      "contractManifestVersion",
      "methods",
      "reasons",
      "schemaVersion",
      "selectedTransportVersion",
    ]) ||
    value.schemaVersion !== 1 ||
    value.compatibility !== "compatible" ||
    value.selectedTransportVersion !== TRANSPORT_VERSION ||
    typeof value.contractManifestVersion !== "string" ||
    !Array.isArray(value.methods) ||
    !Array.isArray(value.reasons)
  ) {
    throw new HeniekClientError(
      "INCOMPATIBLE_PROTOCOL",
      "Heniek daemon protocol is incompatible.",
      false,
      { schemaCompatibility: "incompatible" },
    );
  }
  const negotiated = value.methods.find(
    (method) =>
      isRecord(method) &&
      hasExactKeys(method, [
        "methodVersion",
        "name",
        "resultSchemaId",
        "resultSchemaSha256",
        "wireMethod",
      ]) &&
      method.name === requirement.name &&
      method.methodVersion === (requirement.methodVersion ?? 1) &&
      method.wireMethod === requirement.wireMethod &&
      method.resultSchemaId === requirement.schemaId &&
      method.resultSchemaSha256 === requirement.sha256,
  );
  if (negotiated === undefined) {
    throw new HeniekClientError(
      "INCOMPATIBLE_PROTOCOL",
      "Heniek daemon protocol is incompatible.",
      false,
      { schemaCompatibility: "incompatible" },
    );
  }
  return { manifestVersion: value.contractManifestVersion };
}

function parseStatus(value: unknown): DaemonStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "artifactRecovery",
      "instanceId",
      "lifecycleState",
      "reconciliation",
      "schemaVersion",
      "startedAt",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.instanceId !== "string"
  ) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid status response.",
      false,
    );
  }
  if (typeof value.lifecycleState !== "string" || typeof value.startedAt !== "string") {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid status response.",
      false,
    );
  }
  const reconciliation = value.reconciliation;
  const artifactRecovery = value.artifactRecovery;
  const reconciliationKeys = ["probed", "resumable", "failed", "cancelled", "unknown"] as const;
  const artifactKeys = ["removedIncoming", "skippedIncoming", "unreferencedBlobs"] as const;
  if (
    !isRecord(reconciliation) ||
    !isRecord(artifactRecovery) ||
    !hasExactKeys(reconciliation, [...reconciliationKeys]) ||
    !hasExactKeys(artifactRecovery, [...artifactKeys]) ||
    !reconciliationKeys.every((key) => typeof reconciliation[key] === "number") ||
    !artifactKeys.every((key) => typeof artifactRecovery[key] === "number")
  ) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid status response.",
      false,
    );
  }
  return value as unknown as DaemonStatus;
}

const STATUS_REQUIREMENT: RpcRequirement = {
  name: "daemon.status",
  wireMethod: DAEMON_STATUS_V1_METHOD,
  schemaId: DAEMON_STATUS_SCHEMA_ID,
  sha256: DAEMON_STATUS_SCHEMA_SHA256,
};

const DETECT_REQUIREMENT: RpcRequirement = {
  name: CODEBASE_DETECT_METHOD,
  wireMethod: CODEBASE_DETECT_V1_METHOD,
  schemaId: CODEBASE_DETECTION_SCHEMA_ID,
  sha256: CODEBASE_DETECTION_SCHEMA_SHA256,
};

const REGISTER_REQUIREMENT: RpcRequirement = {
  name: CODEBASE_REGISTER_METHOD,
  wireMethod: CODEBASE_REGISTER_V1_METHOD,
  schemaId: REGISTERED_CODEBASE_SCHEMA_ID,
  sha256: REGISTERED_CODEBASE_SCHEMA_SHA256,
};

const ONBOARD_PROPOSE_REQUIREMENT: RpcRequirement = {
  name: CODEBASE_ONBOARD_PROPOSE_METHOD,
  wireMethod: CODEBASE_ONBOARD_PROPOSE_V1_METHOD,
  schemaId: CODEBASE_ONBOARD_PROPOSE_RESULT_SCHEMA_ID,
  sha256: CODEBASE_ONBOARD_PROPOSE_RESULT_SCHEMA_SHA256,
};

const ONBOARD_APPLY_REQUIREMENT: RpcRequirement = {
  name: CODEBASE_ONBOARD_APPLY_METHOD,
  wireMethod: CODEBASE_ONBOARD_APPLY_V1_METHOD,
  schemaId: CODEBASE_ONBOARD_APPLY_RESULT_SCHEMA_ID,
  sha256: CODEBASE_ONBOARD_APPLY_RESULT_SCHEMA_SHA256,
};

const STAGE_START_REQUIREMENT: RpcRequirement = {
  name: STAGE_START_METHOD,
  wireMethod: STAGE_START_V1_METHOD,
  schemaId: STAGE_START_SCHEMA_ID,
  sha256: STAGE_START_SCHEMA_SHA256,
};

const STAGE_START_V2_REQUIREMENT: RpcRequirement = {
  name: STAGE_START_METHOD,
  methodVersion: 2,
  wireMethod: STAGE_START_V2_METHOD,
  schemaId: STAGE_START_V2_SCHEMA_ID,
  sha256: STAGE_START_V2_SCHEMA_SHA256,
};

const STAGE_START_V3_REQUIREMENT: RpcRequirement = {
  name: STAGE_START_METHOD,
  methodVersion: 3,
  wireMethod: STAGE_START_V3_METHOD,
  schemaId: STAGE_START_V3_SCHEMA_ID,
  sha256: STAGE_START_V3_SCHEMA_SHA256,
};

const STAGE_START_V4_REQUIREMENT: RpcRequirement = {
  name: STAGE_START_METHOD,
  methodVersion: 4,
  wireMethod: STAGE_START_V4_METHOD,
  schemaId: STAGE_START_V3_SCHEMA_ID,
  sha256: STAGE_START_V3_SCHEMA_SHA256,
};

const RUN_STATUS_REQUIREMENT: RpcRequirement = {
  name: RUN_STATUS_METHOD,
  wireMethod: RUN_STATUS_V1_METHOD,
  schemaId: RUN_STATUS_SCHEMA_ID,
  sha256: RUN_STATUS_SCHEMA_SHA256,
};

const RUN_STATUS_V2_REQUIREMENT: RpcRequirement = {
  name: RUN_STATUS_METHOD,
  methodVersion: 2,
  wireMethod: RUN_STATUS_V2_METHOD,
  schemaId: RUN_STATUS_V2_SCHEMA_ID,
  sha256: RUN_STATUS_V2_SCHEMA_SHA256,
};

const RUN_STATUS_V3_REQUIREMENT: RpcRequirement = {
  name: RUN_STATUS_METHOD,
  methodVersion: 3,
  wireMethod: RUN_STATUS_V3_METHOD,
  schemaId: RUN_STATUS_V3_SCHEMA_ID,
  sha256: RUN_STATUS_V3_SCHEMA_SHA256,
};

const RUN_STATUS_V4_REQUIREMENT: RpcRequirement = {
  name: RUN_STATUS_METHOD,
  methodVersion: 4,
  wireMethod: RUN_STATUS_V4_METHOD,
  schemaId: RUN_STATUS_V4_SCHEMA_ID,
  sha256: RUN_STATUS_V4_SCHEMA_SHA256,
};

const INBOX_LIST_REQUIREMENT: RpcRequirement = {
  name: INBOX_LIST_METHOD,
  wireMethod: INBOX_LIST_V1_METHOD,
  schemaId: INBOX_LIST_SCHEMA_ID,
  sha256: INBOX_LIST_SCHEMA_SHA256,
};

const RUN_ANSWER_V2_REQUIREMENT: RpcRequirement = {
  name: RUN_ANSWER_METHOD,
  methodVersion: 2,
  wireMethod: RUN_ANSWER_V2_METHOD,
  schemaId: RUN_ANSWER_V2_SCHEMA_ID,
  sha256: RUN_ANSWER_V2_SCHEMA_SHA256,
};

const RUN_RESUME_V2_REQUIREMENT: RpcRequirement = {
  name: RUN_RESUME_METHOD,
  methodVersion: 2,
  wireMethod: RUN_RESUME_V2_METHOD,
  schemaId: RUN_RESUME_V2_SCHEMA_ID,
  sha256: RUN_RESUME_V2_SCHEMA_SHA256,
};

function mutationRequirement(name: string, wireMethod: string): RpcRequirement {
  return {
    name,
    wireMethod,
    schemaId: RUN_MUTATION_SCHEMA_ID,
    sha256: RUN_MUTATION_SCHEMA_SHA256,
  };
}

const RUN_RESULT_REQUIREMENT: RpcRequirement = {
  name: RUN_RESULT_METHOD,
  wireMethod: RUN_RESULT_V1_METHOD,
  schemaId: RUN_RESULT_SCHEMA_ID,
  sha256: RUN_RESULT_SCHEMA_SHA256,
};

const RUN_RESULT_V2_REQUIREMENT: RpcRequirement = {
  name: RUN_RESULT_METHOD,
  methodVersion: 2,
  wireMethod: RUN_RESULT_V2_METHOD,
  schemaId: RUN_RESULT_V2_SCHEMA_ID,
  sha256: RUN_RESULT_V2_SCHEMA_SHA256,
};

const RUN_RESULT_V3_REQUIREMENT: RpcRequirement = {
  name: RUN_RESULT_METHOD,
  methodVersion: 3,
  wireMethod: RUN_RESULT_V3_METHOD,
  schemaId: RUN_RESULT_V3_SCHEMA_ID,
  sha256: RUN_RESULT_V3_SCHEMA_SHA256,
};

const RUN_RESULT_V4_REQUIREMENT: RpcRequirement = {
  name: RUN_RESULT_METHOD,
  methodVersion: 4,
  wireMethod: RUN_RESULT_V4_METHOD,
  schemaId: RUN_RESULT_V4_SCHEMA_ID,
  sha256: RUN_RESULT_V4_SCHEMA_SHA256,
};

/**
 * Q023's native bridge — the surface the Claude Code plugin (Q050) will
 * drive. `parentSession.*` requirements have no `methodVersion` entry
 * because there is only ever one version of each so far, matching every
 * other single-version requirement above (the field defaults to `1`).
 */
const PARENT_SESSION_ATTACH_REQUIREMENT: RpcRequirement = {
  name: PARENT_SESSION_ATTACH_METHOD,
  wireMethod: PARENT_SESSION_ATTACH_V1_METHOD,
  schemaId: PARENT_SESSION_ATTACH_SCHEMA_ID,
  sha256: PARENT_SESSION_ATTACH_SCHEMA_SHA256,
};

const PARENT_SESSION_DETACH_REQUIREMENT: RpcRequirement = {
  name: PARENT_SESSION_DETACH_METHOD,
  wireMethod: PARENT_SESSION_DETACH_V1_METHOD,
  schemaId: PARENT_SESSION_DETACH_SCHEMA_ID,
  sha256: PARENT_SESSION_DETACH_SCHEMA_SHA256,
};

const NATIVE_STAGE_POLL_REQUIREMENT: RpcRequirement = {
  name: NATIVE_STAGE_POLL_METHOD,
  wireMethod: NATIVE_STAGE_POLL_V1_METHOD,
  schemaId: NATIVE_STAGE_POLL_SCHEMA_ID,
  sha256: NATIVE_STAGE_POLL_SCHEMA_SHA256,
};

const NATIVE_STAGE_POLL_V2_REQUIREMENT: RpcRequirement = {
  name: NATIVE_STAGE_POLL_METHOD,
  methodVersion: 2,
  wireMethod: NATIVE_STAGE_POLL_V2_METHOD,
  schemaId: NATIVE_STAGE_POLL_V2_SCHEMA_ID,
  sha256: NATIVE_STAGE_POLL_V2_SCHEMA_SHA256,
};

const NATIVE_STAGE_QUESTION_REQUIREMENT: RpcRequirement = {
  name: NATIVE_STAGE_QUESTION_METHOD,
  wireMethod: NATIVE_STAGE_QUESTION_V1_METHOD,
  schemaId: NATIVE_STAGE_QUESTION_SCHEMA_ID,
  sha256: NATIVE_STAGE_QUESTION_SCHEMA_SHA256,
};

const NATIVE_STAGE_SUBMIT_REQUIREMENT: RpcRequirement = {
  name: NATIVE_STAGE_SUBMIT_METHOD,
  wireMethod: NATIVE_STAGE_SUBMIT_V1_METHOD,
  schemaId: NATIVE_STAGE_SUBMIT_SCHEMA_ID,
  sha256: NATIVE_STAGE_SUBMIT_SCHEMA_SHA256,
};

const NATIVE_STAGE_STATUS_REQUIREMENT: RpcRequirement = {
  name: NATIVE_STAGE_STATUS_METHOD,
  wireMethod: NATIVE_STAGE_STATUS_V1_METHOD,
  schemaId: NATIVE_STAGE_STATUS_SCHEMA_ID,
  sha256: NATIVE_STAGE_STATUS_SCHEMA_SHA256,
};

const ARTIFACT_GET_REQUIREMENT: RpcRequirement = {
  name: ARTIFACT_GET_METHOD,
  wireMethod: ARTIFACT_GET_V1_METHOD,
  schemaId: ARTIFACT_GET_SCHEMA_ID,
  sha256: ARTIFACT_GET_SCHEMA_SHA256,
};

const DOCTOR_REQUIREMENT: RpcRequirement = {
  name: DOCTOR_METHOD,
  wireMethod: DOCTOR_V1_METHOD,
  schemaId: DOCTOR_SCHEMA_ID,
  sha256: DOCTOR_SCHEMA_SHA256,
};

const DOCTOR_V2_REQUIREMENT: RpcRequirement = {
  name: DOCTOR_METHOD,
  methodVersion: 2,
  wireMethod: DOCTOR_V2_METHOD,
  schemaId: DOCTOR_V2_SCHEMA_ID,
  sha256: DOCTOR_V2_SCHEMA_SHA256,
};

const ENGINE_CATALOGUE_REQUIREMENT: RpcRequirement = {
  name: ENGINE_CATALOGUE_METHOD,
  wireMethod: ENGINE_CATALOGUE_V1_METHOD,
  schemaId: CAPABILITY_CATALOGUE_SCHEMA_ID,
  sha256: CAPABILITY_CATALOGUE_SCHEMA_SHA256,
};

const PIPELINE_VALIDATE_REQUIREMENT: RpcRequirement = {
  name: PIPELINE_VALIDATE_METHOD,
  wireMethod: PIPELINE_VALIDATE_V1_METHOD,
  schemaId: PIPELINE_VALIDATE_SCHEMA_ID,
  sha256: PIPELINE_VALIDATE_SCHEMA_SHA256,
};

const PIPELINE_RUN_REQUIREMENT: RpcRequirement = {
  name: PIPELINE_RUN_METHOD,
  wireMethod: PIPELINE_RUN_V1_METHOD,
  schemaId: PIPELINE_RUN_SCHEMA_ID,
  sha256: PIPELINE_RUN_SCHEMA_SHA256,
};

const PIPELINE_ATTACH_REQUIREMENT: RpcRequirement = {
  name: PIPELINE_ATTACH_METHOD,
  wireMethod: PIPELINE_ATTACH_V1_METHOD,
  schemaId: PIPELINE_ATTACH_SCHEMA_ID,
  sha256: PIPELINE_ATTACH_SCHEMA_SHA256,
};

function parseVersioned<T>(value: unknown, description: string, expectedVersion = 1): T {
  if (!isRecord(value) || value.schemaVersion !== expectedVersion) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      `The Heniek daemon returned an invalid ${description} response.`,
      false,
    );
  }
  return value as T;
}

function parseDetection(value: unknown): CodebaseDetectionResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "codebaseId",
      "diagnostics",
      "instructionSnapshot",
      "name",
      "registrationState",
      "repositories",
      "rootPath",
      "schemaVersion",
      "sourceRepositoryPath",
      "topologySha256",
    ]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.repositories) ||
    !Array.isArray(value.diagnostics) ||
    !isRecord(value.instructionSnapshot) ||
    typeof value.name !== "string" ||
    typeof value.rootPath !== "string" ||
    typeof value.topologySha256 !== "string"
  ) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid Codebase detection response.",
      false,
    );
  }
  return value as unknown as CodebaseDetectionResult;
}

function parseRegistration(value: unknown): RegisteredCodebase {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "codebaseId",
      "configurationSha256",
      "diagnostics",
      "instructionSnapshot",
      "name",
      "readiness",
      "registeredAt",
      "repositories",
      "rootPath",
      "schemaVersion",
      "sourceRepositoryPath",
      "topologySha256",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.codebaseId !== "string" ||
    !Array.isArray(value.repositories) ||
    !Array.isArray(value.diagnostics) ||
    !isRecord(value.instructionSnapshot) ||
    typeof value.configurationSha256 !== "string"
  ) {
    throw new HeniekClientError(
      "RPC_FAILURE",
      "The Heniek daemon returned an invalid Codebase registration response.",
      false,
    );
  }
  return value as unknown as RegisteredCodebase;
}

class LineClient {
  #buffer = "";
  #closed = false;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (response: Response) => void; reject: (error: Error) => void }
  >();

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.rejectAll());
    socket.on("close", () => {
      this.#closed = true;
      this.rejectAll();
    });
  }

  static connect(path: string): Promise<LineClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path });
      const onError = () =>
        reject(
          new HeniekClientError("DAEMON_UNAVAILABLE", "Heniek daemon is not reachable.", true),
        );
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve(new LineClient(socket));
      });
    });
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    credential?: DaemonCredential,
    challenge?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.#nextId++;
    if (this.#closed) {
      throw new HeniekClientError("DAEMON_UNAVAILABLE", "Heniek daemon is not reachable.", true);
    }
    if (signal?.aborted) {
      throw new HeniekClientError("REQUEST_CANCELLED", "Heniek status was cancelled.", false);
    }
    const line =
      credential === undefined || challenge === undefined
        ? JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method })
        : buildSignedRequest(credential, challenge, id, method, id - 1, params);
    return new Promise<unknown>((resolve, reject) => {
      const cancel = () => {
        this.#pending.delete(id);
        if (credential !== undefined && challenge !== undefined) {
          void this.request(
            RPC_CANCEL_METHOD,
            { schemaVersion: 1, requestId: id },
            credential,
            challenge,
          ).catch(() => undefined);
        }
        reject(new HeniekClientError("REQUEST_CANCELLED", "Heniek status was cancelled.", false));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.#pending.set(id, {
        resolve: (response) => {
          signal?.removeEventListener("abort", cancel);
          resolve(responseResult(response));
        },
        reject: (error) => {
          signal?.removeEventListener("abort", cancel);
          reject(error);
        },
      });
      this.socket.write(`${line}\n`, (error) => {
        if (error !== undefined && error !== null) {
          this.#pending.delete(id);
          signal?.removeEventListener("abort", cancel);
          reject(
            new HeniekClientError("DAEMON_UNAVAILABLE", "Heniek daemon is not reachable.", true),
          );
        }
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_LINE_BYTES) {
      this.close();
      this.rejectAll(
        new HeniekClientError(
          "RPC_FAILURE",
          "The Heniek daemon sent an oversized response.",
          false,
        ),
      );
      return;
    }
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.close();
        this.rejectAll(
          new HeniekClientError(
            "RPC_FAILURE",
            "The Heniek daemon sent a malformed response.",
            false,
          ),
        );
        return;
      }
      if (
        !isRecord(value) ||
        value.jsonrpc !== JSON_RPC_VERSION ||
        (typeof value.id !== "number" && typeof value.id !== "string" && value.id !== null)
      ) {
        this.close();
        this.rejectAll(
          new HeniekClientError(
            "RPC_FAILURE",
            "The Heniek daemon sent a malformed response.",
            false,
          ),
        );
        return;
      }
      const response = value as unknown as Response;
      if (typeof response.id !== "number") {
        continue;
      }
      const pending = this.#pending.get(response.id);
      if (pending !== undefined) {
        this.#pending.delete(response.id);
        pending.resolve(response);
      }
    }
  }

  private rejectAll(
    error = new HeniekClientError("DAEMON_UNAVAILABLE", "Heniek daemon is not reachable.", true),
  ): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

async function readCredential(home: ApplicationHome): Promise<DaemonCredential> {
  const store = createFileSecretStore({ directory: home.paths.secretsDirectory });
  const value = await store.read("daemon.local-control");
  const credential = value === undefined ? undefined : credentialFromPersisted(value.expose());
  if (credential === undefined) {
    throw new HeniekClientError(
      "AUTHENTICATION_FAILED",
      "Heniek daemon credentials are unavailable.",
      true,
    );
  }
  return credential;
}

async function authenticatedOnce<T>(
  home: ApplicationHome,
  requirement: RpcRequirement,
  params: Record<string, unknown>,
  parse: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<{
  readonly result: T;
  readonly daemonVersion: number;
  readonly daemonManifestVersion: string;
}> {
  const client = await LineClient.connect(home.paths.daemonSocketFile);
  let credential: DaemonCredential | undefined;
  try {
    const hello = parseHello(await client.request(DAEMON_HELLO_METHOD));
    if (hello.protocolVersion !== TRANSPORT_VERSION) {
      throw new HeniekClientError(
        "INCOMPATIBLE_PROTOCOL",
        "Heniek daemon protocol is incompatible.",
        false,
        { daemonVersion: hello.protocolVersion },
      );
    }
    credential = await readCredential(home);
    if (credential.keyId !== hello.keyId) {
      throw new HeniekClientError(
        "AUTHENTICATION_FAILED",
        "Heniek daemon restarted during authentication.",
        true,
      );
    }
    const challenge = new Uint8Array(Buffer.from(hello.challenge, "hex"));
    const negotiation = parseNegotiation(
      await client.request(
        DAEMON_NEGOTIATE_METHOD,
        {
          schemaVersion: 1,
          transportVersions: [TRANSPORT_VERSION],
          requiredMethods: [
            {
              name: requirement.name,
              methodVersions: [requirement.methodVersion ?? 1],
              resultSchemas: [{ schemaId: requirement.schemaId, sha256: requirement.sha256 }],
            },
          ],
        },
        credential,
        challenge,
      ),
      requirement,
    );
    return {
      result: parse(
        await client.request(requirement.wireMethod, params, credential, challenge, signal),
      ),
      daemonVersion: hello.protocolVersion,
      daemonManifestVersion: negotiation.manifestVersion,
    };
  } finally {
    if (credential !== undefined) {
      zeroCredential(credential);
    }
    client.close();
  }
}

async function once(home: ApplicationHome, signal?: AbortSignal): Promise<StatusSnapshot> {
  const snapshot = await authenticatedOnce(home, STATUS_REQUIREMENT, {}, parseStatus, signal);
  return {
    status: snapshot.result,
    daemonVersion: snapshot.daemonVersion,
    daemonManifestVersion: snapshot.daemonManifestVersion,
    schemaCompatibility: "exact",
  };
}

export async function fetchDaemonStatus(
  home: ApplicationHome,
  options: { readonly signal?: AbortSignal } = {},
): Promise<StatusSnapshot> {
  try {
    return await once(home, options.signal);
  } catch (error) {
    if (
      error instanceof HeniekClientError &&
      error.code === "AUTHENTICATION_FAILED" &&
      error.retryable
    ) {
      return once(home, options.signal);
    }
    throw error;
  }
}

async function retryAuthentication<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof HeniekClientError &&
      error.code === "AUTHENTICATION_FAILED" &&
      error.retryable
    ) {
      return operation();
    }
    throw error;
  }
}

export async function detectCodebaseViaDaemon(
  home: ApplicationHome,
  roots: readonly string[],
  options: {
    readonly sourceRepositoryPath?: string | null;
    readonly signal?: AbortSignal;
  } = {},
): Promise<CodebaseDetectionResult> {
  return retryAuthentication(async () => {
    const response = await authenticatedOnce(
      home,
      DETECT_REQUIREMENT,
      {
        schemaVersion: 1,
        roots: [...roots],
        sourceRepositoryPath: options.sourceRepositoryPath ?? null,
      },
      parseDetection,
      options.signal,
    );
    return response.result;
  });
}

export async function registerCodebaseViaDaemon(
  home: ApplicationHome,
  input: {
    readonly roots: readonly string[];
    readonly expectedTopologySha256: string;
    readonly sourceRepositoryPath?: string | null;
  },
  options: { readonly signal?: AbortSignal } = {},
): Promise<RegisteredCodebase> {
  return retryAuthentication(async () => {
    const response = await authenticatedOnce(
      home,
      REGISTER_REQUIREMENT,
      {
        schemaVersion: 1,
        roots: [...input.roots],
        sourceRepositoryPath: input.sourceRepositoryPath ?? null,
        expectedTopologySha256: input.expectedTopologySha256,
        confirmed: true,
      },
      parseRegistration,
      options.signal,
    );
    return response.result;
  });
}

export async function proposeCodebaseOnboardingViaDaemon(
  home: ApplicationHome,
  input: {
    readonly codebaseId: string;
    readonly profileId?: string | null;
  },
  options: { readonly signal?: AbortSignal } = {},
): Promise<CodebaseOnboardProposeResult> {
  return domainCall(
    home,
    ONBOARD_PROPOSE_REQUIREMENT,
    {
      schemaVersion: 1,
      codebaseId: input.codebaseId,
      profileId: input.profileId ?? null,
    },
    "Codebase onboarding proposal",
    options.signal,
  );
}

export async function applyCodebaseOnboardingViaDaemon(
  home: ApplicationHome,
  input: {
    readonly proposalId: string;
    readonly expectedSha256: string;
  },
  options: { readonly signal?: AbortSignal } = {},
): Promise<CodebaseOnboardApplyResult> {
  return domainCall(
    home,
    ONBOARD_APPLY_REQUIREMENT,
    {
      schemaVersion: 1,
      proposalId: input.proposalId,
      expectedSha256: input.expectedSha256,
    },
    "Codebase onboarding apply",
    options.signal,
  );
}

async function domainCall<T>(
  home: ApplicationHome,
  requirement: RpcRequirement,
  params: Record<string, unknown>,
  description: string,
  signal?: AbortSignal,
): Promise<T> {
  return retryAuthentication(async () => {
    const response = await authenticatedOnce(
      home,
      requirement,
      params,
      (value) => parseVersioned<T>(value, description, requirement.methodVersion ?? 1),
      signal,
    );
    return response.result;
  });
}

export function startStageViaDaemon(
  home: ApplicationHome,
  input: {
    readonly currentDirectory: string;
    readonly prompt: string;
    readonly artifactPath: string;
    readonly limits?: { readonly maxDurationMs?: number; readonly maxTurns?: number };
    readonly signal?: AbortSignal;
  },
): Promise<Static<typeof StageStartResultV1>> {
  return domainCall(
    home,
    STAGE_START_REQUIREMENT,
    {
      currentDirectory: input.currentDirectory,
      prompt: input.prompt,
      artifactPath: input.artifactPath,
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    },
    "stage start",
    input.signal,
  );
}

export function startStageV2ViaDaemon(
  home: ApplicationHome,
  input: {
    readonly currentDirectory: string;
    readonly prompt: string;
    readonly artifactPath: string;
    readonly profileId: string;
    readonly priority?: number;
    readonly requestedIdentifiers?: readonly string[];
    readonly limits?: { readonly maxDurationMs?: number; readonly maxTurns?: number };
    readonly signal?: AbortSignal;
  },
): Promise<Static<typeof StageStartResultV2>> {
  return domainCall(
    home,
    STAGE_START_V2_REQUIREMENT,
    {
      currentDirectory: input.currentDirectory,
      prompt: input.prompt,
      artifactPath: input.artifactPath,
      profileId: input.profileId,
      priority: input.priority ?? 0,
      requestedIdentifiers: [...(input.requestedIdentifiers ?? [])],
      limits: input.limits ?? {},
    },
    "stage start",
    input.signal,
  );
}

/**
 * Q023's one admission door: routes to native or scheduled execution by the
 * resolved profile's `executionMode`, reported back in `executionMode` so a
 * caller never has to pre-decide which mode a profile uses.
 */
export function startStageV3ViaDaemon(
  home: ApplicationHome,
  input: {
    readonly currentDirectory: string;
    readonly prompt: string;
    readonly artifactPath: string;
    readonly profileId: string;
    readonly priority?: number;
    readonly requestedIdentifiers?: readonly string[];
    readonly limits?: { readonly maxDurationMs?: number; readonly maxTurns?: number };
    readonly signal?: AbortSignal;
  },
): Promise<Static<typeof StageStartResultV3>> {
  return domainCall(
    home,
    STAGE_START_V3_REQUIREMENT,
    {
      currentDirectory: input.currentDirectory,
      prompt: input.prompt,
      artifactPath: input.artifactPath,
      profileId: input.profileId,
      priority: input.priority ?? 0,
      requestedIdentifiers: [...(input.requestedIdentifiers ?? [])],
      limits: input.limits ?? {},
    },
    "stage start v3",
    input.signal,
  );
}

/**
 * Capability-aware admission: same result shape as v3, but the request may
 * carry typed invocation overrides and preferred/required feature-tool pins.
 */
export function startStageV4ViaDaemon(
  home: ApplicationHome,
  input: {
    readonly currentDirectory: string;
    readonly prompt: string;
    readonly artifactPath: string;
    readonly profileId: string;
    readonly priority?: number;
    readonly requestedIdentifiers?: readonly string[];
    readonly limits?: { readonly maxDurationMs?: number; readonly maxTurns?: number };
    readonly invocationOverrides?: {
      readonly engine?: "claude-code" | "codex";
      readonly account?: string;
      readonly billing?: "subscription";
      readonly model?: string;
      readonly effort?: string;
      readonly executor?: "external" | "native";
      readonly focus?: string;
      readonly max_duration?: string;
      readonly workspace_strategy?: string;
    };
    readonly preferredFeatures?: readonly string[];
    readonly preferredTools?: readonly string[];
    readonly requiredFeatures?: readonly string[];
    readonly requiredTools?: readonly string[];
    readonly signal?: AbortSignal;
  },
): Promise<Static<typeof StageStartResultV3>> {
  return domainCall(
    home,
    STAGE_START_V4_REQUIREMENT,
    {
      schemaVersion: 3,
      currentDirectory: input.currentDirectory,
      prompt: input.prompt,
      artifactPath: input.artifactPath,
      profileId: input.profileId,
      priority: input.priority ?? 0,
      requestedIdentifiers: [...(input.requestedIdentifiers ?? [])],
      limits: input.limits ?? {},
      ...(input.invocationOverrides === undefined
        ? {}
        : { invocationOverrides: input.invocationOverrides }),
      ...(input.preferredFeatures === undefined
        ? {}
        : { preferredFeatures: [...input.preferredFeatures] }),
      ...(input.preferredTools === undefined ? {} : { preferredTools: [...input.preferredTools] }),
      ...(input.requiredFeatures === undefined
        ? {}
        : { requiredFeatures: [...input.requiredFeatures] }),
      ...(input.requiredTools === undefined ? {} : { requiredTools: [...input.requiredTools] }),
    },
    "stage start v4",
    input.signal,
  );
}

export function fetchRunStatusViaDaemon(
  home: ApplicationHome,
  runId: string,
  signal?: AbortSignal,
): Promise<Static<typeof StageRunStatusResultV1>> {
  return domainCall(home, RUN_STATUS_REQUIREMENT, { runId }, "run status", signal);
}

export function fetchRunStatusV2ViaDaemon(
  home: ApplicationHome,
  runId: string,
  signal?: AbortSignal,
): Promise<Static<typeof StageRunStatusResultV2>> {
  return domainCall(home, RUN_STATUS_V2_REQUIREMENT, { runId }, "run status v2", signal);
}

export function fetchRunStatusV3ViaDaemon(
  home: ApplicationHome,
  runId: string,
  signal?: AbortSignal,
): Promise<Static<typeof StageRunStatusResultV3>> {
  return domainCall(home, RUN_STATUS_V3_REQUIREMENT, { runId }, "run status v3", signal);
}

export function fetchRunStatusV4ViaDaemon(
  home: ApplicationHome,
  runId: string,
  signal?: AbortSignal,
): Promise<Static<typeof StageRunStatusResultV4>> {
  return domainCall(home, RUN_STATUS_V4_REQUIREMENT, { runId }, "run status v4", signal);
}

export function listInteractionInboxViaDaemon(
  home: ApplicationHome,
  signal?: AbortSignal,
): Promise<Static<typeof InteractionInboxResultV1>> {
  return domainCall(home, INBOX_LIST_REQUIREMENT, {}, "interaction inbox", signal);
}

export function answerRunViaDaemon(
  home: ApplicationHome,
  runId: string,
  answer: Static<typeof InteractionAnswerSetV1>,
): Promise<Static<typeof StageRunMutationResultV1>> {
  return domainCall(
    home,
    mutationRequirement(RUN_ANSWER_METHOD, RUN_ANSWER_V1_METHOD),
    { runId, answer },
    "run answer",
  );
}

export function answerRunV2ViaDaemon(
  home: ApplicationHome,
  runId: string,
  answer: Static<typeof InteractionAnswerSubmissionV2>,
): Promise<Static<typeof StageRunAnswerResultV2>> {
  return domainCall(
    home,
    RUN_ANSWER_V2_REQUIREMENT,
    { schemaVersion: 2, runId, answer },
    "run answer v2",
  );
}

export function resumeRunViaDaemon(
  home: ApplicationHome,
  runId: string,
  inputArtifactRefs: ArtifactId[],
): Promise<Static<typeof StageRunMutationResultV1>> {
  return domainCall(
    home,
    mutationRequirement(RUN_RESUME_METHOD, RUN_RESUME_V1_METHOD),
    { runId, inputArtifactRefs },
    "run resume",
  );
}

export function resumeRunV2ViaDaemon(
  home: ApplicationHome,
  runId: string,
  expectedRunRevision: number,
  inputArtifactRefs: ArtifactId[],
): Promise<Static<typeof StageRunResumeResultV2>> {
  return domainCall(
    home,
    RUN_RESUME_V2_REQUIREMENT,
    { schemaVersion: 2, runId, expectedRunRevision, inputArtifactRefs },
    "run resume v2",
  );
}

export function cancelRunViaDaemon(
  home: ApplicationHome,
  runId: string,
): Promise<Static<typeof StageRunMutationResultV1>> {
  return domainCall(
    home,
    mutationRequirement(RUN_CANCEL_METHOD, RUN_CANCEL_V1_METHOD),
    { runId },
    "run cancel",
  );
}

export function fetchRunResultViaDaemon(
  home: ApplicationHome,
  runId: string,
): Promise<Static<typeof StageRunResultV1>> {
  return domainCall(home, RUN_RESULT_REQUIREMENT, { runId }, "run result");
}

export function fetchRunResultV2ViaDaemon(
  home: ApplicationHome,
  runId: string,
): Promise<Static<typeof StageRunResultV2>> {
  return domainCall(home, RUN_RESULT_V2_REQUIREMENT, { runId }, "run result v2");
}

export function fetchRunResultV3ViaDaemon(
  home: ApplicationHome,
  runId: string,
): Promise<Static<typeof StageRunResultV3>> {
  return domainCall(home, RUN_RESULT_V3_REQUIREMENT, { runId }, "run result v3");
}

export function fetchRunResultV4ViaDaemon(
  home: ApplicationHome,
  runId: string,
): Promise<Static<typeof StageRunResultV4>> {
  return domainCall(home, RUN_RESULT_V4_REQUIREMENT, { runId }, "run result v4");
}

/**
 * Q023's native bridge — the surface the Claude Code plugin (Q050) will
 * drive: attach once per connection, then poll/question/submit against
 * whatever native stages a codebase's `stage.start.v3` calls have queued.
 */
export function attachParentSessionViaDaemon(
  home: ApplicationHome,
  input: {
    readonly currentDirectory: string;
    readonly previousSessionId?: string;
    readonly previousSessionRevision?: number;
    readonly resumeDispatchIds?: readonly string[];
    readonly signal?: AbortSignal;
  },
): Promise<Static<typeof ParentSessionAttachmentV1>> {
  return domainCall(
    home,
    PARENT_SESSION_ATTACH_REQUIREMENT,
    {
      schemaVersion: 1,
      currentDirectory: input.currentDirectory,
      ...(input.previousSessionId === undefined
        ? {}
        : { previousSessionId: input.previousSessionId }),
      ...(input.previousSessionRevision === undefined
        ? {}
        : { previousSessionRevision: input.previousSessionRevision }),
      resumeDispatchIds: [...(input.resumeDispatchIds ?? [])],
    },
    "parent session attach",
    input.signal,
  );
}

export function detachParentSessionViaDaemon(
  home: ApplicationHome,
  input: {
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly dispatches: readonly {
      readonly dispatchId: string;
      readonly outcome: "not_started" | "abandoned";
    }[];
    readonly signal?: AbortSignal;
  },
): Promise<Static<typeof ParentSessionDetachResultV1>> {
  return domainCall(
    home,
    PARENT_SESSION_DETACH_REQUIREMENT,
    {
      schemaVersion: 1,
      sessionId: input.sessionId,
      sessionRevision: input.sessionRevision,
      dispatches: [...input.dispatches],
    },
    "parent session detach",
    input.signal,
  );
}

export function pollNativeStageViaDaemon(
  home: ApplicationHome,
  input: {
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly maxDispatches?: number;
    readonly signal?: AbortSignal;
  },
): Promise<Static<typeof NativeStagePollResultV1>> {
  return domainCall(
    home,
    NATIVE_STAGE_POLL_REQUIREMENT,
    {
      schemaVersion: 1,
      sessionId: input.sessionId,
      sessionRevision: input.sessionRevision,
      ...(input.maxDispatches === undefined ? {} : { maxDispatches: input.maxDispatches }),
    },
    "native stage poll",
    input.signal,
  );
}

export function pollNativeStageV2ViaDaemon(
  home: ApplicationHome,
  input: {
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly maxDispatches?: number;
    readonly signal?: AbortSignal;
  },
): Promise<Static<typeof NativeStagePollResultV2>> {
  return domainCall(
    home,
    NATIVE_STAGE_POLL_V2_REQUIREMENT,
    {
      schemaVersion: 1,
      sessionId: input.sessionId,
      sessionRevision: input.sessionRevision,
      ...(input.maxDispatches === undefined ? {} : { maxDispatches: input.maxDispatches }),
    },
    "native stage poll v2",
    input.signal,
  );
}

export function raiseNativeStageQuestionViaDaemon(
  home: ApplicationHome,
  input: {
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly dispatchId: string;
    readonly expectedDispatchRevision: number;
    readonly runId: string;
    readonly stageId: string;
    readonly attemptId: string;
    readonly interaction: Static<typeof PendingInteractionV2>;
    readonly signal?: AbortSignal;
  },
): Promise<Static<typeof NativeStageQuestionResultV1>> {
  return domainCall(
    home,
    NATIVE_STAGE_QUESTION_REQUIREMENT,
    {
      schemaVersion: 1,
      sessionId: input.sessionId,
      sessionRevision: input.sessionRevision,
      dispatchId: input.dispatchId,
      expectedDispatchRevision: input.expectedDispatchRevision,
      runId: input.runId,
      stageId: input.stageId,
      attemptId: input.attemptId,
      interaction: input.interaction,
    },
    "native stage question",
    input.signal,
  );
}

export function submitNativeStageViaDaemon(
  home: ApplicationHome,
  input: {
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly dispatchId: string;
    readonly expectedDispatchRevision: number;
    readonly runId: string;
    readonly stageId: string;
    readonly attemptId: string;
    readonly submissionId: string;
    readonly outcome: "succeeded" | "failed" | "cancelled";
    readonly result?: Static<typeof ExternalStageResultV1>;
    readonly failure?: Static<typeof ExecutionFailureV1>;
    readonly signal?: AbortSignal;
  },
): Promise<Static<typeof NativeStageSubmitResultV1>> {
  return domainCall(
    home,
    NATIVE_STAGE_SUBMIT_REQUIREMENT,
    {
      schemaVersion: 1,
      sessionId: input.sessionId,
      sessionRevision: input.sessionRevision,
      dispatchId: input.dispatchId,
      expectedDispatchRevision: input.expectedDispatchRevision,
      runId: input.runId,
      stageId: input.stageId,
      attemptId: input.attemptId,
      submissionId: input.submissionId,
      outcome: input.outcome,
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.failure === undefined ? {} : { failure: input.failure }),
    },
    "native stage submit",
    input.signal,
  );
}

export function fetchNativeStageStatusViaDaemon(
  home: ApplicationHome,
  runId: string,
  signal?: AbortSignal,
): Promise<Static<typeof NativeStageStatusResultV1>> {
  return domainCall(
    home,
    NATIVE_STAGE_STATUS_REQUIREMENT,
    { runId },
    "native stage status",
    signal,
  );
}

export async function fetchArtifactViaDaemon(
  home: ApplicationHome,
  artifactId: string,
): Promise<Static<typeof ArtifactGetResultV1>> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let first: Static<typeof ArtifactGetResultV1> | undefined;
  for (;;) {
    const result = await domainCall<Static<typeof ArtifactGetResultV1>>(
      home,
      ARTIFACT_GET_REQUIREMENT,
      { artifactId, offset },
      "artifact retrieval",
    );
    if (result.offset !== offset) {
      throw new HeniekClientError("RPC_FAILURE", "Artifact chunk offset is invalid.", false);
    }
    if (
      first !== undefined &&
      (result.artifactId !== first.artifactId ||
        result.byteLength !== first.byteLength ||
        result.sha256 !== first.sha256 ||
        result.name !== first.name ||
        result.mediaType !== first.mediaType)
    ) {
      throw new HeniekClientError(
        "RPC_FAILURE",
        "Artifact metadata changed during retrieval.",
        false,
      );
    }
    first ??= result;
    const chunk = Buffer.from(result.contentBase64, "base64");
    if (chunk.byteLength === 0 && !result.eof) {
      throw new HeniekClientError("RPC_FAILURE", "Artifact retrieval made no progress.", false);
    }
    chunks.push(chunk);
    offset += chunk.byteLength;
    if (result.eof) break;
  }
  if (first === undefined) {
    throw new HeniekClientError("RPC_FAILURE", "Artifact retrieval returned no data.", false);
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.byteLength !== first.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== first.sha256
  ) {
    throw new HeniekClientError("RPC_FAILURE", "Artifact response integrity is invalid.", false);
  }
  return { ...first, offset: 0, eof: true, contentBase64: bytes.toString("base64") };
}

export function fetchDoctorReportViaDaemon(
  home: ApplicationHome,
): Promise<Static<typeof DoctorReportV1>> {
  return domainCall(home, DOCTOR_REQUIREMENT, {}, "doctor");
}

export function fetchDoctorReportV2ViaDaemon(
  home: ApplicationHome,
): Promise<Static<typeof DoctorReportV2>> {
  return domainCall(home, DOCTOR_V2_REQUIREMENT, {}, "doctor");
}

export function fetchCapabilityCatalogueViaDaemon(
  home: ApplicationHome,
  options: { readonly refresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<Static<typeof CapabilityCatalogueV1>> {
  return domainCall(
    home,
    ENGINE_CATALOGUE_REQUIREMENT,
    { schemaVersion: 1, refresh: options.refresh ?? false },
    "capability catalogue",
    options.signal,
  );
}

/** Q032 — admit a named or one-off pipeline definition (no schedule write). */
export function validatePipelineViaDaemon(
  home: ApplicationHome,
  request: Static<typeof PipelineValidateRequestV1>,
  signal?: AbortSignal,
): Promise<Static<typeof PipelineValidateResultV1>> {
  return domainCall(home, PIPELINE_VALIDATE_REQUIREMENT, request, "pipeline validate", signal);
}

/** Q032 — admit, create schedule, and persist the immutable run snapshot. */
export function runPipelineViaDaemon(
  home: ApplicationHome,
  request: Static<typeof PipelineRunRequestV1>,
  signal?: AbortSignal,
): Promise<Static<typeof PipelineRunResultV1>> {
  return domainCall(home, PIPELINE_RUN_REQUIREMENT, request, "pipeline run", signal);
}

/** Q032 — attach a completed source stage into a live target run. */
export function attachPipelineStageViaDaemon(
  home: ApplicationHome,
  request: Static<typeof PipelineAttachRequestV1>,
  signal?: AbortSignal,
): Promise<Static<typeof PipelineAttachResultV1>> {
  return domainCall(home, PIPELINE_ATTACH_REQUIREMENT, request, "pipeline attach", signal);
}
