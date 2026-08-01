/**
 * The isolation recipe: build a child-process environment for a named
 * subscription engine (Claude or Codex) that can see exactly one credential —
 * a declared subscription carrier — even when the parent process's ambient
 * environment carries conflicting API keys, routing switches, or other
 * credential-shaped variables.
 *
 * The whole recipe rests on one construction rule, and every other rule in
 * this module exists to protect it: `env` starts as `{}` and is built up by
 * explicit, per-name allowlist decisions. It is never `{ ...ambient }` with
 * bad names deleted afterwards. Q004's grounded observations (design doc §2,
 * findings F-2 and F-5) show why the "delete known-bad names" shape cannot
 * work even in principle: the hostile set includes routing switches that are
 * not credential-shaped at all (`CLAUDE_CODE_USE_BEDROCK`), and it includes
 * variables (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`) whose effect is
 * invisible to the one diagnostic this issue is allowed to use. A copy-then-
 * scrub build can only exclude names someone thought to list; a build-from-
 * empty excludes everything not explicitly admitted, including names nobody
 * has thought of yet.
 *
 * Pure: no network, filesystem, process, or clock access. Constructing the
 * environment and deciding whether the recipe is trustworthy are the same
 * operation here, on purpose — the classifiers in `canaries.ts` and
 * `attestation.ts` consume this module's output directly, never a live
 * process.
 */

import { isAbsolute } from "node:path";

export type SubscriptionEngine = "claude" | "codex";

export interface VariablePolicy {
  /** Named credential carrier(s) for this engine. At least one must be present and non-empty in the ambient environment, or the build refuses to proceed. */
  readonly subscriptionCarriers: readonly string[];
  /** Variables the recipe itself sets from `IsolationRequest.configHome` — never from the ambient value, even when one is present. */
  readonly configHomeVariables: readonly string[];
  /** Variables known never to be credential-shaped (PATH, LANG, ...), admitted through unchanged when present in ambient. */
  readonly neutral: readonly string[];
  /**
   * Names the hostile-environment matrix injects and this recipe must
   * exclude. Deliberately NOT limited to `*_API_KEY`-shaped names: F-2 (design
   * §2) shows a provider-routing switch changes the effective billing route
   * while carrying no credential at all, so it has to be named explicitly
   * here — the credential-shaped defence-in-depth pattern below would never
   * catch it.
   */
  readonly hostileCatalogue: readonly string[];
}

/**
 * One policy per engine. Names are chosen to be traceable to the design
 * doc's grounded observations (§2), not invented for convenience:
 *
 *  - `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CONFIG_DIR` are Claude Code's own
 *    documented long-lived-session and config-home variables.
 *  - `ANTHROPIC_API_KEY` (D), `ANTHROPIC_AUTH_TOKEN` (E1), `ANTHROPIC_BASE_URL`
 *    (E2), `CLAUDE_CODE_USE_BEDROCK` (E3) and `CLAUDE_CODE_USE_VERTEX` (E4)
 *    are exactly the hostile names the design doc's matrix exercises.
 *  - The Codex carrier name (`CODEX_CHATGPT_OAUTH_TOKEN`) is this issue's own
 *    broker convention — the design doc's "brokered Codex" — not a literal
 *    upstream Codex CLI variable; the ADR records this choice explicitly so
 *    it is never mistaken for an observed upstream contract.
 *  - `OPENAI_API_KEY` / `CODEX_API_KEY` (F1) and `OPENAI_BASE_URL` (F2) are
 *    the hostile names from the design doc's Codex rows. `CODEX_HOME` is
 *    deliberately NOT in the hostile catalogue even though F2 injects a
 *    hostile value for it: it is a declared config-home variable, so it is
 *    always overridden with the recipe's own dedicated home regardless of
 *    what the ambient value was — the ambient value is discarded exactly as
 *    F2 requires, just via a different mechanism than "denied".
 */
export const VARIABLE_POLICY: Readonly<Record<SubscriptionEngine, VariablePolicy>> = {
  claude: {
    subscriptionCarriers: ["CLAUDE_CODE_OAUTH_TOKEN"],
    configHomeVariables: ["CLAUDE_CONFIG_DIR"],
    neutral: ["PATH", "LANG", "LC_ALL", "TZ"],
    hostileCatalogue: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
    ],
  },
  codex: {
    subscriptionCarriers: ["CODEX_CHATGPT_OAUTH_TOKEN"],
    configHomeVariables: ["CODEX_HOME"],
    neutral: ["PATH", "LANG", "LC_ALL", "TZ"],
    hostileCatalogue: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
  },
} as const;

export type VariableOutcome =
  | "admitted-carrier"
  | "admitted-config-home"
  | "admitted-neutral"
  | "denied-hostile"
  | "denied-unlisted";

export interface VariableDecision {
  readonly name: string;
  readonly outcome: VariableOutcome;
  /** Presence only — never a value, never a substring of one. */
  readonly presentInAmbient: boolean;
}

export interface IsolationRequest {
  readonly engine: SubscriptionEngine;
  readonly ambient: NodeJS.ProcessEnv;
  /** Absolute; dedicated per run. */
  readonly configHome: string;
}

export interface IsolatedEnvironment {
  readonly env: Readonly<Record<string, string>>;
  readonly decisions: readonly VariableDecision[];
}

/**
 * A build-time contract violated in a way that must never resolve to "proceed
 * anyway" — an absolute-path requirement, or the engine's carrier being
 * absent. §10.4 requires the runtime to fail rather than silently change
 * billing mode, so both failure modes throw instead of returning a degraded
 * environment.
 */
export class IsolationViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationViolationError";
  }
}

/**
 * Defence in depth beyond the deny catalogue: an ambient name shaped like a
 * credential that is not a declared carrier is denied and — unlike an
 * ordinary unrecognised name — always gets a decision entry, so an unknown
 * credential-shaped variable is reported in the redacted diff rather than
 * silently dropped along with the rest of the unlisted noise (`SHLVL`, `_`,
 * terminal-emulator variables, ...). The allowlist, not this pattern, is what
 * makes the build correct; this pattern only changes what gets *reported*.
 */
const CREDENTIAL_SHAPED_PATTERN = /API[-_]?KEY|SECRET|CREDENTIAL|PASSWORD|_TOKEN\b|BEARER/i;

function firstNonEmpty(names: readonly string[], ambient: NodeJS.ProcessEnv): string | undefined {
  for (const name of names) {
    const value = ambient[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Build an isolated child-process environment for `request.engine`.
 *
 * Binding rules (design doc §3.1):
 *  1. `configHome` must be absolute, or `IsolationViolationError` — a relative
 *     path would resolve against whatever the child process's cwd happens to
 *     be, which is exactly the kind of ambient dependency this recipe exists
 *     to remove.
 *  2. The engine's subscription carrier must be present and non-empty in
 *     `ambient`, or `IsolationViolationError` — fail closed. Returning a
 *     "logged out" style environment instead would let a later layer
 *     re-derive a billing route from whatever the ambient environment happens
 *     to expose, reopening exactly the silent API-key fallback F-3 (design
 *     §2, scenario G3) demonstrates.
 *  3. Every admitted entry is decided individually; `env` is never a copy of
 *     `ambient`.
 */
export function buildIsolatedEnvironment(request: IsolationRequest): IsolatedEnvironment {
  if (!isAbsolute(request.configHome)) {
    throw new IsolationViolationError(
      "configHome must be an absolute path. A relative configHome would resolve " +
        "against the child process's working directory rather than a dedicated, " +
        "known location, defeating the isolation this recipe provides.",
    );
  }

  const policy = VARIABLE_POLICY[request.engine];
  const carrierValue = firstNonEmpty(policy.subscriptionCarriers, request.ambient);
  if (carrierValue === undefined) {
    throw new IsolationViolationError(
      `none of the declared subscription carrier(s) for engine "${request.engine}" ` +
        `(${policy.subscriptionCarriers.join(", ")}) is present and non-empty in the ` +
        "ambient environment. Refusing to build an isolated environment that could " +
        "silently fall back to an unauthenticated or API-key billing route.",
    );
  }

  const env: Record<string, string> = {};
  const decisions: VariableDecision[] = [];
  const decided = new Set<string>();

  const isPresent = (name: string): boolean =>
    Object.hasOwn(request.ambient, name) && request.ambient[name] !== undefined;

  const decide = (name: string, outcome: VariableOutcome, admittedValue?: string): void => {
    decisions.push({ name, outcome, presentInAmbient: isPresent(name) });
    decided.add(name);
    if (admittedValue !== undefined) env[name] = admittedValue;
  };

  // 1. Carriers. Only the first non-empty declared carrier name is admitted
  // with its value; any other declared carrier name that happens to be
  // absent or empty is recorded but not admitted — harmless, since the
  // fail-closed check above already guarantees at least one carrier exists.
  for (const name of policy.subscriptionCarriers) {
    const value = request.ambient[name];
    if (value !== undefined && value.length > 0) {
      decide(name, "admitted-carrier", value);
    } else {
      decide(name, "denied-unlisted");
    }
  }

  // 2. Config home variables. Always admitted, always with `configHome` —
  // never the ambient value, so a hostile ambient config-home variable
  // (design §2, F2) is discarded regardless of what it points at.
  for (const name of policy.configHomeVariables) {
    if (decided.has(name)) continue;
    decide(name, "admitted-config-home", request.configHome);
  }

  // 3. The declared hostile catalogue. Always recorded — whether or not the
  // ambient environment actually set it — so the redacted diff documents
  // every name this recipe is known to guard against, not only the ones a
  // particular run happened to inject.
  for (const name of policy.hostileCatalogue) {
    if (decided.has(name)) continue;
    decide(name, "denied-hostile");
  }

  // 4. Declared neutral variables. Admitted only when actually present —
  // there is nothing to admit for one that is absent, and no decision is
  // recorded for it either (matches step 5's "silently ignored" posture for
  // anything not actually in ambient).
  for (const name of policy.neutral) {
    if (decided.has(name)) continue;
    const value = request.ambient[name];
    if (value !== undefined) decide(name, "admitted-neutral", value);
  }

  // 5. Defence in depth over whatever remains. Anything credential-shaped
  // that reached here is neither a carrier, a config-home variable, a
  // hostile-catalogue entry, nor a declared neutral variable — an unknown
  // credential-shaped name — and gets a decision entry precisely so it is
  // visible rather than lost in the noise. Everything else left in `ambient`
  // (shell/terminal cruft, unrelated tool variables, ...) is excluded from
  // `env` by construction (step 0: `env` started as `{}`) but is not
  // reported: reporting every unrelated ambient variable would bury the
  // security-relevant rows the redacted diff exists to show.
  for (const name of Object.keys(request.ambient)) {
    if (decided.has(name)) continue;
    if (CREDENTIAL_SHAPED_PATTERN.test(name)) decide(name, "denied-unlisted");
  }

  return {
    env: Object.freeze(env),
    decisions: Object.freeze(decisions.map((d) => Object.freeze(d))),
  };
}
