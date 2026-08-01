import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { readSmokeConfig, resolveRepoRoot, type SmokeConfig } from "../env.js";

/**
 * Opt-in gate for the Claudexor canaries.
 *
 * Composes Q002's `readSmokeConfig` rather than introducing a second opt-in
 * mechanism: `HENIEK_CONFORMANCE_SMOKE=1` (with its mandatory
 * `..._AUTH_ROUTE`) still governs whether any real-engine work runs at all,
 * and this adds one narrow knob for *where the pinned engine lives*.
 *
 * Two path rules, and they point in opposite directions — which is exactly why
 * they are spelled out rather than sharing a helper:
 *
 *  - `..._CLAUDEXOR_ROOT` must resolve **outside** the repository. It is a
 *    built checkout of a third-party engine plus its runtime state; nothing
 *    from it may enter this repo.
 *  - `..._TRACE_OUT` must resolve **inside** the repository. It is committed
 *    ADR evidence.
 *
 * `env.ts`'s existing `..._MODULE` validation enforces the *inside* rule, so
 * reusing it for the root would be a security inversion.
 *
 * As in Q002, an error names the variable and **never** echoes its value.
 */

const ROOT_VAR = "HENIEK_CONFORMANCE_SMOKE_CLAUDEXOR_ROOT";
const TRACE_OUT_VAR = "HENIEK_CONFORMANCE_SMOKE_TRACE_OUT";

export type ClaudexorSmokeConfig =
  | { readonly enabled: false; readonly reason: string }
  | {
      readonly enabled: true;
      readonly claudexorRoot: string;
      readonly traceOut: string | null;
      readonly smoke: Extract<SmokeConfig, { enabled: true }>;
    };

/** Injected so the gate's unit tests stay filesystem-free, as `env.ts`'s are. */
export interface GateProbes {
  readonly exists: (path: string) => boolean;
}

const DEFAULT_PROBES: GateProbes = { exists: existsSync };

function isInsideRepo(target: string, repoRoot: string): boolean {
  const rel = relative(repoRoot, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve the Claudexor canary gate.
 *
 * Returns a disabled config with a reason rather than throwing when the run is
 * simply not opted in — that is the CI default and not an error. A *malformed*
 * opt-in still throws, so a typo cannot silently skip the suite.
 */
export function readClaudexorSmokeConfig(
  env: NodeJS.ProcessEnv = process.env,
  probes: GateProbes = DEFAULT_PROBES,
): ClaudexorSmokeConfig {
  const smoke = readSmokeConfig(env);
  if (!smoke.enabled) {
    return { enabled: false, reason: "HENIEK_CONFORMANCE_SMOKE is not 1" };
  }

  const root = env[ROOT_VAR];
  if (root === undefined || root.trim().length === 0) {
    return { enabled: false, reason: `${ROOT_VAR} is not set` };
  }
  if (!isAbsolute(root)) {
    throw new Error(`${ROOT_VAR} must be an absolute path to a built pinned Claudexor checkout.`);
  }

  const repoRoot = resolveRepoRoot();
  const resolvedRoot = resolve(root);
  if (isInsideRepo(resolvedRoot, repoRoot)) {
    throw new Error(
      `${ROOT_VAR} must resolve OUTSIDE the repository: it is a third-party engine checkout with its own runtime state, and nothing from it may enter this repository.`,
    );
  }
  if (!probes.exists(resolvedRoot)) {
    throw new Error(`${ROOT_VAR} does not exist; build the pinned Claudexor revision first.`);
  }

  return {
    enabled: true,
    claudexorRoot: resolvedRoot,
    traceOut: resolveTraceOut(env, repoRoot),
    smoke,
  };
}

/**
 * Resolve the committed-evidence output path.
 *
 * Resolved against the repository root rather than `process.cwd()`: the same
 * relative path would otherwise land in different places depending on whether
 * vitest was invoked from the repo root or from `packages/conformance`.
 */
export function resolveTraceOut(
  env: NodeJS.ProcessEnv,
  repoRoot: string = resolveRepoRoot(),
): string | null {
  const traceOut = env[TRACE_OUT_VAR];
  if (traceOut === undefined || traceOut.trim().length === 0) return null;

  const resolved = isAbsolute(traceOut) ? resolve(traceOut) : resolve(repoRoot, traceOut);
  if (!isInsideRepo(resolved, repoRoot)) {
    throw new Error(
      `${TRACE_OUT_VAR} must resolve inside the repository; it is committed ADR evidence.`,
    );
  }
  return resolved;
}
