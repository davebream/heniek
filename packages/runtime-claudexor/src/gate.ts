import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeChildEnvironment } from "./environment.js";
import { ClaudexorRuntimeError } from "./errors.js";
import { CLAUDEXOR_PROMOTION_SUITE_VERSION, REQUIRED_PROMOTION_CHECKS } from "./manager.js";
import type {
  RuntimeCompatibilityGate,
  RuntimeCompatibilityReport,
  RuntimeIdentity,
} from "./types.js";

interface PromotionRunnerOutput {
  readonly status: "pass" | "fail" | "blocked";
  readonly code?: string;
  readonly checks?: readonly {
    readonly name: string;
    readonly status: "pass" | "fail" | "blocked";
    readonly code?: string;
  }[];
}

export interface CommandCompatibilityGateOptions {
  /** Absolute executable path. It receives only bounded metadata via environment variables. */
  readonly command: string;
  /** Explicit subscription-route values; ambient credentials are never inherited. */
  readonly explicitEnvironment?: NodeJS.ProcessEnv;
  readonly timeoutMilliseconds?: number;
  readonly now?: () => Date;
  readonly nextId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOutput(value: unknown): PromotionRunnerOutput {
  if (!isRecord(value) || !["pass", "fail", "blocked"].includes(String(value.status))) {
    throw new ClaudexorRuntimeError(
      "COMPATIBILITY_BLOCKED",
      "The Claudexor promotion runner returned malformed evidence.",
    );
  }
  const checks = Array.isArray(value.checks)
    ? value.checks.flatMap((check) => {
        if (
          !isRecord(check) ||
          typeof check.name !== "string" ||
          !["pass", "fail", "blocked"].includes(String(check.status))
        ) {
          return [];
        }
        return [
          {
            name: check.name,
            status: check.status as "pass" | "fail" | "blocked",
            ...(typeof check.code === "string" ? { code: check.code.slice(0, 80) } : {}),
          },
        ];
      })
    : undefined;
  return {
    status: value.status as PromotionRunnerOutput["status"],
    ...(typeof value.code === "string" ? { code: value.code.slice(0, 80) } : {}),
    ...(checks === undefined ? {} : { checks }),
  };
}

async function shortTemporaryHome(): Promise<string> {
  const root = process.platform === "win32" ? tmpdir() : await realpath("/tmp");
  return mkdtemp(join(root, "heniek-runtime-gate-"));
}

async function executeRunner(
  options: CommandCompatibilityGateOptions,
  identity: RuntimeIdentity,
  isolatedHome: string,
): Promise<PromotionRunnerOutput> {
  if (!options.command.startsWith("/")) {
    throw new ClaudexorRuntimeError(
      "COMPATIBILITY_BLOCKED",
      "The Claudexor promotion runner must be an absolute executable path.",
    );
  }
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 30 * 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, [], {
      env: {
        ...buildRuntimeChildEnvironment({
          home: isolatedHome,
          explicit: options.explicitEnvironment,
        }),
        HOME: isolatedHome,
        HENIEK_RUNTIME_ENTRY: identity.entryPath,
        HENIEK_RUNTIME_VERSION: identity.version,
        HENIEK_RUNTIME_BUILD_SHA: identity.buildSha,
        HENIEK_RUNTIME_PROMOTION_SUITE: String(CLAUDEXOR_PROMOTION_SUITE_VERSION),
      },
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) child.kill("SIGKILL");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMilliseconds);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new ClaudexorRuntimeError(
          "COMPATIBILITY_BLOCKED",
          "The Claudexor promotion runner could not be executed.",
          { cause: error },
        ),
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      try {
        const output = parseOutput(JSON.parse(stdout) as unknown);
        if (code !== 0 && output.status === "pass") {
          reject(
            new ClaudexorRuntimeError(
              "COMPATIBILITY_BLOCKED",
              "The Claudexor promotion runner exited unsuccessfully.",
            ),
          );
          return;
        }
        resolve(output);
      } catch (error) {
        reject(
          error instanceof ClaudexorRuntimeError
            ? error
            : new ClaudexorRuntimeError(
                "COMPATIBILITY_BLOCKED",
                "The Claudexor promotion runner returned malformed evidence.",
                { cause: error },
              ),
        );
      }
    });
  });
}

export function createCommandCompatibilityGate(
  options: CommandCompatibilityGateOptions,
): RuntimeCompatibilityGate {
  const now = options.now ?? (() => new Date());
  const nextId = options.nextId ?? randomUUID;
  return {
    async run(identity): Promise<RuntimeCompatibilityReport> {
      const isolatedHome = await shortTemporaryHome();
      try {
        const output = await executeRunner(options, identity, isolatedHome);
        if (
          output.status === "blocked" &&
          (output.code === "CREDENTIAL_ROUTE_BLOCKED" ||
            output.checks?.some((check) => check.code === "CREDENTIAL_ROUTE_BLOCKED") === true)
        ) {
          throw new ClaudexorRuntimeError(
            "CREDENTIAL_ROUTE_BLOCKED",
            "A required subscription credential route is unavailable for the promotion suite.",
          );
        }
        const received = new Map((output.checks ?? []).map((check) => [check.name, check]));
        const checks = REQUIRED_PROMOTION_CHECKS.map((name) => {
          const observed = received.get(name);
          const status = observed?.status ?? "blocked";
          return {
            name,
            status,
            message:
              observed?.code === undefined
                ? `${name} ${status}.`
                : `${name} ${status} (${observed.code}).`,
          };
        });
        return {
          schemaVersion: 1,
          reportId: nextId(),
          runtime: identity,
          suiteVersion: CLAUDEXOR_PROMOTION_SUITE_VERSION,
          status: checks.every((check) => check.status === "pass")
            ? output.status
            : checks.some((check) => check.status === "fail")
              ? "fail"
              : "blocked",
          checks,
          completedAt: now().toISOString(),
        };
      } finally {
        await rm(isolatedHome, { recursive: true, force: true });
      }
    },
  };
}

export function createBlockedCompatibilityGate(): RuntimeCompatibilityGate {
  return {
    async run() {
      throw new ClaudexorRuntimeError(
        "COMPATIBILITY_BLOCKED",
        "Configure the local Claudexor promotion runner before activating a runtime.",
      );
    },
  };
}
