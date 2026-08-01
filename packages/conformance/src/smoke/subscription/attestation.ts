/**
 * The proof: turn a CLI diagnostic into a billing-route attestation.
 *
 * The issue forbids proving anything from a metered API request, so every
 * attestation here comes from a local, offline diagnostic
 * (`claude auth status --json`, `heniek-codex login status`) and is
 * therefore always `presence_only` — it attests that a credential of a given
 * shape is present, never that a real request would honour it or that the
 * credential is still valid (design doc §2, finding F-4). `validity:
 * "provider_verified"` exists in the type only so a later issue that adds a
 * metered check can extend this without a breaking change; nothing here may
 * ever emit it.
 *
 * The classification order below is load-bearing and pinned by tests — see
 * `classifyClaudeBillingRoute`'s doc comment for why the order, not just the
 * individual conditions, matters.
 *
 * Pure except `parseClaudeAuthDiagnostic`'s JSON parsing, which touches no
 * process/network/filesystem/clock state — it only ever sees a string
 * already captured by `probe.ts`.
 */

import type { SubscriptionEngine } from "./variables.js";

export const BILLING_ROUTES = [
  "subscription",
  "api_key",
  "third_party",
  "none",
  "indeterminate",
] as const;
export type BillingRoute = (typeof BILLING_ROUTES)[number];

export type AttestationValidity = "presence_only" | "provider_verified";

export interface BillingRouteAttestation {
  readonly engine: SubscriptionEngine;
  readonly route: BillingRoute;
  readonly validity: AttestationValidity;
  /** Variable NAMES the CLI reported as visible — never a value. */
  readonly exposedKeySources: readonly string[];
  readonly detail: string;
}

export interface ClaudeAuthDiagnostic {
  readonly loggedIn: boolean;
  readonly authMethod: string;
  readonly apiProvider: string;
  readonly apiKeySource?: string;
}

/** `claude auth status --json` produced output this parser cannot trust. */
export class MalformedClaudeDiagnosticError extends Error {
  constructor(readonly field: string) {
    // Names the field the diagnostic was missing or malformed at; never the
    // raw stdout, which may legitimately contain fabricated sentinel values
    // this suite's own fixtures inject.
    super(
      `claude auth status --json produced a diagnostic that is missing or ` +
        `malformed at "${field}"; refusing to classify a billing route from ` +
        "unparseable output.",
    );
    this.name = "MalformedClaudeDiagnosticError";
  }
}

/** An environment-variable-name shape: what `apiKeySource` and any other CLI-reported "which variable is visible" field is expected to look like. */
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Parse `claude auth status --json` stdout into a `ClaudeAuthDiagnostic`.
 *
 * Throws `MalformedClaudeDiagnosticError` rather than fabricating a
 * placeholder diagnostic on bad input: any fabricated placeholder shape
 * risks accidentally satisfying one of `classifyClaudeBillingRoute`'s
 * conditions (for example, defaulting `loggedIn` to `false` would make
 * unparseable output classify as the same "none" route as a real logged-out
 * session — an honest "could not tell" masquerading as an honest "no
 * session"). `probe.ts`, the only caller that sees real process output, is
 * responsible for turning this throw into an `indeterminate` attestation.
 */
export function parseClaudeAuthDiagnostic(stdout: string): ClaudeAuthDiagnostic {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new MalformedClaudeDiagnosticError("<root>");
  }
  const record = asRecord(parsed);
  if (record === undefined) throw new MalformedClaudeDiagnosticError("<root>");

  const loggedIn = record["loggedIn"];
  if (typeof loggedIn !== "boolean") throw new MalformedClaudeDiagnosticError("loggedIn");

  const authMethod = record["authMethod"];
  if (typeof authMethod !== "string" || authMethod.length === 0) {
    throw new MalformedClaudeDiagnosticError("authMethod");
  }

  const apiProvider = record["apiProvider"];
  if (typeof apiProvider !== "string" || apiProvider.length === 0) {
    throw new MalformedClaudeDiagnosticError("apiProvider");
  }

  const rawApiKeySource = record["apiKeySource"];
  let apiKeySource: string | undefined;
  if (rawApiKeySource !== undefined) {
    // Review finding 6 (revises FIX-4): a structurally wrong type (not a
    // string at all) is still a genuine parse failure — the diagnostic's
    // shape itself cannot be trusted, so this still throws. But a value that
    // IS a string, just not env-var-name shaped (e.g. an `sk-`-prefixed
    // credential, an empty string), is a *finding about the diagnostic's
    // content*, not a parse failure — throwing on it would abort
    // classification entirely, when the honest and still fail-closed move is
    // to sanitise the value and keep going. `exposedKeySources` must stay
    // non-empty here (never dropped) so `assertSubscriptionOnly` still fails
    // closed on it; it must never contain the raw credential-shaped string,
    // so an unrecognised shape is replaced with the fixed literal
    // `<unexpected-value>` rather than passed through.
    if (typeof rawApiKeySource !== "string") {
      throw new MalformedClaudeDiagnosticError("apiKeySource");
    }
    apiKeySource = ENV_VAR_NAME_PATTERN.test(rawApiKeySource)
      ? rawApiKeySource
      : "<unexpected-value>";
  }

  // `exactOptionalPropertyTypes` forbids `apiKeySource: undefined` — the key
  // must be omitted entirely when the field was absent from the diagnostic.
  return apiKeySource === undefined
    ? { loggedIn, authMethod, apiProvider }
    : { loggedIn, authMethod, apiProvider, apiKeySource };
}

/**
 * Values `classifyClaudeBillingRoute` is willing to interpolate into a detail
 * message verbatim: `authMethod` and `apiProvider` strings this issue's own
 * observations actually recorded (design doc §2).
 */
const EXPECTED_DIAGNOSTIC_VALUES = new Set([
  "oauth_token",
  "api_key",
  "third_party",
  "none",
  "firstParty",
  "bedrock",
  "vertex",
]);

/**
 * Bound an engine-controlled string before it is interpolated into a detail
 * message.
 *
 * FIX-3: the previous implementation deleted everything except
 * `[A-Za-z0-9_.:-]` — a KEEP-list that happens to delete exactly the `/` and
 * space characters the committed-ADR redaction guard keys on
 * (`claudexor-trace.test.ts`'s `FORBIDDEN_SUBSTRINGS`/`FORBIDDEN_PATTERNS`),
 * while preserving every credential-prefix substring untouched (`sk-`,
 * `ghp_`, `Bearer` minus its trailing space, an absolute path minus its
 * slashes, ...). That is laundering, not redaction: it can make a forbidden
 * substring pass the guard's scan by stripping only the delimiter around it.
 *
 * This function instead does a POSITIVE shape check: a value is interpolated
 * verbatim only if it looks like an environment-variable name
 * (`ENV_VAR_NAME_PATTERN`, shared with `parseClaudeAuthDiagnostic`'s
 * `apiKeySource` validation) or is one of the small closed set of
 * `authMethod`/`apiProvider` values this issue's diagnostics actually
 * produce. Anything else — regardless of what characters it contains —
 * becomes the fixed literal `<unexpected-value>`.
 */
function bounded(value: string): string {
  if (ENV_VAR_NAME_PATTERN.test(value) || EXPECTED_DIAGNOSTIC_VALUES.has(value)) {
    return value;
  }
  return "<unexpected-value>";
}

/**
 * Classify a Claude diagnostic into a billing-route attestation.
 *
 * Order is load-bearing and pinned by tests:
 *
 *  1. `authMethod === "third_party"` OR `apiProvider !== "firstParty"` →
 *     `third_party`. Checked first because F-2 (design §2, E3/E4) shows
 *     `loggedIn` stays `true` under a provider-routing switch — an
 *     implementation that checks `loggedIn` before this would misclassify a
 *     silently re-routed run as a plain success.
 *  2. `authMethod === "api_key"` → `api_key`. An explicit API-key auth method
 *     is unambiguous and must not be reachable by the oauth_token branch below.
 *  3. `!loggedIn || authMethod === "none"` → `none`.
 *  4. `authMethod === "oauth_token"` → `subscription` **only when
 *     `apiKeySource` is absent**; otherwise `indeterminate`. This is F-1
 *     (design §2, D/E5): a subscription route and a visible ambient API key
 *     can coexist in the same diagnostic, and `apiKeySource`'s presence is
 *     the only discriminator. With a key visible, the diagnostic cannot say
 *     which credential an actual request would use, so the honest verdict is
 *     "unknown" and the guard fails closed — never "subscription" and never
 *     "api_key" either, since neither is actually known.
 *  5. Anything else → `indeterminate`. Total: an unrecognised `authMethod`
 *     must never resolve to a pass.
 */
export function classifyClaudeBillingRoute(
  diagnostic: ClaudeAuthDiagnostic,
): BillingRouteAttestation {
  const engine: SubscriptionEngine = "claude";
  const exposedKeySources: readonly string[] =
    diagnostic.apiKeySource !== undefined ? [diagnostic.apiKeySource] : [];

  if (diagnostic.authMethod === "third_party" || diagnostic.apiProvider !== "firstParty") {
    return {
      engine,
      route: "third_party",
      validity: "presence_only",
      exposedKeySources,
      detail:
        `authMethod="${bounded(diagnostic.authMethod)}" apiProvider="${bounded(diagnostic.apiProvider)}" ` +
        "routes through a third-party provider, not the named subscription.",
    };
  }

  if (diagnostic.authMethod === "api_key") {
    return {
      engine,
      route: "api_key",
      validity: "presence_only",
      exposedKeySources,
      detail:
        'authMethod="api_key" reports the effective route as an API key, not the named subscription.',
    };
  }

  if (!diagnostic.loggedIn || diagnostic.authMethod === "none") {
    return {
      engine,
      route: "none",
      validity: "presence_only",
      exposedKeySources,
      detail: "no session is logged in; there is no billing route to attest.",
    };
  }

  if (diagnostic.authMethod === "oauth_token") {
    if (diagnostic.apiKeySource === undefined) {
      return {
        engine,
        route: "subscription",
        validity: "presence_only",
        exposedKeySources,
        detail:
          "oauth_token session with no visible apiKeySource; this attests presence of a " +
          "subscription credential, not the route an actual request would take.",
      };
    }
    return {
      engine,
      route: "indeterminate",
      validity: "presence_only",
      exposedKeySources,
      detail:
        `oauth_token session, but apiKeySource="${bounded(diagnostic.apiKeySource)}" is also ` +
        "visible; a real request's effective route cannot be attested from this diagnostic alone.",
    };
  }

  return {
    engine,
    route: "indeterminate",
    validity: "presence_only",
    exposedKeySources,
    detail: `authMethod="${bounded(diagnostic.authMethod)}" is not a recognised value; refusing to guess a billing route.`,
  };
}

// Stable, case-insensitive substrings observed in (or defensively anticipated
// for) `heniek-codex login status` output. Only the subscription pattern was
// actually observed on this host (design doc §2, F1/F2); the other two are
// defensive and are documented as unverified in the ADR.
const CODEX_SUBSCRIPTION_PATTERN = /logged in using chatgpt/i;
const CODEX_API_KEY_PATTERN = /logged in using an? api key/i;
const CODEX_NOT_LOGGED_IN_PATTERN = /not logged in/i;

/**
 * Classify `heniek-codex login status` stdout into a billing-route
 * attestation, by stable substring — never by a loose "Logged in" match,
 * which would classify an API-key login as a subscription (see the
 * regression test pinning this in `subscription-attestation.test.ts`).
 *
 * FIX-15: ambiguity-safe ordering. The previous implementation took the
 * first matching branch in a fixed order (API-key, then subscription, then
 * not-logged-in), which is only correct if the three patterns are disjoint —
 * an assumption this issue never verified, because only the ChatGPT-
 * subscription phrasing was ever actually observed on the pinned host (F1,
 * F2); the API-key and not-logged-in patterns are defensive and unverified
 * (see the ADR's "Not covered" section). If a future CLI output matched more
 * than one pattern, first-match-wins would silently pick a route rather than
 * surface the ambiguity. This function instead counts matches and returns
 * `indeterminate` whenever more than one pattern fires, rather than trusting
 * pattern order to resolve the conflict.
 *
 * Total: any text that matches none of the three patterns, or more than one
 * of them, classifies as `indeterminate`, never as a pass. The raw text is
 * never included in the detail message, since it is uncontrolled CLI output
 * that this suite's own fixtures may have filled with sentinel values.
 */
export function classifyCodexBillingRoute(stdout: string): BillingRouteAttestation {
  const engine: SubscriptionEngine = "codex";

  const isApiKey = CODEX_API_KEY_PATTERN.test(stdout);
  const isSubscription = CODEX_SUBSCRIPTION_PATTERN.test(stdout);
  const isNotLoggedIn = CODEX_NOT_LOGGED_IN_PATTERN.test(stdout);
  const matchCount = [isApiKey, isSubscription, isNotLoggedIn].filter(Boolean).length;

  if (matchCount > 1) {
    return {
      engine,
      route: "indeterminate",
      validity: "presence_only",
      exposedKeySources: [],
      detail:
        "login status output matched more than one recognised phrasing; the patterns are " +
        "assumed disjoint but that assumption is unverified, so the honest verdict when it " +
        "fails is indeterminate, not a guess at which pattern should win.",
    };
  }

  if (isApiKey) {
    return {
      engine,
      route: "api_key",
      validity: "presence_only",
      exposedKeySources: [],
      detail: "login status reports an API-key login, not the named subscription.",
    };
  }

  if (isSubscription) {
    return {
      engine,
      route: "subscription",
      validity: "presence_only",
      exposedKeySources: [],
      detail: "login status reports a ChatGPT subscription login.",
    };
  }

  if (isNotLoggedIn) {
    return {
      engine,
      route: "none",
      validity: "presence_only",
      exposedKeySources: [],
      detail: "login status reports no active session.",
    };
  }

  return {
    engine,
    route: "indeterminate",
    validity: "presence_only",
    exposedKeySources: [],
    detail:
      "login status output did not match any recognised phrasing; refusing to guess a billing route.",
  };
}

/** An attestation that is not an unambiguous, exclusively-subscription route. */
export class SubscriptionRouteViolationError extends Error {
  constructor(readonly attestation: BillingRouteAttestation) {
    // Names the route and any exposed key-source variable NAMES — never a
    // value — matching this recipe's "errors name variables, never values" rule.
    super(
      `${attestation.engine} billing route is not subscription-only (route="${attestation.route}")` +
        (attestation.exposedKeySources.length > 0
          ? `; visible key-source variable(s): ${attestation.exposedKeySources.join(", ")}`
          : "") +
        ". A subscription-only run must fail rather than silently proceed on another billing route.",
    );
    this.name = "SubscriptionRouteViolationError";
  }
}

/**
 * Throw unless `attestation.route === "subscription"` AND no key source is
 * exposed. Both conditions are required: a `subscription` route with a
 * visible key source cannot happen through `classifyClaudeBillingRoute`
 * (order rule 4 downgrades that combination to `indeterminate`), but this
 * assertion does not rely on that invariant holding elsewhere — it re-checks
 * `exposedKeySources` directly so a future caller building an attestation by
 * hand cannot bypass the guard.
 */
export function assertSubscriptionOnly(attestation: BillingRouteAttestation): void {
  if (attestation.route !== "subscription" || attestation.exposedKeySources.length > 0) {
    throw new SubscriptionRouteViolationError(attestation);
  }
}
