/**
 * Agent stage runner — one approved profile, one ExecutionRequestV4, backend only.
 */

import { createHash } from "node:crypto";
import type {
  ExecutionBackendV7,
  ExecutionBackendV8,
  ExecutionResumeRequestV2,
  ExecutionStatus,
} from "@heniek/contracts";
import { ExternalStageResultV1 } from "@heniek/contracts";
import { validateExecutionWorkspace } from "@heniek/workspace";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { bump, notifyStore, systemClock } from "./attempt.js";
import { asAttemptId, asBackendExecutionId, asStageId, asWorkspaceId } from "./brands.js";
import { redactFailureMessage } from "./redact.js";
import { validateStructuredReviewReport } from "./structured-report.js";
import type {
  AgentStageRunnerDeps,
  ExecutionRequest,
  ResolvedProfile,
  StageRunner,
  StageRunnerAttemptSnapshot,
  StageRunnerCleanupReport,
  StageRunnerFailure,
  StageRunnerFinalizeOutcome,
  StageRunnerObserveOutcome,
  StageRunnerPrepareInput,
  StageRunnerPrepareOutcome,
  StageRunnerResult,
  StageRunnerRetryDirective,
  StageRunnerSegmentDirective,
  StageRunnerValidationReport,
} from "./types.js";
import { validateStageCompletion } from "./validate.js";

/** Lift a V7 backend to V8 by projecting resume requests down to v1. */
export function asExecutionBackendV8(backend: ExecutionBackendV7): ExecutionBackendV8 {
  return {
    start: (request, context) => backend.start(request, context),
    status: (executionId) => backend.status(executionId),
    interactions: (executionId) => backend.interactions(executionId),
    answer: (executionId, answer) => backend.answer(executionId, answer),
    resume: async (request: Static<typeof ExecutionResumeRequestV2>) => {
      await backend.resume({
        schemaVersion: 1,
        executionId: request.executionId,
        operationId: request.operationId,
        inputArtifactRefs: request.inputArtifactRefs,
      });
    },
    result: (executionId) => backend.result(executionId),
    cancel: (executionId) => backend.cancel(executionId),
    artifacts: (executionId) => backend.artifacts(executionId),
    readArtifact: (executionId, artifactId) => backend.readArtifact(executionId, artifactId),
    events: (executionId, after) => backend.events(executionId, after),
  };
}

interface AgentAttemptState {
  readonly snapshot: StageRunnerAttemptSnapshot;
  readonly profile: ResolvedProfile;
  readonly executionRequest: ExecutionRequest;
  readonly writes: readonly string[];
  readonly requirements: NonNullable<StageRunnerPrepareInput["stage"]["completion"]>["require"];
  readonly retryDirective?: StageRunnerRetryDirective;
  readonly segmentDirective?: StageRunnerSegmentDirective;
  readonly priorBackendExecutionId?: string;
  readonly structuredSchemaName?: import("@heniek/contracts").ReviewReportSchemaName;
  started: boolean;
  /** Resume was requested but prior execution was missing or resume failed. */
  resumeFailed?: StageRunnerFailure;
  backendStatus?: ExecutionStatus;
  timedOut: boolean;
  cancelled: boolean;
  cleanup?: StageRunnerCleanupReport;
  validation?: StageRunnerValidationReport;
  digestMismatch: boolean;
  structuredReportInvalid: boolean;
}

function resumeFailure(message: string, code: string): StageRunnerFailure {
  return {
    schemaVersion: 1,
    classification: "start_failed",
    phase: "start",
    code,
    message: redactFailureMessage(message),
    retryable: false,
    recovery: "none",
  } as StageRunnerFailure;
}

function minIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a < b ? a : b;
}

function deadlineFromDuration(nowIso: string, durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  return new Date(Date.parse(nowIso) + durationMs).toISOString();
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Map artifact paths like `artifacts/design.md` onto completion names (`design`). */
function artifactEvidenceRequirement(path: string): string {
  const stripped = path.replace(/^artifacts\//, "");
  const dot = stripped.lastIndexOf(".");
  return dot > 0 ? stripped.slice(0, dot) : stripped;
}

const TERMINAL = new Set<ExecutionStatus>(["succeeded", "failed", "cancelled"]);

export function createAgentStageRunner(deps: AgentStageRunnerDeps): StageRunner {
  const clock = deps.clock ?? systemClock;
  const pollIntervalMs = deps.pollIntervalMs ?? 25;
  const cancelObserveTimeoutMs = deps.cancelObserveTimeoutMs ?? 5_000;
  const attempts = new Map<string, AgentAttemptState>();

  function requireAttempt(attemptId: string): AgentAttemptState {
    const state = attempts.get(attemptId);
    if (state === undefined) {
      throw new Error(`unknown agent attempt: ${attemptId}`);
    }
    return state;
  }

  async function observeUntilTerminal(
    state: AgentAttemptState,
    _reason: "cancel" | "timeout",
  ): Promise<"terminal" | "recovery_required"> {
    const deadline = Date.now() + cancelObserveTimeoutMs;
    while (Date.now() < deadline) {
      const status = await deps.backend.status(state.snapshot.backendExecutionId!);
      state.backendStatus = status;
      if (TERMINAL.has(status)) return "terminal";
      if (status === "recovery_required") return "recovery_required";
      await sleep(pollIntervalMs);
    }
    state.snapshot.recovery = "observe_backend";
    return "recovery_required";
  }

  async function validateAttempt(attemptId: string): Promise<StageRunnerValidationReport> {
    const state = requireAttempt(attemptId);
    state.snapshot.phase = "validate";
    let report = validateStageCompletion({
      attemptId,
      writes: state.writes,
      requirements: state.requirements,
      outputs: state.snapshot.outputs,
      evidence: state.snapshot.evidence,
      resultEnvelope: state.snapshot.resultEnvelope,
      exitCode: undefined,
      recordedAt: clock.nowIso(),
    });
    if (state.digestMismatch) {
      report = {
        ...report,
        valid: false,
        detail: "artifact digest mismatch",
      };
    }
    if (state.structuredReportInvalid) {
      report = {
        ...report,
        valid: false,
        detail: "structured report validation failed",
      };
    }
    state.validation = report;
    state.snapshot.validation = report;
    bump(state.snapshot, clock);
    await notifyStore(deps.store, state.snapshot);
    await deps.store?.onValidation?.(report);
    return report;
  }

  return {
    async prepare(input: StageRunnerPrepareInput): Promise<StageRunnerPrepareOutcome> {
      if (input.stage.type !== "agent") {
        throw new Error("createAgentStageRunner only accepts agent stages");
      }
      const profileId = input.stage.profile;
      if (profileId === undefined || profileId.length === 0) {
        throw new Error("agent stage requires exactly one profile id");
      }
      if (input.checkoutPath === undefined) {
        throw new Error("agent stage requires a checkoutPath");
      }
      const checkoutPath = input.checkoutPath;

      const profile = await deps.resolveProfile(profileId);
      if (profile.profileId !== profileId) {
        throw new Error("resolveProfile must return the requested approved profile");
      }
      const permissions = await deps.resolvePermissions(profile);
      const invocation = await deps.resolveAgentInvocation();
      await validateExecutionWorkspace({
        assignedWorktree: checkoutPath,
        workingDirectory: checkoutPath,
        artifactPaths: [invocation.artifactPath],
      });
      const now = clock.nowIso();

      const deadlineAt = minIso(
        input.deadlineAt,
        minIso(
          deadlineFromDuration(now, input.stage.limits?.maxDurationMs),
          deadlineFromDuration(now, profile.maxDurationMs),
        ),
      );

      if (input.workspaceId === undefined) {
        throw new Error("agent stage prepare requires workspaceId");
      }

      const durationCandidates = [profile.maxDurationMs, input.stage.limits?.maxDurationMs].filter(
        (value): value is number => value !== undefined,
      );
      const limits =
        durationCandidates.length === 0 ? {} : { maxDurationMs: Math.min(...durationCandidates) };

      const executionRequest: ExecutionRequest = {
        schemaVersion: 4,
        runId: input.runId,
        stageId: asStageId(input.stageId),
        workspaceId: asWorkspaceId(input.workspaceId),
        workingDirectory: checkoutPath,
        prompt: invocation.prompt,
        artifactPath: invocation.artifactPath,
        inputArtifactRefs: [...invocation.inputArtifactRefs],
        limits,
        profile,
        permissions,
      };

      const snapshot: StageRunnerAttemptSnapshot = {
        attemptId: input.attemptId,
        runId: input.runId,
        stageId: input.stageId,
        stageType: "agent",
        intentId: input.intentId,
        graphRevision: input.graphRevision,
        generation: input.generation,
        attemptOrdinal: input.attemptOrdinal,
        phase: "prepare",
        workspaceId: input.workspaceId,
        ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
        checkoutPath,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        runtimeDirectory: input.runtimeDirectory,
        preparedAt: now,
        outputs: [],
        evidence: [],
        recovery: "none",
        revision: 1,
        updatedAt: now,
        createdAt: now,
      };

      const priorBackendExecutionId =
        input.priorBackendExecutionId ??
        input.segmentDirective?.priorBackendExecutionId ??
        input.retryDirective?.priorBackendExecutionId;

      attempts.set(input.attemptId, {
        snapshot,
        profile,
        executionRequest,
        writes: [...input.stage.writes],
        requirements: input.stage.completion?.require ?? [],
        ...(input.retryDirective === undefined ? {} : { retryDirective: input.retryDirective }),
        ...(input.segmentDirective === undefined
          ? {}
          : { segmentDirective: input.segmentDirective }),
        ...(priorBackendExecutionId === undefined ? {} : { priorBackendExecutionId }),
        ...(invocation.structuredSchemaName === undefined
          ? {}
          : { structuredSchemaName: invocation.structuredSchemaName }),
        started: false,
        timedOut: false,
        cancelled: false,
        digestMismatch: false,
        structuredReportInvalid: false,
      });
      await notifyStore(deps.store, snapshot);

      return {
        attemptId: input.attemptId,
        preparedAt: now,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        checkoutPath,
        runtimeDirectory: input.runtimeDirectory,
        executionRequest,
        profileId,
      };
    },

    async start(attemptId: string): Promise<void> {
      const state = requireAttempt(attemptId);
      if (state.started) {
        throw new Error("agent backend.start must be called exactly once");
      }

      const segmentMode = state.segmentDirective?.mode;
      const recoveryMode = state.retryDirective?.mode ?? "fresh";
      const shouldResume =
        segmentMode === "fuse_resume" || (segmentMode === undefined && recoveryMode === "resume");
      const priorId = state.priorBackendExecutionId;

      if (shouldResume) {
        if (priorId === undefined || priorId.length === 0) {
          state.resumeFailed = resumeFailure(
            "resume requested without priorBackendExecutionId",
            "resume_missing_prior",
          );
          state.snapshot.failure = state.resumeFailed;
          state.started = true;
          state.snapshot.phase = "start";
          state.snapshot.startedAt = clock.nowIso();
          bump(state.snapshot, clock);
          await notifyStore(deps.store, state.snapshot);
          state.snapshot.phase = "observe";
          bump(state.snapshot, clock);
          await notifyStore(deps.store, state.snapshot);
          return;
        }

        try {
          await deps.backend.status(priorId);
        } catch {
          state.resumeFailed = resumeFailure(
            `resume requested but prior backend execution ${priorId} is unavailable`,
            "resume_prior_missing",
          );
          state.snapshot.failure = state.resumeFailed;
          state.started = true;
          state.snapshot.phase = "start";
          state.snapshot.startedAt = clock.nowIso();
          bump(state.snapshot, clock);
          await notifyStore(deps.store, state.snapshot);
          state.snapshot.phase = "observe";
          bump(state.snapshot, clock);
          await notifyStore(deps.store, state.snapshot);
          return;
        }

        const instruction =
          state.segmentDirective?.instruction ??
          (state.executionRequest.inputArtifactRefs.length === 0
            ? "Continue the stage from the current workspace state."
            : `Continue the stage using these Heniek input artifact references: ${state.executionRequest.inputArtifactRefs.join(", ")}.`);

        await (deps.backend as ExecutionBackendV8).resume({
          schemaVersion: 2,
          executionId: asBackendExecutionId(priorId),
          operationId:
            segmentMode === "fuse_resume" ? `fuse-resume:${attemptId}` : `resume:${attemptId}`,
          inputArtifactRefs: [...state.executionRequest.inputArtifactRefs],
          instruction,
          stageId: asStageId(state.snapshot.stageId),
          ...(state.segmentDirective?.capsuleRef === undefined
            ? {}
            : {
                capsuleRef: state.segmentDirective.capsuleRef as never,
              }),
        });
        state.started = true;
        // Resume continues the prior backend identity — do not mint a new id.
        state.snapshot.backendExecutionId = priorId;
        state.snapshot.phase = "start";
        state.snapshot.startedAt = clock.nowIso();
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        state.snapshot.phase = "observe";
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        return;
      }

      // fresh, delegate, and continue_fresh all start a new backend execution;
      // daemon resolves delegated profiles onto stage.profile before prepare.
      const handle = await deps.backend.start(state.executionRequest, {
        identifierReader: deps.identifierReader,
      });
      state.started = true;
      state.snapshot.backendExecutionId = handle.executionId;
      state.snapshot.phase = "start";
      state.snapshot.startedAt = clock.nowIso();
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
      state.snapshot.phase = "observe";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
    },

    async observe(attemptId: string): Promise<StageRunnerObserveOutcome> {
      const state = requireAttempt(attemptId);
      if (state.resumeFailed !== undefined) {
        state.backendStatus = "failed";
        return { status: "terminal", backendStatus: "failed" };
      }
      const executionId = state.snapshot.backendExecutionId;
      if (executionId === undefined) {
        throw new Error("observe called before start");
      }
      state.snapshot.phase = "observe";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);

      const deadlineAt = state.snapshot.deadlineAt;
      if (
        !state.timedOut &&
        deadlineAt !== undefined &&
        clock.nowIso() >= deadlineAt &&
        (state.backendStatus === undefined || !TERMINAL.has(state.backendStatus))
      ) {
        state.timedOut = true;
        await deps.backend.cancel(executionId);
        const settled = await observeUntilTerminal(state, "timeout");
        const cleanup: StageRunnerCleanupReport = {
          schemaVersion: 1,
          attemptId: asAttemptId(attemptId),
          signalSequence: ["backend_cancel"],
          descendantsRemaining: settled === "terminal" ? 0 : 1,
          gracePeriodMs: cancelObserveTimeoutMs,
          cleaned: settled === "terminal",
          recordedAt: clock.nowIso(),
          ...(settled === "terminal"
            ? {}
            : { detail: "backend did not reach a terminal status after timeout cancel" }),
        };
        state.cleanup = cleanup;
        state.snapshot.cleanup = cleanup;
        if (settled === "recovery_required") {
          state.snapshot.recovery = "observe_backend";
          bump(state.snapshot, clock);
          await notifyStore(deps.store, state.snapshot);
          await deps.store?.onCleanup?.(cleanup);
          return { status: "recovery_required", reason: "timeout_cancel_unsettled" };
        }
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        await deps.store?.onCleanup?.(cleanup);
        return { status: "timed_out", cleanup };
      }

      const status = await deps.backend.status(executionId);
      state.backendStatus = status;
      if (status === "waiting_on_user") return { status: "waiting" };
      if (status === "recovery_required") {
        state.snapshot.recovery = "observe_backend";
        return { status: "recovery_required", reason: "backend_recovery_required" };
      }
      if (TERMINAL.has(status)) {
        return {
          status: "terminal",
          backendStatus: status as "succeeded" | "failed" | "cancelled",
        };
      }
      return { status: "running" };
    },

    async cancel(attemptId: string): Promise<StageRunnerCleanupReport> {
      const state = requireAttempt(attemptId);
      state.cancelled = true;
      state.snapshot.phase = "cancel";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);

      const executionId = state.snapshot.backendExecutionId;
      if (executionId === undefined) {
        const report: StageRunnerCleanupReport = {
          schemaVersion: 1,
          attemptId: asAttemptId(attemptId),
          signalSequence: [],
          descendantsRemaining: 0,
          gracePeriodMs: cancelObserveTimeoutMs,
          cleaned: true,
          recordedAt: clock.nowIso(),
          detail: "no backend execution to cancel",
        };
        state.cleanup = report;
        await deps.store?.onCleanup?.(report);
        return report;
      }

      await deps.backend.cancel(executionId);
      const settled = await observeUntilTerminal(state, "cancel");
      const cleanup: StageRunnerCleanupReport = {
        schemaVersion: 1,
        attemptId: asAttemptId(attemptId),
        signalSequence: ["backend_cancel"],
        descendantsRemaining: settled === "terminal" ? 0 : 1,
        gracePeriodMs: cancelObserveTimeoutMs,
        cleaned: settled === "terminal",
        recordedAt: clock.nowIso(),
        ...(settled === "terminal"
          ? {}
          : { detail: "backend did not reach a terminal status after cancel" }),
      };
      state.cleanup = cleanup;
      state.snapshot.cleanup = cleanup;
      if (settled === "recovery_required") {
        state.snapshot.recovery = "observe_backend";
      }
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
      await deps.store?.onCleanup?.(cleanup);
      return cleanup;
    },

    async collect(attemptId: string): Promise<void> {
      const state = requireAttempt(attemptId);
      state.snapshot.phase = "collect";
      if (state.resumeFailed !== undefined) {
        state.snapshot.failure = state.resumeFailed;
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        return;
      }
      const executionId = state.snapshot.backendExecutionId;
      if (executionId === undefined) {
        throw new Error("collect called before start");
      }
      const now = clock.nowIso();
      const result = await deps.backend.result(executionId);
      const artifacts = await deps.backend.artifacts(executionId);

      const outputs = [...state.snapshot.outputs];
      const evidence = [...state.snapshot.evidence];

      for (const artifact of artifacts) {
        const bytes = await deps.backend.readArtifact(executionId, artifact.id);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (artifact.sha256 !== undefined && artifact.sha256 !== digest) {
          state.digestMismatch = true;
          evidence.push({
            schemaVersion: 1,
            kind: "artifact",
            satisfied: false,
            recordedAt: now,
            requirement: artifactEvidenceRequirement(artifact.path),
            detail: "artifact digest mismatch",
            payload: { declared: artifact.sha256, actual: digest },
          });
          continue;
        }
        evidence.push({
          schemaVersion: 1,
          kind: "artifact",
          satisfied: true,
          recordedAt: now,
          requirement: artifactEvidenceRequirement(artifact.path),
          payload: { artifactId: artifact.id, contentHash: digest },
        });
        if (
          state.structuredSchemaName !== undefined &&
          artifact.path === state.executionRequest.artifactPath
        ) {
          const structured = validateStructuredReviewReport(state.structuredSchemaName, bytes, {
            runId: state.snapshot.runId,
            stageId: state.snapshot.stageId,
          });
          evidence.push({
            schemaVersion: 1,
            kind: "schema_check",
            satisfied: structured.valid,
            recordedAt: now,
            requirement: `schema_check:${state.structuredSchemaName}`,
            ...(structured.detail === undefined ? {} : { detail: structured.detail }),
            payload: {
              contentSchemaId: structured.contentSchemaId,
              mediaType: structured.mediaType,
            },
          });
          if (!structured.valid) {
            state.structuredReportInvalid = true;
          } else {
            for (const write of state.writes) {
              if (
                write.startsWith("artifacts.") ||
                outputs.some((item) => item.reference === write)
              ) {
                continue;
              }
              outputs.push({
                schemaVersion: 1,
                reference: write,
                kind: "value",
                value: structured.stateValue,
              });
            }
            const verdictRequirement = state.requirements.find(
              (requirement) => requirement.kind === "verdict",
            );
            if (verdictRequirement?.kind === "verdict") {
              evidence.push({
                schemaVersion: 1,
                kind: "verdict",
                satisfied: structured.verdictReady === true,
                recordedAt: now,
                requirement: `verdict:${verdictRequirement.profile}`,
                payload: { verdictReady: structured.verdictReady ?? false },
              });
            }
          }
        }
        for (const write of state.writes) {
          if (outputs.some((binding) => binding.reference === write)) continue;
          if (write.startsWith("artifacts.") || write === artifact.path) {
            outputs.push({
              schemaVersion: 1,
              reference: write,
              kind: "artifact",
              relativePath: artifact.path,
              contentHash: digest,
            });
          }
        }
      }

      const envelopeCandidate = {
        schemaVersion: 1 as const,
        summary: result.summary,
        artifactPath: state.executionRequest.artifactPath,
      };
      if (Value.Check(ExternalStageResultV1, envelopeCandidate)) {
        state.snapshot.resultEnvelope = envelopeCandidate;
        evidence.push({
          schemaVersion: 1,
          kind: "result_envelope",
          satisfied: true,
          recordedAt: now,
        });
      } else {
        state.snapshot.resultEnvelope = {
          summary: result.summary,
          artifactPath: state.executionRequest.artifactPath,
        };
        evidence.push({
          schemaVersion: 1,
          kind: "result_envelope",
          satisfied: false,
          recordedAt: now,
          detail: "terminal result does not satisfy ExternalStageResult/v1",
        });
      }

      if (result.diff !== undefined && result.diff.files > 0) {
        evidence.push({
          schemaVersion: 1,
          kind: "non_empty_diff",
          satisfied: true,
          recordedAt: now,
          payload: result.diff,
        });
      }

      if (result.failure !== undefined) {
        state.snapshot.failure = {
          schemaVersion: 1,
          classification: "backend_failed",
          phase: "collect",
          code: result.failure.code,
          message: redactFailureMessage(result.failure.message),
          retryable: result.failure.fallbackEligible,
          recovery: state.snapshot.recovery,
          backendFailure: result.failure,
        } as StageRunnerFailure;
      }

      state.snapshot.outputs = outputs;
      state.snapshot.evidence = evidence;
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
    },

    async validate(attemptId: string): Promise<StageRunnerValidationReport> {
      return validateAttempt(attemptId);
    },

    async finalize(attemptId: string): Promise<StageRunnerFinalizeOutcome> {
      const state = requireAttempt(attemptId);
      state.snapshot.phase = "finalize";
      const validation = state.validation ?? (await validateAttempt(attemptId));

      const finishedAt = clock.nowIso();
      const backendFailed =
        state.backendStatus === "failed" || state.snapshot.failure !== undefined;
      const succeeded =
        validation.valid &&
        !state.digestMismatch &&
        !state.timedOut &&
        !state.cancelled &&
        state.backendStatus === "succeeded";

      if (succeeded) {
        const summary =
          state.snapshot.resultEnvelope !== undefined &&
          typeof state.snapshot.resultEnvelope === "object" &&
          state.snapshot.resultEnvelope !== null &&
          "summary" in state.snapshot.resultEnvelope &&
          typeof (state.snapshot.resultEnvelope as { summary: unknown }).summary === "string"
            ? (state.snapshot.resultEnvelope as { summary: string }).summary
            : undefined;
        const cleaned = (
          summary === undefined
            ? {
                schemaVersion: 1 as const,
                attemptId: asAttemptId(attemptId),
                outcome: "succeeded" as const,
                outputs: state.snapshot.outputs,
                evidence: state.snapshot.evidence,
                finishedAt,
                artifactPath: state.executionRequest.artifactPath,
              }
            : {
                schemaVersion: 1 as const,
                attemptId: asAttemptId(attemptId),
                outcome: "succeeded" as const,
                outputs: state.snapshot.outputs,
                evidence: state.snapshot.evidence,
                finishedAt,
                artifactPath: state.executionRequest.artifactPath,
                summary,
              }
        ) as StageRunnerResult;
        state.snapshot.phase = "succeeded";
        state.snapshot.result = cleaned;
        state.snapshot.finishedAt = finishedAt;
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        return {
          result: cleaned,
          validation,
          ...(state.cleanup === undefined ? {} : { cleanup: state.cleanup }),
        };
      }

      const classification = state.cancelled
        ? ("cancelled" as const)
        : state.timedOut
          ? ("timeout" as const)
          : state.digestMismatch
            ? ("validation_failed" as const)
            : backendFailed
              ? ("backend_failed" as const)
              : ("validation_failed" as const);
      const outcome = state.cancelled
        ? ("cancelled" as const)
        : state.snapshot.recovery === "observe_backend"
          ? ("recovery_required" as const)
          : ("failed" as const);

      const failure = (state.snapshot.failure ?? {
        schemaVersion: 1 as const,
        classification,
        phase: "finalize" as const,
        code: classification,
        message: redactFailureMessage(validation.detail ?? "agent stage failed"),
        // Validation failures must remain runner-retryable so §19.6
        // on_validation_failure repair strategies can apply (ADR 0026 D2/D4).
        retryable: classification === "timeout" || classification === "validation_failed",
        recovery: state.snapshot.recovery,
      }) as StageRunnerFailure;

      const result = {
        schemaVersion: 1 as const,
        attemptId: asAttemptId(attemptId),
        outcome,
        outputs: state.snapshot.outputs,
        evidence: state.snapshot.evidence,
        failure,
        finishedAt,
        artifactPath: state.executionRequest.artifactPath,
      } as StageRunnerResult;
      state.snapshot.phase =
        outcome === "cancelled"
          ? "cancelled"
          : outcome === "recovery_required"
            ? "recovery_required"
            : "failed";
      state.snapshot.result = result;
      state.snapshot.failure = failure;
      state.snapshot.finishedAt = finishedAt;
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
      return {
        result,
        validation,
        ...(state.cleanup === undefined ? {} : { cleanup: state.cleanup }),
      };
    },
  };
}
