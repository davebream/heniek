import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type BillingRouteAttestation,
  classifyClaudeBillingRoute,
  classifyCodexBillingRoute,
  parseClaudeAuthDiagnostic,
} from "./attestation.js";
import type { IsolatedEnvironment } from "./variables.js";

/**
 * The only impure module in `smoke/subscription/`. Runs the pinned engine's
 * offline diagnostic under a constructed `IsolatedEnvironment` and classifies
 * the result. Everything that decides what the result MEANS lives in
 * `attestation.ts` as a pure function; this module's only job is to get a
 * diagnostic string out of a real process without ever logging it.
 *
 * `execFile` (never a shell) so `isolated.env` is the ONLY input the child
 * process can see. A shell would additionally source rc files and inherit
 * whatever the invoking shell's own environment resolution does, which is
 * exactly the ambient leakage this recipe exists to prevent.
 *
 * Raw stdout is parsed immediately and never logged, returned, or included in
 * any thrown error: this suite's own fixtures may fill it with fabricated
 * sentinel values, and a real run could carry an operator's actual session
 * state.
 */

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  readonly exitCode: number;
  readonly attestation: BillingRouteAttestation;
}

interface ExecFileFailure {
  readonly code?: number;
  readonly stdout?: string;
}

function isExecFileFailure(value: unknown): value is ExecFileFailure {
  return typeof value === "object" && value !== null;
}

async function runDiagnostic(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const result = await execFileAsync(command, args, { env });
    return { exitCode: 0, stdout: result.stdout };
  } catch (error) {
    if (!isExecFileFailure(error)) throw error;
    return { exitCode: error.code ?? 1, stdout: error.stdout ?? "" };
  }
}

/**
 * Probe Claude's billing route under `isolated`.
 *
 * A parse failure classifies as `indeterminate` rather than propagating —
 * `parseClaudeAuthDiagnostic` throws on purpose (see its doc comment) so that
 * callers with more context than "some CLI produced some text" can decide
 * what to do; this caller's context is "an opt-in canary observed a live,
 * non-metered CLI diagnostic", and the right decision here is total: never
 * crash the suite over unparseable output, and never let unparseable output
 * silently pass as a route either.
 */
export async function probeClaudeBillingRoute(isolated: IsolatedEnvironment): Promise<ProbeResult> {
  const { exitCode, stdout } = await runDiagnostic(
    "claude",
    ["auth", "status", "--json"],
    isolated.env,
  );
  try {
    return { exitCode, attestation: classifyClaudeBillingRoute(parseClaudeAuthDiagnostic(stdout)) };
  } catch {
    return {
      exitCode,
      attestation: {
        engine: "claude",
        route: "indeterminate",
        validity: "presence_only",
        exposedKeySources: [],
        detail:
          "claude auth status --json produced output that could not be parsed as the expected diagnostic shape.",
      },
    };
  }
}

/** Probe Codex's billing route under `isolated`. `classifyCodexBillingRoute` is already total over any string, so no parse-failure fallback is needed here. */
export async function probeCodexBillingRoute(isolated: IsolatedEnvironment): Promise<ProbeResult> {
  const { exitCode, stdout } = await runDiagnostic(
    "heniek-codex",
    ["login", "status"],
    isolated.env,
  );
  return { exitCode, attestation: classifyCodexBillingRoute(stdout) };
}
