import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type BillingRouteAttestation,
  classifyClaudeBillingRoute,
  classifyCodexBillingRoute,
  parseClaudeAuthDiagnostic,
} from "./attestation.js";
import type { IsolatedEnvironment, SubscriptionEngine } from "./variables.js";

/**
 * The only impure module in `smoke/subscription/`. Runs the pinned engine's
 * offline diagnostic under a constructed `IsolatedEnvironment` and classifies
 * the result. Everything that decides what the result MEANS lives in
 * `attestation.ts` (route classification) and `classifyRawDiagnostic` below
 * (failure classification) as pure functions; this module's impure surface is
 * reduced to running a command and handing its raw output to those pure
 * functions.
 *
 * FIX-5 / FIX-11: the process-running part is injectable (`DiagnosticRunnerFn`)
 * so this module's failure-handling behaviour is hermetically testable
 * without a real subprocess — see `test/subscription-probe.test.ts`. Before
 * this fix, `probe.ts` had zero committed test coverage of its own: the only
 * thing exercising it was the opt-in, real-CLI `subscription.smoke.test.ts`,
 * which never runs in CI. A classifier that can only be exercised by a real
 * engine is a classifier that never gets tested (design doc §3.1's rationale
 * for the whole package, applied to the one module that previously violated
 * it).
 *
 * `execFile` (never a shell), by default, so `isolated.env` is the ONLY input
 * the child process can see. A shell would additionally source rc files and
 * inherit whatever the invoking shell's own environment resolution does,
 * which is exactly the ambient leakage this recipe exists to prevent.
 *
 * Raw stdout and stderr are captured but NEVER logged, returned in
 * `ProbeResult`, or included in any thrown error or attestation detail: this
 * suite's own fixtures may fill either with fabricated sentinel values, a
 * real run could carry an operator's actual session state, and N3 (design
 * doc §2) shows stderr can carry a multi-kilobyte internal stack trace on a
 * spawn-adjacent failure.
 */

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  /**
   * The child process's exit code, or `null` when the command could not be
   * run at all (a spawn-level failure — see `spawnFailure`). FIX-11: this is
   * deliberately `number | null`, not `number`. Node's `child_process` sets
   * `error.code` to a STRING (e.g. `"ENOENT"`) when the command itself could
   * not be launched, and to a NUMBER only when the command launched and
   * exited non-zero. The pre-FIX-11 code declared `exitCode: number` and
   * assigned `error.code ?? 1` to it unconditionally, which silently coerced
   * a string like `"ENOENT"` into a field typed `number` — exactly the kind
   * of type confusion that hides "the brokered command is not on PATH"
   * inside what looks like an ordinary non-zero exit code.
   */
  readonly exitCode: number | null;
  /**
   * `true` when the command could not be spawned at all (not on PATH,
   * permission denied, ...), as distinct from a command that ran and
   * produced an exit code the diagnostic classifiers can reason about.
   */
  readonly spawnFailure: boolean;
  readonly attestation: BillingRouteAttestation;
}

/** Raw facts a `DiagnosticRunnerFn` reports back about one attempted command run. Never rendered verbatim anywhere past `classifyRawDiagnostic`. */
export interface RawDiagnosticResult {
  readonly exitCode: number | null;
  readonly spawnFailure: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** The injectable seam: anything that can attempt to run `command args` under `env` and report back what happened, without this module caring whether it was a real subprocess or a test fixture. */
export type DiagnosticRunnerFn = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<RawDiagnosticResult>;

export interface ProbeOptions {
  /** Defaults to a real `execFile`-based runner. Tests inject a fake runner instead of shelling out. */
  readonly run?: DiagnosticRunnerFn;
}

interface ExecFileFailure {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
}

function isExecFileFailure(value: unknown): value is ExecFileFailure {
  return typeof value === "object" && value !== null;
}

const defaultRunner: DiagnosticRunnerFn = async (command, args, env) => {
  try {
    const result = await execFileAsync(command, args, { env });
    return { exitCode: 0, spawnFailure: false, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!isExecFileFailure(error)) throw error;
    // See `ProbeResult.exitCode`'s doc comment: `error.code` is a STRING on a
    // spawn-level failure and a NUMBER on an ordinary non-zero exit.
    const spawnFailure = typeof error.code === "string";
    const exitCode = typeof error.code === "number" ? error.code : null;
    return {
      exitCode,
      spawnFailure,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
};

/**
 * Pure failure/route classification over a `RawDiagnosticResult`. Exported so
 * it is directly, hermetically testable (FIX-5) without exercising
 * `probeBillingRoute`'s process-running plumbing at all.
 *
 * A spawn failure classifies as `indeterminate`, never `none` — "the
 * brokered command is not on PATH" and "the subscription is not active" must
 * be distinguishable, and neither is an honest "no route to attest" in the
 * sense `none` means elsewhere in this module (a real, successful diagnostic
 * reporting no active session).
 *
 * For Claude, a parse failure on stdout (that ran successfully) also
 * classifies as `indeterminate` rather than propagating —
 * `parseClaudeAuthDiagnostic` throws on purpose (see its doc comment) so
 * that callers with more context than "some CLI produced some text" can
 * decide what to do; this caller's context is "an opt-in canary observed a
 * live, non-metered CLI diagnostic", and the right decision here is total:
 * never crash the suite over unparseable output, and never let unparseable
 * output silently pass as a route either. For Codex, `classifyCodexBillingRoute`
 * is already total over any string, so no separate parse-failure fallback is
 * needed there.
 */
export function classifyRawDiagnostic(
  engine: SubscriptionEngine,
  raw: RawDiagnosticResult,
): BillingRouteAttestation {
  if (raw.spawnFailure) {
    return {
      engine,
      route: "indeterminate",
      validity: "presence_only",
      exposedKeySources: [],
      detail:
        `the ${engine} diagnostic command could not be spawned (for example, not on PATH); ` +
        "this is distinct from an unsuccessful login and refusing to guess a billing route " +
        "from it.",
    };
  }

  if (engine === "claude") {
    try {
      return classifyClaudeBillingRoute(parseClaudeAuthDiagnostic(raw.stdout));
    } catch {
      return {
        engine,
        route: "indeterminate",
        validity: "presence_only",
        exposedKeySources: [],
        detail:
          "claude auth status --json produced output that could not be parsed as the expected diagnostic shape.",
      };
    }
  }

  // N4 (ADR 0003, design doc §2): the two engines' diagnostics were observed
  // to carry their status line on DIFFERENT streams, and this asymmetry is
  // deliberate below, not an oversight to "clean up" into a single shared
  // read.
  //
  //   - N4a: `heniek-codex login status`, run under the recipe environment,
  //     exited 0 with an EMPTY stdout and the status line
  //     ("Logged in using ChatGPT") on STDERR. The broker relays the
  //     underlying engine's output back over its own socket bridge, and that
  //     relay surfaces on the stderr stream — this is a fact about the
  //     broker's plumbing, not something this module can change.
  //   - N4b: `claude auth status --json`, run under the same recipe
  //     environment, exited 0 with an 85-byte JSON document on stdout and an
  //     EMPTY stderr.
  //
  // Before this fix, this function classified Codex from `raw.stdout` alone
  // (mirroring the Claude branch above), which is empty per N4a and
  // classified a live, logged-in ChatGPT subscription as `indeterminate` —
  // the opt-in canary's real failure. Codex must therefore classify from the
  // COMBINED stream (stdout concatenated with stderr), while Claude's stdout-
  // only read stays exactly as it was: Claude's diagnostic is JSON, and
  // mixing a stderr stack trace (N3 already showed stderr can carry a
  // multi-kilobyte internal stack trace on a spawn-adjacent failure) into a
  // JSON parse would be strictly worse, never better.
  //
  // This combined read is exactly what makes `classifyCodexBillingRoute`'s
  // own ambiguity rule (more than one recognised pattern matching → always
  // `indeterminate`, never a first-match-wins guess) load-bearing here: a
  // combined stdout+stderr string is more likely than either stream alone to
  // accidentally contain a matching phrase inside an unrelated crash dump,
  // and that rule is what stops such a coincidence from being misread as a
  // pass. See `subscription-probe.test.ts` for the regression coverage of
  // both the stderr-only status line and a crash-style stderr that must
  // still classify `indeterminate`.
  //
  // Safety: the combined text below is handed only to the total,
  // non-throwing `classifyCodexBillingRoute` classifier, whose returned
  // `detail` never echoes the input text verbatim (see that function's own
  // doc comment) — so this combined read never itself becomes a new path by
  // which raw stderr (which, per N3, may be a multi-kilobyte internal stack
  // trace) reaches a message, thrown error, or artifact.
  return classifyCodexBillingRoute(`${raw.stdout}${raw.stderr}`);
}

const ENGINE_COMMANDS: Readonly<
  Record<SubscriptionEngine, { readonly command: string; readonly args: readonly string[] }>
> = {
  claude: { command: "claude", args: ["auth", "status", "--json"] },
  codex: { command: "heniek-codex", args: ["login", "status"] },
};

/**
 * Probe `engine`'s billing route under `env` (typically
 * `IsolatedEnvironment.env`). The only entry point that actually runs a
 * command — real by default, injectable via `options.run` for hermetic
 * tests.
 */
export async function probeBillingRoute(
  engine: SubscriptionEngine,
  env: Readonly<Record<string, string>>,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const run = options.run ?? defaultRunner;
  const { command, args } = ENGINE_COMMANDS[engine];
  const raw = await run(command, args, env);
  return {
    exitCode: raw.exitCode,
    spawnFailure: raw.spawnFailure,
    attestation: classifyRawDiagnostic(engine, raw),
  };
}

/** Probe Claude's billing route under `isolated`. */
export async function probeClaudeBillingRoute(
  isolated: IsolatedEnvironment,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  return probeBillingRoute("claude", isolated.env, options);
}

/** Probe Codex's billing route under `isolated`. */
export async function probeCodexBillingRoute(
  isolated: IsolatedEnvironment,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  return probeBillingRoute("codex", isolated.env, options);
}
