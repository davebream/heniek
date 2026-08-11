import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  CombinedVerificationReport,
  RepositoryId,
  VerifyCheckV1,
  WorkspaceCleanupResult,
  WorkspaceId,
  WorkspaceRecoveryDecisionTrace,
  WorkspaceRecoveryPhase,
  WorkspaceVariantId,
} from "@heniek/contracts";
import { WorkspaceError } from "./errors.js";

const execFileAsync = promisify(execFile);
const DEFAULT_VERIFY_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000;
const MAX_VERIFY_LOG_BYTES = 4 * 1024 * 1024;

const RECOVERY_PHASES = [
  "provisioning",
  "setup",
  "leases",
  "processes",
  "artifacts",
  "integration-refs",
] as const satisfies readonly WorkspaceRecoveryPhase[];

export interface VerificationCommandResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly output: string;
}

export interface VerificationCommandExecutor {
  run(input: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMilliseconds: number;
  }): Promise<VerificationCommandResult>;
}

export interface CombinedVerificationInput {
  readonly reportId: string;
  readonly workspaceId: WorkspaceId;
  readonly variantId: WorkspaceVariantId;
  readonly repositories: readonly {
    readonly repositoryId: RepositoryId;
    readonly checkoutPath: string;
    readonly checks: readonly VerifyCheckV1[];
  }[];
  readonly wholeCodebaseChecks: readonly {
    readonly cwd: string;
    readonly check: VerifyCheckV1;
  }[];
  readonly timeoutMilliseconds?: number;
}

export interface RecoveryPhaseObservation {
  readonly phase: WorkspaceRecoveryPhase;
  readonly state: "complete" | "not-started" | "in-progress" | "missing" | "ambiguous";
  readonly ownership: "heniek" | "external" | "unknown";
  readonly resumeSafe: boolean;
  readonly retrySafe: boolean;
  readonly detail: string;
}

export interface ReconcileCompositeOperationInput {
  readonly workspaceId: WorkspaceId;
  readonly variantId: WorkspaceVariantId;
  readonly observations: readonly RecoveryPhaseObservation[];
}

export interface LifecycleEvidenceArchive {
  archive(input: {
    readonly workspaceId: WorkspaceId;
    readonly variantId: WorkspaceVariantId;
    readonly evidence: unknown;
  }): Promise<{ readonly path: string; readonly sha256: string }>;
}

export interface CleanupCompositeVariantInput {
  readonly workspaceId: WorkspaceId;
  readonly variantId: WorkspaceVariantId;
  readonly workspaceRoot: string;
  readonly variantRoot: string;
  readonly operationState: "running" | "recovery-required" | "succeeded" | "failed" | "cancelled";
  readonly checkoutOwnership: "heniek-managed" | "adopted" | "user-owned" | "unknown";
  readonly processes: "active" | "terminated" | "absent" | "unknown";
  readonly leases: "active" | "released" | "absent" | "unknown";
  readonly artifactOwnershipVerified: boolean;
  readonly integrationOwnershipVerified: boolean;
  readonly verification: CombinedVerificationReport | null;
  readonly recovery: WorkspaceRecoveryDecisionTrace;
  readonly additionalEvidence: unknown;
}

export interface CompositeLifecycleService {
  verify(input: CombinedVerificationInput): Promise<CombinedVerificationReport>;
  reconcile(input: ReconcileCompositeOperationInput): WorkspaceRecoveryDecisionTrace;
  cleanup(input: CleanupCompositeVariantInput): Promise<WorkspaceCleanupResult>;
}

export interface CreateCompositeLifecycleServiceInput {
  readonly logsDirectory: string;
  readonly archive: LifecycleEvidenceArchive;
  readonly clock: { nowIso(): string };
  readonly executor?: VerificationCommandExecutor;
  readonly removeCheckout?: (path: string) => Promise<void>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new WorkspaceError("INVALID_PATH", `${label} is not safe for a filesystem path.`);
  }
  return value;
}

function boundedCwd(root: string, requested?: string): string {
  if (!isAbsolute(root)) {
    throw new WorkspaceError("INVALID_PATH", "Verification root must be absolute.");
  }
  const cwd = resolve(root, requested ?? ".");
  const fromRoot = relative(resolve(root), cwd);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new WorkspaceError("INVALID_PATH", "Verification cwd escapes its repository root.");
  }
  return cwd;
}

function defaultExecutor(): VerificationCommandExecutor {
  return {
    async run(input) {
      const [command, ...args] = input.argv;
      if (command === undefined) {
        return { exitCode: null, timedOut: false, output: "Verification argv is empty.\n" };
      }
      try {
        const result = await execFileAsync(command, args, {
          cwd: input.cwd,
          env: { ...process.env, ...input.env },
          timeout: input.timeoutMilliseconds,
          maxBuffer: MAX_VERIFY_LOG_BYTES,
          encoding: "utf8",
        });
        return { exitCode: 0, timedOut: false, output: `${result.stdout}${result.stderr}` };
      } catch (error) {
        const failure = error as Error & {
          code?: number | string;
          killed?: boolean;
          stdout?: string;
          stderr?: string;
        };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : null,
          timedOut: failure.killed === true,
          output: `${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message}\n`,
        };
      }
    },
  };
}

function recoveryAction(observation: RecoveryPhaseObservation) {
  if (observation.state === "complete") return "confirmed" as const;
  if (
    observation.state === "in-progress" &&
    observation.ownership === "heniek" &&
    observation.resumeSafe
  ) {
    return "resume" as const;
  }
  if (
    observation.state === "not-started" &&
    observation.ownership === "heniek" &&
    observation.retrySafe
  ) {
    return "retry" as const;
  }
  if (observation.state === "ambiguous" || observation.ownership !== "heniek") {
    return "preserve" as const;
  }
  return "operator-action" as const;
}

function pathIsInside(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(fromRoot)
  );
}

export function createFileLifecycleEvidenceArchive(
  archiveDirectory: string,
): LifecycleEvidenceArchive {
  return {
    async archive(input) {
      const content = canonical(input.evidence);
      const digest = sha256(content);
      const path = join(
        archiveDirectory,
        `${safeSegment(input.workspaceId, "workspace id")}-${safeSegment(input.variantId, "variant id")}-${digest}.json`,
      );
      await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
      await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      return { path, sha256: digest };
    },
  };
}

export function createCompositeLifecycleService(
  deps: CreateCompositeLifecycleServiceInput,
): CompositeLifecycleService {
  const executor = deps.executor ?? defaultExecutor();
  const removeCheckout =
    deps.removeCheckout ?? (async (path: string) => rm(path, { recursive: true }));

  return {
    async verify(input) {
      if (input.repositories.length === 0 || input.wholeCodebaseChecks.length === 0) {
        throw new WorkspaceError(
          "INVALID_CONFIGURATION",
          "Combined verification requires repository-local and whole-Codebase checks.",
        );
      }
      const work = [
        ...input.repositories.flatMap((repository) =>
          repository.checks.map((check) => ({
            scope: "repository" as const,
            repositoryId: repository.repositoryId,
            root: repository.checkoutPath,
            check,
          })),
        ),
        ...input.wholeCodebaseChecks.map(({ cwd, check }) => ({
          scope: "whole-codebase" as const,
          repositoryId: null,
          root: cwd,
          check,
        })),
      ];
      if (work.length === 0) {
        throw new WorkspaceError("INVALID_CONFIGURATION", "Combined verification has no checks.");
      }
      const identities = new Set<string>();
      for (const item of work) {
        const identity = `${item.scope}:${item.repositoryId ?? "whole"}:${item.check.checkId}`;
        if (identities.has(identity)) {
          throw new WorkspaceError(
            "INVALID_CONFIGURATION",
            `Duplicate verification check ${identity}.`,
          );
        }
        identities.add(identity);
      }
      const startedAt = deps.clock.nowIso();
      const checks = await Promise.all(
        work.map(async (item, index) => {
          const cwd = boundedCwd(item.root, item.check.cwd);
          const checkStartedAt = deps.clock.nowIso();
          let result: VerificationCommandResult;
          try {
            result = await executor.run({
              argv: item.check.argv,
              cwd,
              env: item.check.env ?? {},
              timeoutMilliseconds: input.timeoutMilliseconds ?? DEFAULT_VERIFY_TIMEOUT_MILLISECONDS,
            });
          } catch (error) {
            result = {
              exitCode: null,
              timedOut: false,
              output: `${error instanceof Error ? error.message : "Verification executor failed."}\n`,
            };
          }
          const logPath = join(
            deps.logsDirectory,
            "verification",
            `${safeSegment(input.reportId, "report id")}-${String(index + 1).padStart(3, "0")}-${safeSegment(item.check.checkId, "check id")}.log`,
          );
          await mkdir(join(deps.logsDirectory, "verification"), { recursive: true, mode: 0o700 });
          await writeFile(logPath, result.output, { encoding: "utf8", mode: 0o600 });
          const outcome: CombinedVerificationReport["checks"][number]["outcome"] = result.timedOut
            ? "timed-out"
            : result.exitCode === null
              ? "execution-error"
              : result.exitCode === item.check.expectedExitCode
                ? "passed"
                : "failed";
          return {
            checkId: item.check.checkId,
            scope: item.scope,
            repositoryId: item.repositoryId,
            argv: [...item.check.argv],
            cwd,
            expectedExitCode: item.check.expectedExitCode,
            actualExitCode: result.exitCode,
            required: item.check.required,
            outcome,
            logPath,
            logSha256: sha256(result.output),
            startedAt: checkStartedAt,
            finishedAt: deps.clock.nowIso(),
          };
        }),
      );
      const requiredFailures = checks.filter(
        (check) => check.required && check.outcome !== "passed",
      );
      return {
        schemaVersion: 1,
        reportId: input.reportId,
        workspaceId: input.workspaceId,
        variantId: input.variantId,
        classification: requiredFailures.length === 0 ? "passed" : "failed",
        checks,
        failedRepositoryIds: [
          ...new Set(
            requiredFailures.flatMap((check) =>
              check.repositoryId === null ? [] : [check.repositoryId],
            ),
          ),
        ].sort(),
        wholeCodebaseFailed: requiredFailures.some((check) => check.scope === "whole-codebase"),
        startedAt,
        finishedAt: deps.clock.nowIso(),
      };
    },

    reconcile(input) {
      const observations = new Map(
        input.observations.map((observation) => [observation.phase, observation]),
      );
      if (
        observations.size !== RECOVERY_PHASES.length ||
        input.observations.length !== RECOVERY_PHASES.length
      ) {
        throw new WorkspaceError(
          "INVALID_CONFIGURATION",
          "Restart reconciliation requires exactly one observation for every phase.",
        );
      }
      const decisions = RECOVERY_PHASES.map((phase, index) => {
        const observation = observations.get(phase);
        if (observation === undefined || observation.detail.length === 0) {
          throw new WorkspaceError(
            "INVALID_CONFIGURATION",
            `Restart reconciliation is missing ${phase} evidence.`,
          );
        }
        return {
          sequence: index + 1,
          phase,
          observedState: observation.state,
          ownership: observation.ownership,
          action: recoveryAction(observation),
          detail: observation.detail,
        };
      });
      return {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        variantId: input.variantId,
        classification: decisions.some(
          (decision) => decision.action === "preserve" || decision.action === "operator-action",
        )
          ? "recovery-required"
          : "reconciled",
        decisions,
        recordedAt: deps.clock.nowIso(),
      };
    },

    async cleanup(input) {
      if (
        input.recovery.workspaceId !== input.workspaceId ||
        input.recovery.variantId !== input.variantId ||
        (input.verification !== null &&
          (input.verification.workspaceId !== input.workspaceId ||
            input.verification.variantId !== input.variantId))
      ) {
        throw new WorkspaceError(
          "WORKSPACE_CONFLICT",
          "Cleanup evidence belongs to a different workspace variant.",
        );
      }
      const archived = await deps.archive.archive({
        workspaceId: input.workspaceId,
        variantId: input.variantId,
        evidence: {
          verification: input.verification,
          recovery: input.recovery,
          additional: input.additionalEvidence,
        },
      });
      const reasons: string[] = [];
      const terminal = ["succeeded", "failed", "cancelled"].includes(input.operationState);
      if (!terminal) reasons.push(`operation state is ${input.operationState}`);
      if (input.checkoutOwnership !== "heniek-managed") {
        reasons.push(`checkout ownership is ${input.checkoutOwnership}`);
      }
      if (!input.artifactOwnershipVerified) reasons.push("artifact ownership is unverified");
      if (!input.integrationOwnershipVerified)
        reasons.push("integration-ref ownership is unverified");
      if (input.operationState === "succeeded" && input.verification === null) {
        reasons.push("successful operation has no combined verification report");
      }
      if (input.processes !== "terminated" && input.processes !== "absent") {
        reasons.push(`process state is ${input.processes}`);
      }
      if (input.leases !== "released" && input.leases !== "absent") {
        reasons.push(`lease state is ${input.leases}`);
      }
      if (input.recovery.classification !== "reconciled") {
        reasons.push("restart reconciliation still requires operator action");
      }
      if (!pathIsInside(input.workspaceRoot, input.variantRoot)) {
        reasons.push("variant checkout is outside its recorded workspace root");
      }

      const preservedOwnership =
        input.checkoutOwnership === "adopted" || input.checkoutOwnership === "user-owned";
      const classification =
        reasons.length === 0 ? "removed" : preservedOwnership ? "preserved" : "recovery-required";
      if (classification === "removed") await removeCheckout(input.variantRoot);
      return {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        variantId: input.variantId,
        classification,
        checkoutPath: input.variantRoot,
        evidenceArchived: true,
        archivePath: archived.path,
        archiveSha256: archived.sha256,
        checkoutRemoved: classification === "removed",
        reasons,
        recordedAt: deps.clock.nowIso(),
      };
    },
  };
}
