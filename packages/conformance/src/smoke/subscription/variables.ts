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
 * **Two carrier models, not one (post-hoc correction — see design doc's
 * N-series table and the ADR's stop-condition section).** The original build
 * of this module modelled Codex the same way as Claude: a named environment
 * variable carrying a credential, with a config-home variable this recipe
 * overrides. New empirical evidence (N1, N2 in the design doc §2) shows that
 * model was simply wrong for Codex:
 *
 *  - N1: `heniek-codex login status`, run under an environment containing
 *    ONLY `PATH` and `LANG` — no credential variable of any kind, no config
 *    home variable — reports the ChatGPT subscription as logged in. Codex
 *    needs no environment-carried credential and no caller-supplied config
 *    home at all.
 *  - N2: the same minimal environment, with hostile `OPENAI_API_KEY`,
 *    `CODEX_API_KEY`, `OPENAI_BASE_URL`, `CODEX_HOME` and `HOME` all injected
 *    with poisoned sentinel values, still reports the ChatGPT subscription.
 *    The broker replaces the child environment wholesale and provisions the
 *    saved ChatGPT auth document into a config home **it owns** — the caller
 *    neither supplies nor can influence that home. This is credential
 *    **retention**, not merely exclusion of the ambient value: the broker's
 *    own home wins regardless of what the caller's environment says.
 *
 * For a `carrierKind: "brokered"` engine, this module therefore constructs
 * only a minimal, allowlisted **invocation** environment (neutral variables
 * plus whatever the hostile catalogue records as excluded); it does not, and
 * cannot, prove anything about how the broker itself provisions or stores the
 * credential — that is the broker's job, exercised by N1/N2 above, not this
 * module's. Supplying a `configHome` for a brokered engine is refused
 * (`IsolationViolationError`): naming one would misrepresent where the
 * credential actually lives.
 *
 * `carrierKind: "environment"` (Claude) keeps the original model: a named
 * environment variable is the carrier, and this recipe fails closed if it is
 * absent or empty.
 *
 * Pure: no network, filesystem, process, or clock access. Constructing the
 * environment and deciding whether the recipe is trustworthy are the same
 * operation here, on purpose — the classifiers in `canaries.ts` and
 * `attestation.ts` consume this module's output directly, never a live
 * process.
 */

import { isAbsolute, join } from "node:path";

export type SubscriptionEngine = "claude" | "codex";

export interface VariablePolicy {
  /**
   * How this engine's subscription credential is carried into the child
   * process. `"environment"`: a named environment variable, checked and
   * admitted by this module. `"brokered"`: an external broker command owns
   * credential provisioning entirely; this module builds only a minimal
   * allowlisted invocation environment and proves nothing about the
   * broker's own storage (see the module doc comment, N1/N2).
   */
  readonly carrierKind: "environment" | "brokered";
  /** Named credential carrier(s) for this engine. Only meaningful for `carrierKind: "environment"`; empty for `"brokered"`. */
  readonly subscriptionCarriers: readonly string[];
  /** Variables the recipe itself sets from `IsolationRequest.configHome` — never from the ambient value, even when one is present. Only meaningful for `carrierKind: "environment"`; empty for `"brokered"`, which owns its own config home. */
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
   *
   * `PATH` is declared here too (review finding 2), but is not an ordinary
   * hostile-catalogue member: an ambient, attacker-controlled `PATH` decides
   * which binary receives the bare command name `probe.ts` execs (`claude`,
   * `heniek-codex`), which is exactly the threat model this recipe exists to
   * defend against. `buildIsolatedEnvironment` decides `PATH` before this
   * catalogue is ever consulted, always with the fixed `ISOLATED_PATH` value
   * and outcome `"admitted-fixed"` — never `"denied-hostile"` and never the
   * ambient value. It is still listed here so the redacted diff's coverage
   * table documents every name this recipe is known to guard against.
   */
  readonly hostileCatalogue: readonly string[];
  /**
   * External command that owns credential provisioning for a `"brokered"`
   * engine (e.g. `"heniek-codex"`). Required for `carrierKind: "brokered"` —
   * `buildIsolatedEnvironment` fails closed if it is missing, rather than
   * building an environment for a broker this recipe cannot name.
   */
  readonly brokerCommand?: string;
  /**
   * For a `"brokered"` engine only: the subset of `hostileCatalogue` entries
   * that represent the broker's OWN config-home carrier (e.g. `CODEX_HOME`,
   * `HOME`) rather than an ordinary hostile credential (e.g.
   * `OPENAI_API_KEY`). These get the outcome `denied-broker-owned` instead of
   * `denied-hostile`, so the redacted diff records *why* the name is excluded
   * — "the broker owns this, not a plain hostile credential" — rather than
   * lumping every excluded name into one bucket.
   */
  readonly brokerOwnedNames?: readonly string[];
}

/**
 * One policy per engine. Names are chosen to be traceable to the design
 * doc's grounded observations (§2), not invented for convenience.
 *
 * These are this recipe's own *declared* carrier and config-home variable
 * names — not a claim about upstream documentation. N1/N2/N3 (design doc §2)
 * record what environments built from these declared names actually produced
 * when run against the pinned CLIs; nothing here asserts those names are
 * documented upstream contracts.
 *
 *  - `CLAUDE_CODE_OAUTH_TOKEN` is Claude Code's long-lived-session carrier.
 *    `HOME` and `CLAUDE_CONFIG_DIR` are both config-home variables (N3): the
 *    diagnostic throws an internal `ENOENT ... uv_os_homedir` error and exits
 *    1 with empty stdout if `HOME` is absent, even with `CLAUDE_CONFIG_DIR`
 *    set — `CLAUDE_CONFIG_DIR` alone is not sufficient.
 *  - `ANTHROPIC_API_KEY` (D), `ANTHROPIC_AUTH_TOKEN` (E1), `ANTHROPIC_BASE_URL`
 *    (E2), `CLAUDE_CODE_USE_BEDROCK` (E3) and `CLAUDE_CODE_USE_VERTEX` (E4)
 *    are exactly the hostile names the design doc's matrix exercises.
 *  - Codex is `carrierKind: "brokered"`: there is no subscription-carrier
 *    environment variable and no caller-supplied config home at all (N1, N2).
 *    `OPENAI_API_KEY` / `CODEX_API_KEY` / `OPENAI_BASE_URL` are ordinary
 *    hostile names from the design doc's Codex rows. `CODEX_HOME` and `HOME`
 *    are declared in `brokerOwnedNames`: N2 shows the broker's OWN config
 *    home wins regardless of what a poisoned ambient `CODEX_HOME`/`HOME`
 *    says, so these are excluded for a different reason than an ordinary
 *    hostile credential — the broker owns them, this recipe does not.
 */
export const VARIABLE_POLICY: Readonly<Record<SubscriptionEngine, VariablePolicy>> = {
  claude: {
    carrierKind: "environment",
    subscriptionCarriers: ["CLAUDE_CODE_OAUTH_TOKEN"],
    configHomeVariables: ["HOME", "CLAUDE_CONFIG_DIR"],
    neutral: ["LANG", "LC_ALL", "TZ"],
    hostileCatalogue: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "PATH",
    ],
  },
  codex: {
    carrierKind: "brokered",
    subscriptionCarriers: [],
    configHomeVariables: [],
    neutral: ["LANG", "LC_ALL", "TZ"],
    hostileCatalogue: [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_BASE_URL",
      "CODEX_HOME",
      "HOME",
      "PATH",
    ],
    brokerCommand: "heniek-codex",
    brokerOwnedNames: ["CODEX_HOME", "HOME"],
  },
} as const;

/**
 * The ONLY value `PATH` is ever admitted with, for every engine — review
 * finding 2. Before this fix, `PATH` was declared `neutral` and admitted
 * through unchanged from `ambient`, which meant an attacker-controlled
 * ambient `PATH` decided which binary `probe.ts`'s bare-name `execFile` calls
 * (`claude`, `heniek-codex`) actually resolved to — exactly the threat model
 * this recipe exists to defend against. `probe.ts`'s bare-name resolution is
 * safe only because it always runs under this fixed constant, never the
 * ambient value. Mirrors what the observed credential broker itself does
 * (design doc §2, N1/N2): a minimal, known `PATH`, never inherited.
 */
export const ISOLATED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export type VariableOutcome =
  | "admitted-carrier"
  | "admitted-config-home"
  | "admitted-neutral"
  | "admitted-fixed"
  | "denied-hostile"
  | "denied-unlisted"
  | "denied-empty-carrier"
  | "denied-broker-owned";

export interface VariableDecision {
  readonly name: string;
  readonly outcome: VariableOutcome;
  /**
   * Presence only — never a value, never a substring of one. NOTE: this is
   * `true` for a variable that is present in ambient but set to the empty
   * string; it does not by itself say whether the value was *usable*. A
   * declared carrier that is present-but-empty gets a dedicated
   * `denied-empty-carrier` decision (see `VariableOutcome`) precisely so a
   * reader of the redacted diff does not have to infer "present but useless"
   * from `presentInAmbient` and a generic denial outcome together.
   */
  readonly presentInAmbient: boolean;
}

export interface IsolationRequest {
  readonly engine: SubscriptionEngine;
  readonly ambient: NodeJS.ProcessEnv;
  /**
   * Absolute; dedicated per run. **Required** for a `carrierKind:
   * "environment"` engine (Claude) — `IsolationViolationError` if absent or
   * relative. **Must be omitted** for a `carrierKind: "brokered"` engine
   * (Codex) — `IsolationViolationError` if supplied, since the broker owns
   * its own config home and naming one here would misrepresent where the
   * credential actually lives (see the module doc comment, N1/N2).
   */
  readonly configHome?: string;
}

export interface IsolatedEnvironment {
  readonly env: Readonly<Record<string, string>>;
  readonly decisions: readonly VariableDecision[];
}

/**
 * A build-time contract violated in a way that must never resolve to "proceed
 * anyway" — an absolute-path requirement, a `configHome` supplied for a
 * brokered engine, a brokered engine with no declared broker command, or the
 * engine's carrier being absent. §10.4 requires the runtime to fail rather
 * than silently change billing mode, so every one of these throws instead of
 * returning a degraded environment.
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

/** `CLAUDE_CONFIG_DIR` is a subdirectory of the dedicated config home; every other declared config-home variable (currently only `HOME`) takes the config home value directly (N3). */
function configHomeValue(name: string, configHome: string): string {
  return name === "CLAUDE_CONFIG_DIR" ? join(configHome, ".claude") : configHome;
}

/**
 * Build an isolated child-process environment for `request.engine`.
 *
 * Binding rules (design doc §3.1, corrected by the N-series findings):
 *  1. For `carrierKind: "environment"`: `configHome` must be present and
 *     absolute, or `IsolationViolationError` — a relative path would resolve
 *     against whatever the child process's cwd happens to be, which is
 *     exactly the kind of ambient dependency this recipe exists to remove.
 *     The engine's subscription carrier must also be present and non-empty
 *     in `ambient`, or `IsolationViolationError` — fail closed. Returning a
 *     "logged out" style environment instead would let a later layer
 *     re-derive a billing route from whatever the ambient environment
 *     happens to expose, reopening exactly the silent API-key fallback F-3
 *     (design §2, scenario G3) demonstrates.
 *  2. For `carrierKind: "brokered"`: `configHome` must be ABSENT, or
 *     `IsolationViolationError` — the broker owns its own config home (N1,
 *     N2), and a caller-supplied one would misrepresent where the credential
 *     lives. `policy.brokerCommand` must be declared, or
 *     `IsolationViolationError` — this module refuses to build an
 *     environment for a broker it cannot name.
 *  3. Every admitted entry is decided individually; `env` is never a copy of
 *     `ambient`.
 *  4. `PATH` is always the fixed `ISOLATED_PATH` constant, for every engine,
 *     regardless of what `ambient` says (review finding 2) — never denied,
 *     never the ambient value.
 */
export function buildIsolatedEnvironment(request: IsolationRequest): IsolatedEnvironment {
  const policy = VARIABLE_POLICY[request.engine];

  if (policy.carrierKind === "brokered") {
    if (request.configHome !== undefined) {
      throw new IsolationViolationError(
        `engine "${request.engine}" is carrierKind "brokered": its broker owns its own ` +
          "config home, and this recipe cannot construct one on its behalf without " +
          "misrepresenting where the credential actually lives. Omit configHome for a " +
          "brokered engine.",
      );
    }
    if (policy.brokerCommand === undefined) {
      throw new IsolationViolationError(
        `engine "${request.engine}" is carrierKind "brokered" but declares no brokerCommand; ` +
          "refusing to build an invocation environment for a broker this recipe cannot name.",
      );
    }
  } else {
    if (request.configHome === undefined || !isAbsolute(request.configHome)) {
      throw new IsolationViolationError(
        "configHome must be an absolute path for an environment-carrier engine. A relative " +
          "or missing configHome would resolve against the child process's working directory " +
          "rather than a dedicated, known location, defeating the isolation this recipe provides.",
      );
    }

    const carrierValue = firstNonEmpty(policy.subscriptionCarriers, request.ambient);
    if (carrierValue === undefined) {
      throw new IsolationViolationError(
        `none of the declared subscription carrier(s) for engine "${request.engine}" ` +
          `(${policy.subscriptionCarriers.join(", ")}) is present and non-empty in the ` +
          "ambient environment. Refusing to build an isolated environment that could " +
          "silently fall back to an unauthenticated or API-key billing route.",
      );
    }
  }

  const configHome = request.configHome;
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

  // 1. PATH, for every engine, before anything else is decided. Always the
  // fixed ISOLATED_PATH constant, never the ambient value and never merely
  // "denied" — review finding 2. An admitted-but-ambient PATH would let an
  // attacker-controlled ambient environment decide which binary probe.ts's
  // bare-name execFile calls (`claude`, `heniek-codex`) actually resolve to,
  // which is exactly the threat model this recipe exists to defend against.
  // Deciding it here, before the hostile-catalogue loop below, guarantees it
  // is recorded exactly once, with the dedicated "admitted-fixed" outcome —
  // the catalogue loop's `decided.has(name)` check skips it.
  decide("PATH", "admitted-fixed", ISOLATED_PATH);

  // 2. Carriers. Only the first non-empty declared carrier name is admitted
  // with its value; any other declared carrier name that happens to be
  // absent is recorded as denied-unlisted, and one that is present but empty
  // gets the dedicated denied-empty-carrier outcome (harmless either way,
  // since the fail-closed check above already guarantees at least one
  // carrier exists for an environment-carrier engine; empty for a brokered
  // engine, so this loop is a no-op there).
  for (const name of policy.subscriptionCarriers) {
    const value = request.ambient[name];
    if (value !== undefined && value.length > 0) {
      decide(name, "admitted-carrier", value);
    } else if (value !== undefined && value.length === 0) {
      decide(name, "denied-empty-carrier");
    } else {
      decide(name, "denied-unlisted");
    }
  }

  // 3. Config home variables. Always admitted, always derived from
  // `configHome` — never the ambient value, so a hostile ambient config-home
  // variable (design §2, F2) is discarded regardless of what it points at.
  // Empty for a brokered engine, so this loop is a no-op there.
  for (const name of policy.configHomeVariables) {
    if (decided.has(name)) continue;
    // `configHome` is guaranteed defined here: the validation above throws
    // before this point for any engine whose configHomeVariables is
    // non-empty (only `carrierKind: "environment"` declares any).
    decide(name, "admitted-config-home", configHomeValue(name, configHome as string));
  }

  // 4. The declared hostile catalogue. Always recorded — whether or not the
  // ambient environment actually set it — so the redacted diff documents
  // every name this recipe is known to guard against, not only the ones a
  // particular run happened to inject. For a brokered engine, a name also
  // listed in `brokerOwnedNames` gets `denied-broker-owned` instead of
  // `denied-hostile`, so the diff records *why* it is excluded. `PATH` is
  // declared in every policy's `hostileCatalogue` too, but is always already
  // `decided` by step 1 above, so this loop never assigns it `denied-hostile`.
  for (const name of policy.hostileCatalogue) {
    if (decided.has(name)) continue;
    const isBrokerOwned =
      policy.carrierKind === "brokered" && (policy.brokerOwnedNames?.includes(name) ?? false);
    decide(name, isBrokerOwned ? "denied-broker-owned" : "denied-hostile");
  }

  // 5. Declared neutral variables. Admitted only when actually present —
  // there is nothing to admit for one that is absent, and no decision is
  // recorded for it either (matches step 6's "silently ignored" posture for
  // anything not actually in ambient).
  for (const name of policy.neutral) {
    if (decided.has(name)) continue;
    const value = request.ambient[name];
    if (value !== undefined) decide(name, "admitted-neutral", value);
  }

  // 6. Defence in depth over whatever remains. Anything credential-shaped
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
