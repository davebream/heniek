/**
 * Verify stage runner — ordered argv checks without shell interpolation.
 */

import type { VerifyCheckEvidenceV1, VerifyResultV1 } from "@heniek/contracts";
import { bump, notifyStore, systemClock } from "./attempt.js";
import { asAttemptId } from "./brands.js";
import { InvalidCommandCwdError, resolveCommandCwd } from "./cwd.js";
import { buildCommandEnv } from "./env.js";
import {
  spawnCommand as defaultSpawn,
  terminateProcessGroup as defaultTerminate,
  type SpawnCommandHandle,
} from "./process.js";
import { redactFailureMessage } from "./redact.js";
import type {
  StageRunner,
  StageRunnerAttemptSnapshot,
  StageRunnerCleanupReport,
  StageRunnerFinalizeOutcome,
  StageRunnerObserveOutcome,
  StageRunnerPrepareInput,
  StageRunnerPrepareOutcome,
  StageRunnerResult,
  StageRunnerValidationReport,
  VerifyRequest,
  VerifyStageRunnerDeps,
} from "./types.js";
import { validateStageCompletion } from "./validate.js";

interface VerifyAttemptState {
  readonly snapshot: StageRunnerAttemptSnapshot;
  readonly request: VerifyRequest;
  readonly checkoutPath: string;
  readonly writes: readonly string[];
  readonly requirements: NonNullable<StageRunnerPrepareInput["stage"]["completion"]>["require"];
  malformed: boolean;
  malformedDetail?: string;
  started: boolean;
  work?: Promise<void>;
  activeHandle?: SpawnCommandHandle;
  checkEvidence: VerifyCheckEvidenceV1[];
  verifyResult?: VerifyResultV1;
  timedOut: boolean;
  cancelled: boolean;
  cleanup?: StageRunnerCleanupReport;
  validation?: StageRunnerValidationReport;
}

function emptyCleanup(
  attemptId: string,
  nowIso: string,
  detail?: string,
): StageRunnerCleanupReport {
  return {
    schemaVersion: 1,
    attemptId: asAttemptId(attemptId),
    signalSequence: [],
    descendantsRemaining: 0,
    gracePeriodMs: 0,
    cleaned: true,
    recordedAt: nowIso,
    ...(detail === undefined ? {} : { detail }),
  };
}

function isMalformedRequest(request: VerifyRequest): string | undefined {
  if (request.checks.length === 0) {
    return "verify request requires at least one check";
  }
  for (const check of request.checks) {
    if (check.argv.length === 0) {
      return `verify check ${check.checkId} requires a non-empty argv`;
    }
    if (check.argv.some((part) => part.length === 0)) {
      return `verify check ${check.checkId} contains an empty argv element`;
    }
  }
  return undefined;
}

export function createVerifyStageRunner(deps: VerifyStageRunnerDeps = {}): StageRunner {
  const clock = deps.clock ?? systemClock;
  const gracePeriodMs = deps.gracePeriodMs ?? 5_000;
  const spawn = deps.spawn ?? defaultSpawn;
  const terminate = deps.terminate ?? defaultTerminate;
  const attempts = new Map<string, VerifyAttemptState>();

  function requireAttempt(attemptId: string): VerifyAttemptState {
    const state = attempts.get(attemptId);
    if (state === undefined) {
      throw new Error(`unknown verify attempt: ${attemptId}`);
    }
    return state;
  }

  async function runChecks(state: VerifyAttemptState): Promise<void> {
    if (state.malformed) {
      state.verifyResult = {
        schemaVersion: 1,
        verdict: "malformed",
        checks: [],
        finishedAt: clock.nowIso(),
        detail: state.malformedDetail ?? "malformed verify contract",
      };
      return;
    }

    const evidence: VerifyCheckEvidenceV1[] = [];
    for (const check of state.request.checks) {
      if (state.cancelled || state.timedOut) {
        break;
      }

      let cwd: string;
      try {
        cwd = resolveCommandCwd(state.checkoutPath, check.cwd);
      } catch (error) {
        const detail =
          error instanceof InvalidCommandCwdError ? error.message : "invalid verify check cwd";
        state.verifyResult = {
          schemaVersion: 1,
          verdict: "malformed",
          checks: evidence,
          finishedAt: clock.nowIso(),
          detail,
        };
        state.checkEvidence = evidence;
        return;
      }

      const env = buildCommandEnv(check.env === undefined ? {} : { declared: check.env });
      const startedAt = clock.nowIso();
      const handle = await spawn({
        argv: check.argv,
        cwd,
        env,
        runtimeDirectory: state.snapshot.runtimeDirectory!,
      });
      state.activeHandle = handle;
      state.snapshot.processGroupId = handle.processGroupId;
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);

      const exit = await handle.exit;
      delete state.activeHandle;
      const finishedAt = clock.nowIso();
      const exitCode = exit.code ?? 1;
      const satisfied = exitCode === check.expectedExitCode;
      evidence.push({
        schemaVersion: 1,
        checkId: check.checkId,
        argv: [...check.argv],
        exitCode,
        expectedExitCode: check.expectedExitCode,
        satisfied,
        required: check.required,
        startedAt,
        finishedAt,
        ...(satisfied ? {} : { detail: `exit ${exitCode} != expected ${check.expectedExitCode}` }),
      });

      if (state.cancelled || state.timedOut) {
        break;
      }
      if (check.required && !satisfied) {
        // Continue remaining checks only when not cancelled; still record failure.
        // Spec: succeeds only if every required check matches — keep running optional
        // checks for evidence, stop early on required failure to save work.
        const remainingOptional = state.request.checks
          .slice(evidence.length)
          .every((c) => !c.required);
        if (!remainingOptional) {
          // Still run remaining for full evidence? Prefer stop on first required failure.
          break;
        }
      }
    }

    state.checkEvidence = evidence;
    const finishedAt = clock.nowIso();
    if (state.cancelled) {
      state.verifyResult = {
        schemaVersion: 1,
        verdict: "cancelled",
        checks: evidence,
        finishedAt,
        detail: "verify cancelled mid-checks",
      };
      return;
    }
    if (state.timedOut) {
      state.verifyResult = {
        schemaVersion: 1,
        verdict: "cancelled",
        checks: evidence,
        finishedAt,
        detail: "verify timed out mid-checks",
      };
      return;
    }

    const allRan = evidence.length === state.request.checks.length;
    const requiredOk = evidence.every((item) => !item.required || item.satisfied);
    const passed = allRan && requiredOk;
    state.verifyResult = {
      schemaVersion: 1,
      verdict: passed ? "passed" : "failed",
      checks: evidence,
      finishedAt,
      ...(passed
        ? {}
        : { detail: allRan ? "one or more required checks failed" : "not all checks ran" }),
    };
  }

  async function validateAttempt(attemptId: string): Promise<StageRunnerValidationReport> {
    const state = requireAttempt(attemptId);
    state.snapshot.phase = "validate";
    const report = validateStageCompletion({
      attemptId,
      writes: state.writes,
      requirements: state.requirements,
      outputs: state.snapshot.outputs,
      evidence: state.snapshot.evidence,
      resultEnvelope: state.snapshot.resultEnvelope,
      exitCode: undefined,
      recordedAt: clock.nowIso(),
    });
    state.validation = report;
    state.snapshot.validation = report;
    bump(state.snapshot, clock);
    await notifyStore(deps.store, state.snapshot);
    await deps.store?.onValidation?.(report);
    return report;
  }

  return {
    async prepare(input: StageRunnerPrepareInput): Promise<StageRunnerPrepareOutcome> {
      if (input.stage.type !== "verify") {
        throw new Error("createVerifyStageRunner only accepts verify stages");
      }
      const request = input.verifyRequest;
      if (request === undefined) {
        throw new Error("verify stage requires verifyRequest");
      }
      if (input.checkoutPath === undefined) {
        throw new Error("verify stage requires checkoutPath");
      }

      const malformedDetail = isMalformedRequest(request);
      const now = clock.nowIso();
      let deadlineAt = input.deadlineAt;
      const maxDurationMs = input.stage.limits?.maxDurationMs;
      if (maxDurationMs !== undefined) {
        const fromLimits = new Date(Date.parse(now) + maxDurationMs).toISOString();
        if (deadlineAt === undefined || fromLimits < deadlineAt) deadlineAt = fromLimits;
      }

      const snapshot: StageRunnerAttemptSnapshot = {
        attemptId: input.attemptId,
        runId: input.runId,
        stageId: input.stageId,
        stageType: "verify",
        intentId: input.intentId,
        graphRevision: input.graphRevision,
        generation: input.generation,
        attemptOrdinal: input.attemptOrdinal,
        phase: "prepare",
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
        checkoutPath: input.checkoutPath,
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

      attempts.set(input.attemptId, {
        snapshot,
        request,
        checkoutPath: input.checkoutPath,
        writes: [...input.stage.writes],
        requirements: input.stage.completion?.require ?? [],
        malformed: malformedDetail !== undefined,
        ...(malformedDetail === undefined ? {} : { malformedDetail }),
        started: false,
        checkEvidence: [],
        timedOut: false,
        cancelled: false,
      });
      await notifyStore(deps.store, snapshot);

      return {
        attemptId: input.attemptId,
        preparedAt: now,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        checkoutPath: input.checkoutPath,
        runtimeDirectory: input.runtimeDirectory,
      };
    },

    async start(attemptId: string): Promise<void> {
      const state = requireAttempt(attemptId);
      state.started = true;
      state.snapshot.phase = "start";
      state.snapshot.startedAt = clock.nowIso();
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);

      state.work = runChecks(state);
      state.snapshot.phase = "observe";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
    },

    async observe(attemptId: string): Promise<StageRunnerObserveOutcome> {
      const state = requireAttempt(attemptId);
      state.snapshot.phase = "observe";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);

      if (state.snapshot.result !== undefined) {
        const outcome = state.snapshot.result.outcome;
        if (outcome === "succeeded") return { status: "terminal", backendStatus: "succeeded" };
        if (outcome === "cancelled") return { status: "terminal", backendStatus: "cancelled" };
        return { status: "terminal", backendStatus: "failed" };
      }

      const deadlineAt = state.snapshot.deadlineAt;
      if (
        !state.timedOut &&
        !state.cancelled &&
        deadlineAt !== undefined &&
        clock.nowIso() >= deadlineAt
      ) {
        state.timedOut = true;
        state.cancelled = true;
        const processGroupId = state.snapshot.processGroupId;
        const cleanup =
          processGroupId === undefined
            ? emptyCleanup(attemptId, clock.nowIso(), "verify timed out")
            : await terminate({
                attemptId,
                processGroupId,
                gracePeriodMs,
                nowIso: () => clock.nowIso(),
              });
        state.cleanup = cleanup;
        state.snapshot.cleanup = cleanup;
        state.snapshot.recovery = cleanup.cleaned ? "none" : "reap_process";
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        await deps.store?.onCleanup?.(cleanup);
        if (state.work !== undefined) {
          await state.work.catch(() => undefined);
        }
        return { status: "timed_out", cleanup };
      }

      if (state.work !== undefined) {
        const raced = await Promise.race([
          state.work.then(() => "done" as const),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
        ]);
        if (raced === "pending") {
          return { status: "running" };
        }
      }

      const verifyResult = state.verifyResult;
      if (verifyResult !== undefined) {
        if (verifyResult.verdict === "passed") {
          return { status: "terminal", backendStatus: "succeeded" };
        }
        if (verifyResult.verdict === "cancelled" || state.cancelled) {
          return { status: "terminal", backendStatus: "cancelled" };
        }
        return { status: "terminal", backendStatus: "failed" };
      }

      return { status: "running" };
    },

    async cancel(attemptId: string): Promise<StageRunnerCleanupReport> {
      const state = requireAttempt(attemptId);
      state.cancelled = true;
      state.snapshot.phase = "cancel";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);

      const processGroupId = state.snapshot.processGroupId;
      const cleanup =
        processGroupId === undefined
          ? emptyCleanup(attemptId, clock.nowIso(), "no process group to terminate")
          : await terminate({
              attemptId,
              processGroupId,
              gracePeriodMs,
              nowIso: () => clock.nowIso(),
            });
      state.cleanup = cleanup;
      state.snapshot.cleanup = cleanup;
      state.snapshot.recovery = cleanup.cleaned ? "none" : "reap_process";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
      await deps.store?.onCleanup?.(cleanup);
      return cleanup;
    },

    async collect(attemptId: string): Promise<void> {
      const state = requireAttempt(attemptId);
      state.snapshot.phase = "collect";
      if (state.work !== undefined) {
        await state.work.catch(() => undefined);
      }
      const now = clock.nowIso();
      const evidence = [...state.snapshot.evidence];
      const outputs = [...state.snapshot.outputs];
      const result = state.verifyResult;

      for (const check of state.checkEvidence) {
        evidence.push({
          schemaVersion: 1,
          kind: "command",
          satisfied: check.satisfied,
          recordedAt: check.finishedAt,
          requirement: check.checkId,
          ...(check.detail === undefined ? {} : { detail: check.detail }),
          payload: check,
        });
      }

      if (result !== undefined) {
        evidence.push({
          schemaVersion: 1,
          kind: "verdict",
          satisfied: result.verdict === "passed",
          recordedAt: now,
          requirement: "verify",
          detail: result.verdict,
          payload: result,
        });
        outputs.push({
          schemaVersion: 1,
          reference: "verify.result",
          kind: "value",
          value: result,
        });
      }

      state.snapshot.evidence = evidence;
      state.snapshot.outputs = outputs;
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
      const result = state.verifyResult;
      const succeeded =
        result?.verdict === "passed" &&
        !state.cancelled &&
        !state.timedOut &&
        !state.malformed &&
        validation.valid;

      if (succeeded) {
        const terminal = {
          schemaVersion: 2 as const,
          attemptId: asAttemptId(attemptId),
          outcome: "succeeded" as const,
          outputs: state.snapshot.outputs,
          evidence: state.snapshot.evidence,
          finishedAt,
          summary: "verify:passed",
        } as StageRunnerResult;
        state.snapshot.phase = "succeeded";
        state.snapshot.result = terminal;
        state.snapshot.finishedAt = finishedAt;
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        return {
          result: terminal,
          validation,
          ...(state.cleanup === undefined ? {} : { cleanup: state.cleanup }),
        };
      }

      const classification =
        state.malformed || result?.verdict === "malformed"
          ? ("malformed_contract" as const)
          : state.cancelled && !state.timedOut
            ? ("cancelled" as const)
            : state.timedOut
              ? ("timeout" as const)
              : result?.verdict === "failed"
                ? ("process_failed" as const)
                : ("validation_failed" as const);

      const failure = {
        schemaVersion: 2 as const,
        classification,
        phase: "finalize" as const,
        code: classification,
        message: redactFailureMessage(result?.detail ?? validation.detail ?? "verify stage failed"),
        retryable: classification === "timeout",
        recovery: state.snapshot.recovery,
      };

      const outcome =
        classification === "cancelled"
          ? ("cancelled" as const)
          : state.snapshot.recovery !== "none" &&
              state.cleanup !== undefined &&
              !state.cleanup.cleaned
            ? ("recovery_required" as const)
            : ("failed" as const);

      const terminal = {
        schemaVersion: 2 as const,
        attemptId: asAttemptId(attemptId),
        outcome,
        outputs: state.snapshot.outputs,
        evidence: state.snapshot.evidence,
        failure,
        finishedAt,
      } as StageRunnerResult;

      state.snapshot.phase =
        outcome === "cancelled"
          ? "cancelled"
          : outcome === "recovery_required"
            ? "recovery_required"
            : "failed";
      state.snapshot.result = terminal;
      state.snapshot.failure = failure;
      state.snapshot.finishedAt = finishedAt;
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
      return {
        result: terminal,
        validation,
        ...(state.cleanup === undefined ? {} : { cleanup: state.cleanup }),
      };
    },
  };
}
