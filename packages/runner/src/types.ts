/**
 * Shared stage-runner types (Q026/Q027). Command, agent, approval, integration,
 * verify, and publish runners implement the same prepare → start → observe →
 * cancel → collect → validate → finalize surface so the daemon can drain
 * scheduler intents uniformly.
 */

import type {
  ApprovalDecisionV1,
  ApprovalRequestV1,
  ArtifactId,
  ExecutionBackendV7,
  ExecutionIdentifierReaderV1,
  ExecutionPermissionEnvelopeV1,
  ExecutionRequestV4,
  ForgeBackendV2,
  IntegrationRequestV1,
  PipelineGraphV1,
  PublishRequestV1,
  ResolvedProfileSchemaV2,
  StageRunnerAttemptV1,
  StageRunnerAttemptV2,
  StageRunnerCleanupReportV1,
  StageRunnerEvidenceV1,
  StageRunnerFailureV1,
  StageRunnerFailureV2,
  StageRunnerOutputBindingV1,
  StageRunnerPhase,
  StageRunnerResultV1,
  StageRunnerResultV2,
  StageRunnerValidationReportV1,
  VerifyRequestV1,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import type { GitIntegrationAdapter } from "./git-integration.js";

export type StageRunnerAttempt = Static<typeof StageRunnerAttemptV1>;
export type StageRunnerAttemptV2Snapshot = Static<typeof StageRunnerAttemptV2>;
export type StageRunnerResult =
  | Static<typeof StageRunnerResultV1>
  | Static<typeof StageRunnerResultV2>;
export type StageRunnerFailure =
  | Static<typeof StageRunnerFailureV1>
  | Static<typeof StageRunnerFailureV2>;
export type StageRunnerEvidence = Static<typeof StageRunnerEvidenceV1>;
export type StageRunnerOutputBinding = Static<typeof StageRunnerOutputBindingV1>;
export type StageRunnerCleanupReport = Static<typeof StageRunnerCleanupReportV1>;
export type StageRunnerValidationReport = Static<typeof StageRunnerValidationReportV1>;
export type ResolvedProfile = Static<typeof ResolvedProfileSchemaV2>;
export type ExecutionPermissionEnvelope = Static<typeof ExecutionPermissionEnvelopeV1>;
export type ExecutionRequest = Static<typeof ExecutionRequestV4>;
export type ApprovalRequest = Static<typeof ApprovalRequestV1>;
export type ApprovalDecision = Static<typeof ApprovalDecisionV1>;
export type IntegrationRequest = Static<typeof IntegrationRequestV1>;
export type VerifyRequest = Static<typeof VerifyRequestV1>;
export type PublishRequest = Static<typeof PublishRequestV1>;

export type { GitIntegrationAdapter };

/** One normalized stage from `PipelineGraph/v1`. */
export type PipelineGraphStage = Static<typeof PipelineGraphV1>["stages"][number];

export type StageCompletionRequirement = NonNullable<
  PipelineGraphStage["completion"]
>["require"][number];

export type StageRunnerStageType =
  | "agent"
  | "command"
  | "approval"
  | "integration"
  | "verify"
  | "publish";

export interface RunnerClock {
  nowIso(): string;
}

/** Optional persistence hooks — the daemon wires durable state; unit tests omit them. */
export interface StageRunnerStoreCallbacks {
  readonly onAttemptUpdate?: (attempt: StageRunnerAttemptSnapshot) => void | Promise<void>;
  readonly onCleanup?: (report: StageRunnerCleanupReport) => void | Promise<void>;
  readonly onValidation?: (report: StageRunnerValidationReport) => void | Promise<void>;
}

/** In-memory / durable snapshot subset the runner mutates across phases. */
export interface StageRunnerAttemptSnapshot {
  readonly attemptId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly stageType: StageRunnerStageType;
  readonly intentId: string;
  readonly graphRevision: number;
  readonly generation: number;
  readonly attemptOrdinal: number;
  phase: StageRunnerPhase;
  workspaceId?: string;
  leaseId?: string;
  checkoutPath?: string;
  processGroupId?: number;
  backendExecutionId?: string;
  operationId?: string;
  deadlineAt?: string;
  runtimeDirectory?: string;
  preparedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  outputs: StageRunnerOutputBinding[];
  evidence: StageRunnerEvidence[];
  result?: StageRunnerResult;
  failure?: StageRunnerFailure;
  recovery: StageRunnerAttemptV2Snapshot["recovery"];
  revision: number;
  updatedAt: string;
  createdAt: string;
  cleanup?: StageRunnerCleanupReport;
  validation?: StageRunnerValidationReport;
  exitCode?: number;
  resultEnvelope?: unknown;
}

export interface StageRunnerPrepareInput {
  readonly attemptId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly intentId: string;
  readonly graphRevision: number;
  readonly generation: number;
  readonly attemptOrdinal: number;
  readonly stage: PipelineGraphStage;
  /** Absolute checkout path after the caller finished provisioning. */
  readonly checkoutPath?: string;
  readonly workspaceId?: string;
  readonly leaseId?: string;
  /** Hard deadline (ISO). Combined with stage/profile duration caps when present. */
  readonly deadlineAt?: string;
  /** Private runtime directory for stdout/stderr and runner-local files — never the registered repo. */
  readonly runtimeDirectory: string;
  readonly approvalRequest?: ApprovalRequest;
  readonly integrationRequest?: IntegrationRequest;
  readonly verifyRequest?: VerifyRequest;
  readonly publishRequest?: PublishRequest;
}

export interface StageRunnerPrepareOutcome {
  readonly attemptId: string;
  readonly preparedAt: string;
  readonly deadlineAt?: string;
  readonly checkoutPath?: string;
  readonly runtimeDirectory: string;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly executionRequest?: ExecutionRequest;
  readonly profileId?: string;
}

export type StageRunnerObserveOutcome =
  | { readonly status: "running" }
  | { readonly status: "waiting" }
  | { readonly status: "timed_out"; readonly cleanup: StageRunnerCleanupReport }
  | {
      readonly status: "exited";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | {
      readonly status: "terminal";
      readonly backendStatus: "succeeded" | "failed" | "cancelled";
    }
  | { readonly status: "recovery_required"; readonly reason: string };

export interface StageRunnerFinalizeOutcome {
  readonly result: StageRunnerResult;
  readonly validation: StageRunnerValidationReport;
  readonly cleanup?: StageRunnerCleanupReport;
}

export interface StageRunner {
  prepare(input: StageRunnerPrepareInput): Promise<StageRunnerPrepareOutcome>;
  start(attemptId: string): Promise<void>;
  observe(attemptId: string): Promise<StageRunnerObserveOutcome>;
  cancel(attemptId: string): Promise<StageRunnerCleanupReport>;
  collect(attemptId: string): Promise<void>;
  validate(attemptId: string): Promise<StageRunnerValidationReport>;
  finalize(attemptId: string): Promise<StageRunnerFinalizeOutcome>;
}

export type ResolveAgentInvocation = () => Promise<{
  readonly prompt: string;
  readonly artifactPath: string;
  readonly inputArtifactRefs: readonly ArtifactId[];
}>;

export interface AgentStageRunnerDeps {
  readonly backend: ExecutionBackendV7;
  readonly resolveProfile: (profileId: string) => Promise<ResolvedProfile>;
  readonly resolvePermissions: (profile: ResolvedProfile) => Promise<ExecutionPermissionEnvelope>;
  readonly resolveAgentInvocation: ResolveAgentInvocation;
  readonly identifierReader: ExecutionIdentifierReaderV1;
  readonly clock?: RunnerClock;
  readonly store?: StageRunnerStoreCallbacks;
  /** Observe-until-terminal poll interval after cancel/timeout. */
  readonly pollIntervalMs?: number;
  readonly cancelObserveTimeoutMs?: number;
}

export interface CommandStageRunnerDeps {
  readonly clock?: RunnerClock;
  readonly store?: StageRunnerStoreCallbacks;
  /** SIGTERM → SIGKILL grace for timeout/cancel. */
  readonly gracePeriodMs?: number;
  /**
   * Optional spawn override for unit tests that assert argv/cwd/env without a
   * real subprocess. Production leaves this unset.
   */
  readonly spawn?: typeof import("./process.js").spawnCommand;
  readonly terminate?: typeof import("./process.js").terminateProcessGroup;
}

export interface ApprovalStageRunnerDeps {
  readonly clock?: RunnerClock;
  readonly store?: StageRunnerStoreCallbacks;
}

export interface IntegrationStageRunnerDeps {
  readonly git: GitIntegrationAdapter;
  readonly clock?: RunnerClock;
  readonly store?: StageRunnerStoreCallbacks;
}

export interface VerifyStageRunnerDeps {
  readonly clock?: RunnerClock;
  readonly store?: StageRunnerStoreCallbacks;
  readonly gracePeriodMs?: number;
  readonly spawn?: typeof import("./process.js").spawnCommand;
  readonly terminate?: typeof import("./process.js").terminateProcessGroup;
}

export interface PublishStageRunnerDeps {
  readonly forge: ForgeBackendV2;
  readonly clock?: RunnerClock;
  readonly store?: StageRunnerStoreCallbacks;
}
