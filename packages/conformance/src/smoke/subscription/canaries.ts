/**
 * Canary classification over recorded subscription-isolation facts.
 *
 * The vocabulary below (`SubscriptionCanaryOutcome`, `SubscriptionCanaryResult`,
 * `toMarkdownTable`) is deliberately re-declared rather than imported from
 * `../claudexor/canaries.ts`, even though the shapes are identical. Extracting
 * a shared module would mean editing Q003's already-merged module for no
 * behavioural gain — this issue's "no unrelated backlog work" exclusion rules
 * that out — and it would couple two independently-evolving spikes (Claudexor
 * `/v2` semantics and subscription isolation) through a shared type for
 * cosmetic reasons only.
 *
 * As in `claudexor/canaries.ts`, the decisions are pure functions over
 * recorded facts; process work belongs to `probe.ts` and any opt-in driver
 * built on top of it. Pure: no network, filesystem, process, or clock access.
 */

import type { BillingRouteAttestation } from "./attestation.js";
import { escapeMarkdownTableCell } from "./environment-diff.js";
import type { VariableDecision } from "./variables.js";

export type SubscriptionCanaryOutcome = "supported" | "unsupported" | "degraded";

export type SubscriptionCanaryEvidence = Readonly<Record<string, string | number | boolean | null>>;

export interface SubscriptionCanaryResult {
  readonly name: string;
  readonly outcome: SubscriptionCanaryOutcome;
  readonly evidence: SubscriptionCanaryEvidence;
  /** Bounded fallback to record in the ADR when the behaviour is not supported. */
  readonly fallback?: string;
}

/** Facts canary `hostileAmbient` gathers around one hostile-environment build. */
export interface HostileAmbientFacts {
  /** The hostile-catalogue names this scenario injected into the ambient environment. */
  readonly injectedHostileNames: readonly string[];
  readonly decisions: readonly VariableDecision[];
  readonly attestation: BillingRouteAttestation;
  /**
   * FIX-6: the actual built child-process environment, not merely the
   * decision list that claims to describe it. Without this field the canary
   * can only be as correct as `decisions` — a decision list that (by a bug
   * elsewhere) claims `denied-hostile` for a name that nonetheless made it
   * into `env` would be reported `supported` by a canary that trusts
   * `decisions` alone. Checking `env` directly closes that gap.
   */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Decision outcomes that are, by construction (`variables.ts`), NEVER the
 * ambient value — the recipe always substitutes its own fixed or derived
 * value regardless of what `ambient` said. `PATH` (`"admitted-fixed"`, review
 * finding 2) and every config-home variable (`"admitted-config-home"`) both
 * legitimately appear under their original NAME in the built `env`, so their
 * mere presence there is not evidence the ambient/hostile value leaked
 * through — unlike `"admitted-carrier"` or `"admitted-neutral"`, where the
 * admitted value genuinely IS (or could be) the ambient one.
 */
const SAFE_SUBSTITUTION_OUTCOMES: ReadonlySet<string> = new Set([
  "admitted-fixed",
  "admitted-config-home",
]);

/**
 * Classify a hostile-ambient scenario.
 *
 * Three outcomes, checked in order, and nothing outside them is a silent
 * pass:
 *
 *  1. `unsupported` if any injected hostile name is present in the actual
 *     built `env`, OR its recorded decision's outcome starts with
 *     `admitted-` — UNLESS that decision's outcome is one of
 *     `SAFE_SUBSTITUTION_OUTCOMES` (review finding 2's interaction with
 *     FIX-6, below). Checking `env` directly (not just `decisions`) is the
 *     FIX-6 correction: the isolation recipe itself failing is the most
 *     severe outcome this canary can report, and it must not be
 *     falsifiable merely by a decision list that disagrees with what was
 *     actually built. The `SAFE_SUBSTITUTION_OUTCOMES` carve-out is a
 *     necessary correction discovered while generating this ADR's evidence:
 *     `PATH` is intentionally always present in `env` (fixed value, review
 *     finding 2), so a naive "present in env ⇒ unsupported" rule would
 *     misreport a properly-isolated `PATH` as a leak. The carve-out only
 *     applies to outcomes the recipe's own construction guarantees are never
 *     the ambient value — it does not weaken the FIX-6 ground-truth check
 *     for `"admitted-carrier"`/`"admitted-neutral"`, which genuinely can
 *     carry the ambient value through.
 *  2. `degraded` if at least one injected hostile name has NO recorded
 *     decision at all (never processed) — this is explicitly "not
 *     evaluated", not "evaluated and found absent", and must not collapse
 *     into a lenient default of `supported`.
 *  3. `degraded` if every injected hostile name was evaluated and excluded,
 *     but the resulting attestation still is not `subscription` (the
 *     isolation held; the credential shape did not).
 *  4. `supported` only when every injected name was evaluated, excluded, AND
 *     absent from the built environment (or present only via a safe
 *     substitution), AND the attestation is `subscription`.
 */
export function classifyHostileAmbient(facts: HostileAmbientFacts): SubscriptionCanaryResult {
  const byName = new Map(facts.decisions.map((d) => [d.name, d]));

  const admittedOrPresent = facts.injectedHostileNames.filter((name) => {
    const decision = byName.get(name);
    if (decision !== undefined && SAFE_SUBSTITUTION_OUTCOMES.has(decision.outcome)) return false;
    if (Object.hasOwn(facts.env, name)) return true;
    return decision?.outcome.startsWith("admitted-") ?? false;
  });

  const notEvaluated = facts.injectedHostileNames.filter((name) => !byName.has(name));

  const evidence: SubscriptionCanaryEvidence = {
    injectedHostileCount: facts.injectedHostileNames.length,
    admittedHostileCount: admittedOrPresent.length,
    route: facts.attestation.route,
  };

  if (admittedOrPresent.length > 0) {
    return {
      name: "hostileAmbient",
      outcome: "unsupported",
      evidence: { ...evidence, admittedNames: admittedOrPresent.join(",") },
      fallback:
        "At least one hostile-catalogue variable was present in the built child environment " +
        "or recorded as admitted; the allowlist construction failed to exclude it and must be " +
        "fixed before this recipe can be trusted for anything.",
    };
  }

  if (notEvaluated.length > 0) {
    return {
      name: "hostileAmbient",
      outcome: "degraded",
      evidence: { ...evidence, notEvaluatedNames: notEvaluated.join(",") },
      fallback:
        "At least one injected hostile-catalogue name has no recorded decision at all — it " +
        "was not evaluated, which is distinct from having been evaluated and found absent; " +
        "treat this as unverified rather than as a lenient pass.",
    };
  }

  if (facts.attestation.route !== "subscription") {
    return {
      name: "hostileAmbient",
      outcome: "degraded",
      evidence,
      fallback:
        `Hostile names were correctly excluded, but the resulting attestation route was ` +
        `"${facts.attestation.route}", not subscription; the isolation held, but the ` +
        "credential presented to the engine did not itself attest as a live subscription.",
    };
  }

  return { name: "hostileAmbient", outcome: "supported", evidence };
}

export type CredentialLifecycleScenario =
  | "baseline"
  | "expiry"
  | "revocation"
  | "carrier_absent"
  | "logged_out";

/** Facts canary `credentialLifecycle` gathers around one lifecycle scenario. */
export interface CredentialLifecycleFacts {
  readonly scenario: CredentialLifecycleScenario;
  readonly carrierPresent: boolean;
  readonly attestation: BillingRouteAttestation;
}

/**
 * Classify a credential-lifecycle scenario (an ordinary baseline run, expiry,
 * revocation, an absent carrier, or a logged-out probe).
 *
 * Review finding 3 (inversion fix): the prior implementation's fourth branch
 * — "a carrier is present and the attestation is `subscription` outside an
 * expiry/revocation probe → `supported`" — silently covered `logged_out`
 * too, so `{scenario: "logged_out", carrierPresent: true, route:
 * "subscription"}` (a logout that did NOT take effect) was reported as a
 * PASS. That is exactly backwards: a logout scenario whose diagnostic still
 * shows a live subscription route means the session survived the logout
 * attempt, which must never be `supported`. This function now branches on
 * `scenario` explicitly, so `logged_out` has its own rules rather than
 * falling into the generic "ordinary case" branch:
 *
 *  - `baseline`: `subscription` → `supported`; `api_key` or `third_party` →
 *    `unsupported`; anything else → `degraded`.
 *  - `carrier_absent`: `none` → `supported` (fails closed); `api_key` →
 *    `unsupported` (F-3 / the §9.1 silent-fallback violation); anything else
 *    → `degraded`.
 *  - `logged_out`: `none` → `supported`; `api_key` → `unsupported`;
 *    `subscription` → **`unsupported`** — the logout did not take effect and
 *    the session survived it; anything else → `degraded`.
 *  - `expiry` / `revocation`: `none` → `supported` (fails closed); `api_key`
 *    → `unsupported`; `subscription` with `validity === "presence_only"` →
 *    `degraded` (F-4: the diagnostic proves presence and shape, never
 *    validity); anything else → `degraded`.
 *
 * Every `supported` verdict additionally requires
 * `attestation.exposedKeySources.length === 0` — a route that would
 * otherwise pass with a visible key source still downgrades to
 * `unsupported`, never a silent pass.
 */
export function classifyCredentialLifecycle(
  facts: CredentialLifecycleFacts,
): SubscriptionCanaryResult {
  const evidence: SubscriptionCanaryEvidence = {
    scenario: facts.scenario,
    carrierPresent: facts.carrierPresent,
    route: facts.attestation.route,
    validity: facts.attestation.validity,
  };

  const supported = (): SubscriptionCanaryResult => {
    if (facts.attestation.exposedKeySources.length > 0) {
      return {
        name: "credentialLifecycle",
        outcome: "unsupported",
        evidence,
        fallback:
          "The attestation would otherwise pass, but it also reports an exposed key source; a " +
          "supported verdict must never be reached while any key-source variable is visible.",
      };
    }
    return { name: "credentialLifecycle", outcome: "supported", evidence };
  };

  const unsupported = (fallback: string): SubscriptionCanaryResult => ({
    name: "credentialLifecycle",
    outcome: "unsupported",
    evidence,
    fallback,
  });

  const degraded = (fallback: string): SubscriptionCanaryResult => ({
    name: "credentialLifecycle",
    outcome: "degraded",
    evidence,
    fallback,
  });

  const route = facts.attestation.route;

  switch (facts.scenario) {
    case "baseline": {
      if (route === "subscription") return supported();
      if (route === "api_key" || route === "third_party") {
        return unsupported(
          `A baseline run attested route="${route}", not subscription; this is not the ` +
            "ordinary successful case this scenario represents.",
        );
      }
      return degraded(
        `A baseline run attested route="${route}", which is neither a clean pass nor an ` +
          "unambiguous non-subscription route; treat this as unverified rather than a pass.",
      );
    }

    case "carrier_absent": {
      if (route === "none") return supported();
      if (route === "api_key") {
        return unsupported(
          "With no subscription carrier present, the run attested as api_key: an ambient API " +
            "key silently became the effective route. §9.1 forbids a subscription_only run " +
            "from silently falling back to an API key; the runtime must fail closed here " +
            "(assertSubscriptionOnly), not proceed.",
        );
      }
      return degraded(
        `With no subscription carrier present, the run attested route="${route}", which is ` +
          "neither the expected fail-closed none nor the api_key silent-fallback this scenario " +
          "exists to catch; treat this as unverified.",
      );
    }

    case "logged_out": {
      if (route === "none") return supported();
      if (route === "api_key") {
        return unsupported(
          "A logged-out probe attested route=api_key: an ambient API key became the effective " +
            "route instead of the expected logged-out none.",
        );
      }
      if (route === "subscription") {
        // The inversion this finding fixes: a logout scenario whose
        // diagnostic still shows a live subscription route means the logout
        // did NOT take effect and the session survived it. That must never
        // be reported as a pass.
        return unsupported(
          "A logged-out probe still attested route=subscription: the logout did not take " +
            "effect and the session survived it. A logout scenario reporting a live " +
            "subscription route must never be treated as a pass.",
        );
      }
      return degraded(
        `A logged-out probe attested route="${route}", which is not one of the enumerated ` +
          "logged-out outcomes; treat this as unverified rather than a pass.",
      );
    }

    case "expiry":
    case "revocation": {
      if (route === "none") return supported();
      if (route === "api_key") {
        return unsupported(
          `An ${facts.scenario} probe attested route=api_key: an ambient API key became the ` +
            "effective route instead of failing closed.",
        );
      }
      if (route === "subscription" && facts.attestation.validity === "presence_only") {
        return degraded(
          "The diagnostic attests only presence and shape, never validity: an expired or " +
            "revoked credential can still report as logged in. Validity over time cannot be " +
            "proven without a metered provider round-trip, which this issue excludes.",
        );
      }
      return degraded(
        `An ${facts.scenario} probe attested route="${route}" ` +
          `(validity="${facts.attestation.validity}"), which is not one of the enumerated ` +
          "cases; treat this as unverified.",
      );
    }

    default: {
      // Totality: an unrecognised scenario value must never resolve to a
      // pass. TypeScript's exhaustiveness check makes this branch
      // unreachable for any statically-known CredentialLifecycleScenario.
      const exhaustive: never = facts.scenario;
      return degraded(
        `Unrecognised credential-lifecycle scenario "${String(exhaustive)}"; treat as unverified.`,
      );
    }
  }
}

/** Render canary results as the ADR's observation table.
 *
 * Review finding 11: cell escaping (pipe/newline/lone-`\r` escaping, and the
 * cell-length bound) is imported from `environment-diff.ts`'s
 * `escapeMarkdownTableCell` rather than duplicated here — a canary's `name`
 * and `evidence` values are, in principle, just as attacker/ambient-
 * influenced as a `VariableDecision` name, so both renderers must apply the
 * identical rule from a single source, not two independently-maintained
 * copies that could drift apart.
 */
export function toMarkdownTable(results: readonly SubscriptionCanaryResult[]): string {
  const lines = ["| canary | outcome | evidence |", "| --- | --- | --- |"];
  for (const result of results) {
    const evidence = Object.entries(result.evidence)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("; ");
    lines.push(
      `| ${escapeMarkdownTableCell(result.name)} | ${escapeMarkdownTableCell(result.outcome)} | ${escapeMarkdownTableCell(evidence)} |`,
    );
  }
  return lines.join("\n");
}
