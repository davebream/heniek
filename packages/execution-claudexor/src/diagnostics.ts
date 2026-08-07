import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { CLAUDEXOR_ENGINE_SHA, CLAUDEXOR_ENGINE_VERSION } from "./protocol.js";

const execFileAsync = promisify(execFile);
const ISOLATED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export type ClaudexorDiagnosticCategory = "runtime" | "auth-route" | "compatibility";

export interface ClaudexorDiagnostic {
  readonly category: ClaudexorDiagnosticCategory;
  readonly status: "pass" | "warn" | "fail";
  readonly code: string;
  readonly message: string;
  readonly remediation?: string;
}

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

function subscriptionAttested(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const diagnostic = parsed as Record<string, unknown>;
  return (
    diagnostic.loggedIn === true &&
    diagnostic.authMethod === "oauth_token" &&
    diagnostic.apiProvider === "firstParty" &&
    diagnostic.apiKeySource === undefined
  );
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
      status: "fail",
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
    if (result.spawnFailure || result.exitCode !== 0 || !subscriptionAttested(result.stdout)) {
      return {
        category: "auth-route",
        status: "fail",
        code: "SUBSCRIPTION_ROUTE_UNATTESTED",
        message: "Claude did not attest an isolated first-party OAuth subscription route.",
        remediation: "Refresh the approved subscription carrier and rerun heniek doctor.",
      };
    }
    return {
      category: "auth-route",
      status: "pass",
      code: "SUBSCRIPTION_ROUTE_ATTESTED",
      message:
        "Claude attested an isolated first-party OAuth subscription route with no visible API key.",
    };
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
}

export async function diagnoseRuntimeAvailability(
  runtimeRoot: string | undefined,
): Promise<ClaudexorDiagnostic> {
  if (runtimeRoot === undefined || !isAbsolute(runtimeRoot)) {
    return {
      category: "runtime",
      status: "fail",
      code: "CLAUDEXOR_RUNTIME_UNCONFIGURED",
      message: "No absolute path to the prebuilt pinned Claudexor runtime is configured.",
      remediation: `Configure an existing Claudexor ${CLAUDEXOR_ENGINE_VERSION}/${CLAUDEXOR_ENGINE_SHA} runtime; doctor never installs or upgrades it.`,
    };
  }
  try {
    await access(join(runtimeRoot, "packages/cli/dist/claudexord.js"));
    return {
      category: "runtime",
      status: "pass",
      code: "CLAUDEXOR_RUNTIME_AVAILABLE",
      message: `The configured prebuilt Claudexor ${CLAUDEXOR_ENGINE_VERSION} runtime is available.`,
    };
  } catch {
    return {
      category: "runtime",
      status: "fail",
      code: "CLAUDEXOR_RUNTIME_UNAVAILABLE",
      message:
        "The configured Claudexor runtime does not contain the expected prebuilt daemon entry.",
      remediation: `Build the pinned runtime outside Heniek, then configure ${CLAUDEXOR_ENGINE_VERSION}/${CLAUDEXOR_ENGINE_SHA}.`,
    };
  }
}
