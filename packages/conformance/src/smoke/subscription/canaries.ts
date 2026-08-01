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
}

/**
 * Classify a hostile-ambient scenario.
 *
 * `unsupported` if any injected hostile name was admitted into the built
 * environment — that is the isolation recipe itself failing, the most severe
 * outcome this canary can report. `degraded` if the recipe correctly excluded
 * every hostile name but the resulting attestation still is not
 * `subscription` (the isolation held; the credential shape did not). Anything
 * short of both holding is never reported as a silent pass.
 */
export function classifyHostileAmbient(facts: HostileAmbientFacts): SubscriptionCanaryResult {
  const byName = new Map(facts.decisions.map((d) => [d.name, d]));
  const admitted = facts.injectedHostileNames.filter((name) => {
    const decision = byName.get(name);
    return decision?.outcome.startsWith("admitted-") ?? false;
  });

  const evidence: SubscriptionCanaryEvidence = {
    injectedHostileCount: facts.injectedHostileNames.length,
    admittedHostileCount: admitted.length,
    route: facts.attestation.route,
  };

  if (admitted.length > 0) {
    return {
      name: "hostileAmbient",
      outcome: "unsupported",
      evidence: { ...evidence, admittedNames: admitted.join(",") },
      fallback:
        "At least one hostile-catalogue variable was admitted into the child environment; " +
        "the allowlist construction failed to exclude it and must be fixed before this " +
        "recipe can be trusted for anything.",
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

export type CredentialLifecycleScenario = "expiry" | "revocation" | "carrier_absent" | "logged_out";

/** Facts canary `credentialLifecycle` gathers around one lifecycle scenario. */
export interface CredentialLifecycleFacts {
  readonly scenario: CredentialLifecycleScenario;
  readonly carrierPresent: boolean;
  readonly attestation: BillingRouteAttestation;
}

/**
 * Classify a credential-lifecycle scenario (expiry, revocation, an absent
 * carrier, or an ordinary logged-out state).
 *
 * Four cases, in order, and nothing outside them is ever a silent pass:
 *
 *  1. No carrier present, and the attestation nonetheless resolves to
 *     `api_key` → `unsupported`. This is F-3 (design §2, scenario G3) and the
 *     exact §9.1 violation: an ambient API key silently became the effective
 *     route with no subscription carrier in play at all.
 *  2. No carrier present, and the attestation resolves to `none` → `supported`.
 *     This is the correct fail-closed behaviour: no credential, no route.
 *  3. A carrier IS present, the scenario is specifically an expiry or
 *     revocation probe, and the attestation is (as it always is here)
 *     `presence_only` → `degraded`. This is F-4: the local diagnostic proves
 *     presence and shape, never validity, so a subscription-shaped
 *     attestation under an expiry/revocation scenario is not a pass — it is
 *     the exact limit this canary exists to record.
 *  4. A carrier is present and the attestation is `subscription` outside an
 *     expiry/revocation probe → `supported`: the ordinary, expected case.
 *
 * Any carrier/route/scenario combination outside these four is `degraded`
 * rather than defaulting to `supported` — an unenumerated combination is
 * unverified, never assumed fine.
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

  if (!facts.carrierPresent && facts.attestation.route === "api_key") {
    return {
      name: "credentialLifecycle",
      outcome: "unsupported",
      evidence,
      fallback:
        "With no subscription carrier present, the run attested as api_key: an ambient API " +
        "key silently became the effective route. §9.1 forbids a subscription_only run from " +
        "silently falling back to an API key; the runtime must fail closed here " +
        "(assertSubscriptionOnly), not proceed.",
    };
  }

  if (!facts.carrierPresent && facts.attestation.route === "none") {
    return { name: "credentialLifecycle", outcome: "supported", evidence };
  }

  if (
    facts.carrierPresent &&
    (facts.scenario === "expiry" || facts.scenario === "revocation") &&
    facts.attestation.validity === "presence_only"
  ) {
    return {
      name: "credentialLifecycle",
      outcome: "degraded",
      evidence,
      fallback:
        "The diagnostic attests only presence and shape, never validity: an expired or " +
        "revoked credential can still report as logged in. Validity over time cannot be " +
        "proven without a metered provider round-trip, which this issue excludes.",
    };
  }

  if (facts.carrierPresent && facts.attestation.route === "subscription") {
    return { name: "credentialLifecycle", outcome: "supported", evidence };
  }

  return {
    name: "credentialLifecycle",
    outcome: "degraded",
    evidence,
    fallback:
      "This carrier/route/scenario combination is not one of the enumerated lifecycle " +
      "cases; treat it as unverified rather than as a pass.",
  };
}

/** Render canary results as the ADR's observation table. */
export function toMarkdownTable(results: readonly SubscriptionCanaryResult[]): string {
  const lines = ["| canary | outcome | evidence |", "| --- | --- | --- |"];
  for (const result of results) {
    const evidence = Object.entries(result.evidence)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("; ");
    lines.push(`| ${result.name} | ${result.outcome} | ${evidence} |`);
  }
  return lines.join("\n");
}
