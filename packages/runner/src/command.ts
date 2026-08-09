/**
 * Command stage runner — argv/cwd/env without shell interpolation.
 */

import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  CommandStageRunnerDeps,
  StageRunner,
  StageRunnerAttemptSnapshot,
  StageRunnerCleanupReport,
  StageRunnerFailure,
  StageRunnerFinalizeOutcome,
  StageRunnerObserveOutcome,
  StageRunnerPrepareInput,
  StageRunnerPrepareOutcome,
  StageRunnerResult,
  StageRunnerValidationReport,
} from "./types.js";
import { validateStageCompletion } from "./validate.js";

interface CommandAttemptState {
  readonly snapshot: StageRunnerAttemptSnapshot;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly writes: readonly string[];
  readonly requirements: NonNullable<StageRunnerPrepareInput["stage"]["completion"]>["require"];
  handle?: SpawnCommandHandle;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  exited: boolean;
  timedOut: boolean;
  cancelled: boolean;
  cleanup?: StageRunnerCleanupReport;
  validation?: StageRunnerValidationReport;
}

function looksLikeArtifactPath(write: string): boolean {
  if (isAbsolute(write) || write.includes("\0") || write.split(/[\\/]/u).includes("..")) {
    return false;
  }
  // Relative path with a separator or a file-ish suffix under the checkout.
  return write.includes("/") || /\.[A-Za-z0-9]+$/u.test(write);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function createCommandStageRunner(deps: CommandStageRunnerDeps = {}): StageRunner {
  const clock = deps.clock ?? systemClock;
  const gracePeriodMs = deps.gracePeriodMs ?? 5_000;
  const spawn = deps.spawn ?? defaultSpawn;
  const terminate = deps.terminate ?? defaultTerminate;
  const attempts = new Map<string, CommandAttemptState>();

  function requireAttempt(attemptId: string): CommandAttemptState {
    const state = attempts.get(attemptId);
    if (state === undefined) {
      throw new Error(`unknown command attempt: ${attemptId}`);
    }
    return state;
  }

  return {
    async prepare(input: StageRunnerPrepareInput): Promise<StageRunnerPrepareOutcome> {
      if (input.stage.type !== "command") {
        throw new Error("createCommandStageRunner only accepts command stages");
      }
      const command = input.stage.command;
      if (command === undefined || command.argv.length === 0) {
        throw new Error("command stage requires a non-empty argv");
      }
      if (input.checkoutPath === undefined) {
        throw new Error("command stage requires a checkoutPath");
      }
      const checkoutPath = input.checkoutPath;

      let cwd: string;
      try {
        cwd = resolveCommandCwd(checkoutPath, command.cwd);
      } catch (error) {
        if (error instanceof InvalidCommandCwdError) throw error;
        throw error;
      }

      const env = buildCommandEnv(command.env === undefined ? {} : { declared: command.env });
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
        stageType: "command",
        intentId: input.intentId,
        graphRevision: input.graphRevision,
        generation: input.generation,
        attemptOrdinal: input.attemptOrdinal,
        phase: "prepare",
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
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

      const state: CommandAttemptState = {
        snapshot,
        argv: [...command.argv],
        cwd,
        env,
        writes: [...input.stage.writes],
        requirements: input.stage.completion?.require ?? [],
        exited: false,
        timedOut: false,
        cancelled: false,
      };
      attempts.set(input.attemptId, state);
      await notifyStore(deps.store, snapshot);

      return {
        attemptId: input.attemptId,
        preparedAt: now,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        checkoutPath,
        runtimeDirectory: input.runtimeDirectory,
        argv: state.argv,
        cwd: state.cwd,
        env: state.env,
      };
    },

    async start(attemptId: string): Promise<void> {
      const state = requireAttempt(attemptId);
      const handle = await spawn({
        argv: state.argv,
        cwd: state.cwd,
        env: state.env,
        runtimeDirectory: state.snapshot.runtimeDirectory!,
      });
      state.handle = handle;
      state.snapshot.phase = "start";
      state.snapshot.processGroupId = handle.processGroupId;
      state.snapshot.startedAt = clock.nowIso();
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);

      void handle.exit.then((result) => {
        state.exited = true;
        state.exitCode = result.code;
        state.exitSignal = result.signal;
      });

      state.snapshot.phase = "observe";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
    },

    async observe(attemptId: string): Promise<StageRunnerObserveOutcome> {
      const state = requireAttempt(attemptId);
      state.snapshot.phase = "observe";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);

      const deadlineAt = state.snapshot.deadlineAt;
      if (
        !state.exited &&
        !state.timedOut &&
        deadlineAt !== undefined &&
        clock.nowIso() >= deadlineAt
      ) {
        state.timedOut = true;
        const cleanup = await terminate({
          attemptId,
          processGroupId: state.snapshot.processGroupId!,
          gracePeriodMs,
          nowIso: () => clock.nowIso(),
        });
        state.cleanup = cleanup;
        state.snapshot.cleanup = cleanup;
        state.snapshot.recovery = cleanup.cleaned ? "none" : "reap_process";
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        await deps.store?.onCleanup?.(cleanup);
        return { status: "timed_out", cleanup };
      }

      if (state.exited) {
        return {
          status: "exited",
          exitCode: state.exitCode ?? null,
          signal: state.exitSignal ?? null,
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

      const processGroupId = state.snapshot.processGroupId;
      if (processGroupId === undefined) {
        const report: StageRunnerCleanupReport = {
          schemaVersion: 1,
          attemptId: asAttemptId(attemptId),
          signalSequence: [],
          descendantsRemaining: 0,
          gracePeriodMs,
          cleaned: true,
          recordedAt: clock.nowIso(),
          detail: "no process group to terminate",
        };
        state.cleanup = report;
        state.snapshot.cleanup = report;
        await deps.store?.onCleanup?.(report);
        return report;
      }

      const cleanup = await terminate({
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
      const now = clock.nowIso();
      const checkout = state.snapshot.checkoutPath!;
      const runtimeDirectory = state.snapshot.runtimeDirectory!;

      // Ensure exit is settled when the process already finished.
      if (state.handle !== undefined && !state.exited) {
        // Do not block forever — observe/cancel should have terminated first.
        const raced = await Promise.race([
          state.handle.exit.then((result) => ({ kind: "exit" as const, result })),
          new Promise<{ kind: "timeout" }>((resolve) =>
            setTimeout(() => resolve({ kind: "timeout" }), 10),
          ),
        ]);
        if (raced.kind === "exit") {
          state.exited = true;
          state.exitCode = raced.result.code;
          state.exitSignal = raced.result.signal;
        }
      }

      const exitCode = state.exitCode ?? (state.timedOut || state.cancelled ? 1 : undefined);
      if (typeof exitCode === "number") {
        state.snapshot.exitCode = exitCode;
        state.snapshot.evidence = [
          ...state.snapshot.evidence,
          {
            schemaVersion: 1,
            kind: "exit_code",
            satisfied: true,
            recordedAt: now,
            payload: { exitCode },
            detail: `exit code ${exitCode}`,
          },
        ];
      }

      // Capture log presence as process_cleanup evidence when we cleaned.
      if (state.cleanup !== undefined) {
        state.snapshot.evidence = [
          ...state.snapshot.evidence,
          {
            schemaVersion: 1,
            kind: "process_cleanup",
            satisfied: state.cleanup.cleaned,
            recordedAt: now,
            payload: {
              cleaned: state.cleanup.cleaned,
              descendantsRemaining: state.cleanup.descendantsRemaining,
            },
          },
        ];
      }

      // Best-effort: bind writes that look like relative artifact paths when the file exists.
      const outputs = [...state.snapshot.outputs];
      for (const write of state.writes) {
        if (!looksLikeArtifactPath(write)) continue;
        if (outputs.some((binding) => binding.reference === write)) continue;
        const absolute = resolve(checkout, write);
        const rel = relative(checkout, absolute);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        if (!(await fileExists(absolute))) continue;
        outputs.push({
          schemaVersion: 1,
          reference: write,
          kind: "artifact",
          relativePath: rel,
        });
      }

      // Optional result envelope beside the runtime logs (never written into the registered repo by us).
      const envelopePath = join(runtimeDirectory, "result.json");
      if (await fileExists(envelopePath)) {
        try {
          const raw = JSON.parse(await readFile(envelopePath, "utf8")) as unknown;
          state.snapshot.resultEnvelope = raw;
          if (
            raw !== null &&
            typeof raw === "object" &&
            "artifactPath" in raw &&
            typeof (raw as { artifactPath: unknown }).artifactPath === "string"
          ) {
            const artifactPath = (raw as { artifactPath: string }).artifactPath;
            state.snapshot.evidence = [
              ...state.snapshot.evidence,
              {
                schemaVersion: 1,
                kind: "result_envelope",
                satisfied: true,
                recordedAt: now,
              },
            ];
            for (const write of state.writes) {
              if (outputs.some((binding) => binding.reference === write)) continue;
              if (write.startsWith("artifacts.") || looksLikeArtifactPath(write)) {
                const absolute = resolve(checkout, artifactPath);
                if (await fileExists(absolute)) {
                  outputs.push({
                    schemaVersion: 1,
                    reference: write,
                    kind: "artifact",
                    relativePath: artifactPath,
                  });
                }
              }
            }
          }
        } catch {
          // Malformed envelope is left for validate to reject.
        }
      }

      state.snapshot.outputs = outputs;
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
    },

    async validate(attemptId: string): Promise<StageRunnerValidationReport> {
      const state = requireAttempt(attemptId);
      state.snapshot.phase = "validate";
      const report = validateStageCompletion({
        attemptId,
        writes: state.writes,
        requirements: state.requirements,
        outputs: state.snapshot.outputs,
        evidence: state.snapshot.evidence,
        resultEnvelope: state.snapshot.resultEnvelope,
        exitCode: state.snapshot.exitCode,
        recordedAt: clock.nowIso(),
      });
      state.validation = report;
      state.snapshot.validation = report;
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
      await deps.store?.onValidation?.(report);
      return report;
    },

    async finalize(attemptId: string): Promise<StageRunnerFinalizeOutcome> {
      const state = requireAttempt(attemptId);
      state.snapshot.phase = "finalize";
      const validation =
        state.validation ??
        (await (async () => {
          const report = validateStageCompletion({
            attemptId,
            writes: state.writes,
            requirements: state.requirements,
            outputs: state.snapshot.outputs,
            evidence: state.snapshot.evidence,
            resultEnvelope: state.snapshot.resultEnvelope,
            exitCode: state.snapshot.exitCode,
            recordedAt: clock.nowIso(),
          });
          state.validation = report;
          state.snapshot.validation = report;
          return report;
        })());

      const finishedAt = clock.nowIso();
      const exitCode = state.snapshot.exitCode;
      const nonZero = typeof exitCode === "number" && exitCode !== 0;
      const succeeded = validation.valid && !nonZero && !state.timedOut && !state.cancelled;

      if (succeeded) {
        const result = {
          schemaVersion: 1 as const,
          attemptId: asAttemptId(attemptId),
          outcome: "succeeded" as const,
          outputs: state.snapshot.outputs,
          evidence: state.snapshot.evidence,
          finishedAt,
          ...(typeof exitCode === "number" ? { exitCode } : {}),
        } as StageRunnerResult;
        state.snapshot.phase = "succeeded";
        state.snapshot.result = result;
        state.snapshot.finishedAt = finishedAt;
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        return {
          result,
          validation,
          ...(state.cleanup === undefined ? {} : { cleanup: state.cleanup }),
        };
      }

      const classification = state.cancelled
        ? ("cancelled" as const)
        : state.timedOut
          ? ("timeout" as const)
          : nonZero
            ? ("process_failed" as const)
            : ("validation_failed" as const);
      const outcome = state.cancelled
        ? ("cancelled" as const)
        : state.snapshot.recovery !== "none" &&
            state.cleanup !== undefined &&
            !state.cleanup.cleaned
          ? ("recovery_required" as const)
          : ("failed" as const);

      const failure = {
        schemaVersion: 1 as const,
        classification,
        phase: "finalize" as const,
        code: classification,
        message: redactFailureMessage(
          validation.detail ??
            (nonZero ? `command exited with code ${exitCode}` : "stage validation failed"),
        ),
        retryable: classification === "timeout",
        recovery: state.snapshot.recovery,
      } as StageRunnerFailure;

      const result = {
        schemaVersion: 1 as const,
        attemptId: asAttemptId(attemptId),
        outcome,
        outputs: state.snapshot.outputs,
        evidence: state.snapshot.evidence,
        failure,
        finishedAt,
        ...(typeof exitCode === "number" ? { exitCode } : {}),
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
