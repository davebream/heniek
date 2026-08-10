import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { ExecutionBackendDiagnosticV1 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import type { ClaudexorEngineIdentity } from "./protocol.js";

const execFileAsync = promisify(execFile);
const ISOLATED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export type ClaudexorDiagnosticCategory = "runtime" | "auth-route" | "compatibility";

export type ClaudexorDiagnostic = Static<typeof ExecutionBackendDiagnosticV1> & {
  readonly category: ClaudexorDiagnosticCategory;
};

export interface RawDiagnosticResult {
  readonly exitCode: number | null;
  readonly spawnFailure: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type DiagnosticRunner = (
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
) => Promise<RawDiagnosticResult>;

interface ExecFailure {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
}

function isExecFailure(value: unknown): value is ExecFailure {
  return typeof value === "object" && value !== null;
}

export const runDiagnostic: DiagnosticRunner = async (command, args, environment) => {
  try {
    const result = await execFileAsync(command, args, { env: environment });
    return { exitCode: 0, spawnFailure: false, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!isExecFailure(error)) throw error;
    return {
      exitCode: typeof error.code === "number" ? error.code : null,
      spawnFailure: typeof error.code === "string",
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
};

function isolatedClaudeEnvironment(
  ambient: NodeJS.ProcessEnv,
  configHome: string,
): Readonly<Record<string, string>> {
  const carrier = ambient.CLAUDE_CODE_OAUTH_TOKEN;
  if (carrier === undefined || carrier.length === 0) {
    throw new Error("subscription carrier missing");
  }
  const environment: Record<string, string> = {
    PATH: ISOLATED_PATH,
    HOME: configHome,
    CLAUDE_CONFIG_DIR: configHome,
    CLAUDE_CODE_OAUTH_TOKEN: carrier,
  };
  for (const name of ["LANG", "LC_ALL", "TZ"] as const) {
    const value = ambient[name];
    if (value !== undefined && value.length > 0) environment[name] = value;
  }
  return environment;
}

type SubscriptionEnvelope =
  | { readonly kind: "malformed" }
  | { readonly kind: "incomplete" }
  | { readonly kind: "negative" }
  | { readonly kind: "attested" };

/**
 * Classify Claude `auth status --json` stdout. The promised envelope is
 * `loggedIn`, `authMethod`, and `apiProvider`; `apiKeySource` must be absent.
 * Missing fields are incomplete; present-but-wrong values are a completed
 * negative verdict.
 */
export function classifySubscriptionStdout(stdout: string): SubscriptionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "malformed" };
  }
  const diagnostic = parsed as Record<string, unknown>;
  if (
    !("loggedIn" in diagnostic) ||
    !("authMethod" in diagnostic) ||
    !("apiProvider" in diagnostic)
  ) {
    return { kind: "incomplete" };
  }
  if (
    diagnostic.loggedIn === true &&
    diagnostic.authMethod === "oauth_token" &&
    diagnostic.apiProvider === "firstParty" &&
    diagnostic.apiKeySource === undefined
  ) {
    return { kind: "attested" };
  }
  return { kind: "negative" };
}

export async function diagnoseSubscriptionRoute(options: {
  readonly ambient: NodeJS.ProcessEnv;
  readonly command?: string;
  readonly run?: DiagnosticRunner;
}): Promise<ClaudexorDiagnostic> {
  if (
    options.ambient.CLAUDE_CODE_OAUTH_TOKEN === undefined ||
    options.ambient.CLAUDE_CODE_OAUTH_TOKEN.length === 0
  ) {
    return {
      category: "auth-route",
      readState: "not-read",
      code: "SUBSCRIPTION_CARRIER_MISSING",
      message: "The approved Claude subscription carrier is unavailable.",
      remediation: "Provide CLAUDE_CODE_OAUTH_TOKEN; API-key fallback is not supported.",
    };
  }
  const configHome = await mkdtemp(join(tmpdir(), "heniek-claude-auth-"));
  try {
    const environment = isolatedClaudeEnvironment(options.ambient, configHome);
    const result = await (options.run ?? runDiagnostic)(
      options.command ?? "claude",
      ["auth", "status", "--json"],
      environment,
    );
    if (result.spawnFailure) {
      return {
        category: "auth-route",
        readState: "not-read",
        code: "SUBSCRIPTION_ROUTE_UNATTESTED",
        message: "Claude subscription attestation could not start.",
        remediation: "Refresh the approved subscription carrier and rerun heniek doctor.",
      };
    }
    if (result.exitCode !== 0) {
      return {
        category: "auth-route",
        readState: "failed",
        code: "SUBSCRIPTION_ROUTE_UNATTESTED",
        message: "Claude subscription attestation exited without a usable status envelope.",
        remediation: "Refresh the approved subscription carrier and rerun heniek doctor.",
      };
    }
    const envelope = classifySubscriptionStdout(result.stdout);
    if (envelope.kind === "malformed" || envelope.kind === "incomplete") {
      return {
        category: "auth-route",
        readState: "failed",
        code: "SUBSCRIPTION_ROUTE_UNATTESTED",
        message: "Claude returned a malformed or incomplete subscription status envelope.",
        remediation: "Refresh the approved subscription carrier and rerun heniek doctor.",
      };
    }
    if (envelope.kind === "negative") {
      return {
        category: "auth-route",
        readState: "ok",
        verdict: "fail",
        code: "SUBSCRIPTION_ROUTE_UNATTESTED",
        message: "Claude did not attest an isolated first-party OAuth subscription route.",
        remediation: "Refresh the approved subscription carrier and rerun heniek doctor.",
      };
    }
    return {
      category: "auth-route",
      readState: "ok",
      verdict: "pass",
      code: "SUBSCRIPTION_ROUTE_ATTESTED",
      message:
        "Claude attested an isolated first-party OAuth subscription route with no visible API key.",
    };
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
}

export async function diagnoseRuntimeAvailability(
  runtimeEntryPath: string | undefined,
  expectedEngine: ClaudexorEngineIdentity,
): Promise<ClaudexorDiagnostic> {
  if (runtimeEntryPath === undefined || !isAbsolute(runtimeEntryPath)) {
    return {
      category: "runtime",
      readState: "ok",
      verdict: "fail",
      code: "CLAUDEXOR_RUNTIME_UNCONFIGURED",
      message: "No active Claudexor runtime entry is configured.",
      remediation: `Activate Claudexor ${expectedEngine.version}/${expectedEngine.buildSha} with heniek runtime activate.`,
    };
  }
  try {
    await access(runtimeEntryPath);
    return {
      category: "runtime",
      readState: "ok",
      verdict: "pass",
      code: "CLAUDEXOR_RUNTIME_AVAILABLE",
      message: `The active Claudexor ${expectedEngine.version} runtime entry is available.`,
    };
  } catch {
    return {
      category: "runtime",
      readState: "ok",
      verdict: "fail",
      code: "CLAUDEXOR_RUNTIME_UNAVAILABLE",
      message: "The active Claudexor runtime entry is unavailable.",
      remediation: `Repair or roll back Claudexor ${expectedEngine.version}/${expectedEngine.buildSha}.`,
    };
  }
}
