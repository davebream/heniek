import { realpathSync } from "node:fs";
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
 * Review finding 9: `..._AUTH_ROUTE` must specifically be `"subscription"` —
 * `smoke/env.ts`'s `SMOKE_AUTH_ROUTES` already declares `"subscription"` as a
 * valid value, and this suite provisions a subscription route, so any other
 * declared route (`"api_key"`, `"none"`) is simply the wrong opt-in for this
 * suite, not a malformed one; it disables with a reason rather than throwing.
 *
 * `HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT` must resolve OUTSIDE
 * the repository, for the same reason `..._CLAUDEXOR_ROOT` must
 * (`../claudexor/gate.ts`): it holds transient engine config homes, and
 * nothing from a real engine's config home may enter this repository.
 *
 * Review finding 9: the profile root must EXIST, and is realpath-resolved
 * BEFORE the inside-repo check — this gate is a *write* path (a driver later
 * does `mkdtempSync` + recursive `rmSync` under it), and a purely lexical
 * check on the unresolved path would let a symlink whose target actually
 * resolves inside the repository pass as "outside", because the symlink's
 * own path string looks external even though following it lands back in the
 * checkout. Resolving first, then checking, closes that gap.
 *
 * Malformed opt-in throws; absent or wrong opt-in returns
 * `{enabled:false, reason}` — the CI default is disabled, not an error.
 * Errors never echo values.
 */

const SUBSCRIPTION_VAR = "HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION";
const PROFILE_ROOT_VAR = "HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT";
const AUTH_ROUTE_VAR = "HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE";
const REQUIRED_AUTH_ROUTE = "subscription";

export type SubscriptionSmokeConfig =
  | { readonly enabled: false; readonly reason: string }
  | {
      readonly enabled: true;
      readonly profileRoot: string | null;
      readonly smoke: Extract<SmokeConfig, { enabled: true }>;
    };

/** Injected so the gate's unit tests stay filesystem-free, matching `../claudexor/gate.ts`'s `GateProbes` pattern. */
export interface GateProbes {
  /** Resolves symlinks and requires the target to exist — throws (any error) when it does not. */
  readonly realpathSync: (path: string) => string;
}

const DEFAULT_PROBES: GateProbes = { realpathSync };

function isInsideRepo(target: string, repoRoot: string): boolean {
  const rel = relative(repoRoot, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve the subscription-isolation smoke gate.
 *
 * Returns a disabled config with a reason when the run is simply not opted
 * in (or opted in with the wrong auth route), which is the CI default and
 * not an error. A malformed opt-in — a relative profile root, a profile root
 * that does not exist, or one that resolves inside the repository — still
 * throws, so a typo cannot silently skip the suite while also silently
 * misconfiguring it.
 */
export function readSubscriptionSmokeConfig(
  env: NodeJS.ProcessEnv = process.env,
  probes: GateProbes = DEFAULT_PROBES,
): SubscriptionSmokeConfig {
  const smoke = readSmokeConfig(env);
  if (!smoke.enabled) {
    return { enabled: false, reason: "HENIEK_CONFORMANCE_SMOKE is not 1" };
  }
  if (smoke.authRoute !== REQUIRED_AUTH_ROUTE) {
    return {
      enabled: false,
      reason:
        `${AUTH_ROUTE_VAR} must be "${REQUIRED_AUTH_ROUTE}" for this suite (it provisions ` +
        `a subscription route), not "${smoke.authRoute}"`,
    };
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
  let resolvedRoot: string;
  try {
    resolvedRoot = probes.realpathSync(resolve(rootValue));
  } catch {
    throw new Error(
      `${PROFILE_ROOT_VAR} must resolve to an existing directory: this gate creates and later ` +
        "removes transient engine config homes under it (mkdtempSync + recursive rmSync), so a " +
        "nonexistent or unreadable path must fail before any filesystem write is attempted.",
    );
  }
  if (isInsideRepo(resolvedRoot, repoRoot)) {
    throw new Error(
      `${PROFILE_ROOT_VAR} must resolve OUTSIDE the repository: it holds transient engine ` +
        "config homes, and nothing from a real engine's config home may enter this repository. " +
        "(Resolved via realpath, so a symlink whose target lands inside the repository is " +
        "rejected too, not only a directly in-repository path.)",
    );
  }

  return { enabled: true, profileRoot: resolvedRoot, smoke };
}
