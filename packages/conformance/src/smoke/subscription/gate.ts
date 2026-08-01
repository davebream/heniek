import { isAbsolute, relative, resolve } from "node:path";
import { readSmokeConfig, resolveRepoRoot, type SmokeConfig } from "../env.js";

/**
 * Opt-in gate for the subscription-isolation canaries.
 *
 * Composes Q002's `readSmokeConfig` exactly as `../claudexor/gate.ts` does:
 * `HENIEK_CONFORMANCE_SMOKE=1` (with its mandatory `..._AUTH_ROUTE`) still
 * governs whether any real-engine work runs at all, and this adds one narrow
 * knob on top — `HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION=1` — so a run opted
 * into the general smoke gate does not automatically also invoke `claude`
 * and `heniek-codex` subprocesses.
 *
 * `HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT` must resolve OUTSIDE
 * the repository, for the same reason `..._CLAUDEXOR_ROOT` must
 * (`../claudexor/gate.ts`): it holds transient engine config homes, and
 * nothing from a real engine's config home may enter this repository. Unlike
 * `..._CLAUDEXOR_ROOT`, there is no existence check — this variable names a
 * scratch directory a driver creates fresh, not a pre-built checkout.
 *
 * Malformed opt-in throws; absent opt-in returns `{enabled:false, reason}` —
 * the CI default is disabled, not an error. Errors never echo values.
 */

const SUBSCRIPTION_VAR = "HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION";
const PROFILE_ROOT_VAR = "HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT";

export type SubscriptionSmokeConfig =
  | { readonly enabled: false; readonly reason: string }
  | {
      readonly enabled: true;
      readonly profileRoot: string | null;
      readonly smoke: Extract<SmokeConfig, { enabled: true }>;
    };

function isInsideRepo(target: string, repoRoot: string): boolean {
  const rel = relative(repoRoot, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve the subscription-isolation smoke gate.
 *
 * Returns a disabled config with a reason when the run is simply not opted
 * in, which is the CI default and not an error. A malformed opt-in — a
 * relative or in-repository profile root — still throws, so a typo cannot
 * silently skip the suite while also silently misconfiguring it.
 */
export function readSubscriptionSmokeConfig(
  env: NodeJS.ProcessEnv = process.env,
): SubscriptionSmokeConfig {
  const smoke = readSmokeConfig(env);
  if (!smoke.enabled) {
    return { enabled: false, reason: "HENIEK_CONFORMANCE_SMOKE is not 1" };
  }
  if (env[SUBSCRIPTION_VAR] !== "1") {
    return { enabled: false, reason: `${SUBSCRIPTION_VAR} is not 1` };
  }

  const rootValue = env[PROFILE_ROOT_VAR];
  if (rootValue === undefined || rootValue.trim().length === 0) {
    return { enabled: true, profileRoot: null, smoke };
  }

  if (!isAbsolute(rootValue)) {
    throw new Error(
      `${PROFILE_ROOT_VAR} must be an absolute path to a scratch directory for transient engine config homes.`,
    );
  }

  const repoRoot = resolveRepoRoot();
  const resolvedRoot = resolve(rootValue);
  if (isInsideRepo(resolvedRoot, repoRoot)) {
    throw new Error(
      `${PROFILE_ROOT_VAR} must resolve OUTSIDE the repository: it holds transient engine ` +
        "config homes, and nothing from a real engine's config home may enter this repository.",
    );
  }

  return { enabled: true, profileRoot: resolvedRoot, smoke };
}
