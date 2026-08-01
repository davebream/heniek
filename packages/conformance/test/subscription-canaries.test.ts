import { describe, expect, it } from "vitest";
import type { BillingRouteAttestation } from "../src/smoke/subscription/attestation.js";
import {
  classifyCredentialLifecycle,
  classifyHostileAmbient,
  type HostileAmbientFacts,
  toMarkdownTable,
} from "../src/smoke/subscription/canaries.js";
import type { VariableDecision } from "../src/smoke/subscription/variables.js";

function subscriptionAttestation(
  overrides: Partial<BillingRouteAttestation> = {},
): BillingRouteAttestation {
  return {
    engine: "claude",
    route: "subscription",
    validity: "presence_only",
    exposedKeySources: [],
    detail: "test fixture",
    ...overrides,
  };
}

function decision(name: string, outcome: VariableDecision["outcome"]): VariableDecision {
  return { name, outcome, presentInAmbient: true };
}

describe("classifyHostileAmbient", () => {
  const cleanFacts: HostileAmbientFacts = {
    injectedHostileNames: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK"],
    decisions: [
      decision("ANTHROPIC_API_KEY", "denied-hostile"),
      decision("CLAUDE_CODE_USE_BEDROCK", "denied-hostile"),
      decision("CLAUDE_CODE_OAUTH_TOKEN", "admitted-carrier"),
    ],
    attestation: subscriptionAttestation(),
  };

  it("supports the fully satisfied case: every hostile name denied, route is subscription", () => {
    expect(classifyHostileAmbient(cleanFacts).outcome).toBe("supported");
  });

  it("reports unsupported when any injected hostile name was admitted", () => {
    const facts: HostileAmbientFacts = {
      ...cleanFacts,
      decisions: [
        decision("ANTHROPIC_API_KEY", "admitted-neutral"),
        decision("CLAUDE_CODE_USE_BEDROCK", "denied-hostile"),
      ],
    };
    const result = classifyHostileAmbient(facts);
    expect(result.outcome).toBe("unsupported");
    expect(result.fallback).toMatch(/allowlist construction failed/);
  });

  it("degrades when hostile names were excluded but the route is not subscription", () => {
    const result = classifyHostileAmbient({
      ...cleanFacts,
      attestation: subscriptionAttestation({ route: "indeterminate" }),
    });
    expect(result.outcome).toBe("degraded");
    expect(result.fallback).toMatch(/isolation held/);
  });

  // Negative control: an injected name absent from `decisions` altogether
  // (never processed) must not be treated as "admitted" by a lenient default.
  it("does not treat a missing decision as an admission", () => {
    const result = classifyHostileAmbient({
      injectedHostileNames: ["ANTHROPIC_API_KEY"],
      decisions: [],
      attestation: subscriptionAttestation(),
    });
    expect(result.outcome).toBe("supported");
  });
});

describe("classifyCredentialLifecycle", () => {
  it("reports unsupported when no carrier is present but the route is api_key (F-3 / §9.1)", () => {
    const result = classifyCredentialLifecycle({
      scenario: "carrier_absent",
      carrierPresent: false,
      attestation: subscriptionAttestation({ route: "api_key" }),
    });
    expect(result.outcome).toBe("unsupported");
    expect(result.fallback).toMatch(/§9.1/);
  });

  it("reports supported when no carrier is present and the route correctly resolves to none", () => {
    const result = classifyCredentialLifecycle({
      scenario: "carrier_absent",
      carrierPresent: false,
      attestation: subscriptionAttestation({ route: "none" }),
    });
    expect(result.outcome).toBe("supported");
  });

  it.each(["expiry", "revocation"] as const)(
    "degrades a %s scenario with a carrier present, citing the presence-only limit (F-4)",
    (scenario) => {
      const result = classifyCredentialLifecycle({
        scenario,
        carrierPresent: true,
        attestation: subscriptionAttestation(),
      });
      expect(result.outcome).toBe("degraded");
      expect(result.fallback).toMatch(/never validity/);
    },
  );

  it("supports the ordinary case: carrier present, route subscription, not an expiry/revocation probe", () => {
    const result = classifyCredentialLifecycle({
      scenario: "logged_out",
      carrierPresent: true,
      attestation: subscriptionAttestation(),
    });
    expect(result.outcome).toBe("supported");
  });

  // Total fallback: an unenumerated combination must never default to a pass.
  it("[regression] a carrier present with route=none outside any enumerated case is degraded, not a silent pass", () => {
    const result = classifyCredentialLifecycle({
      scenario: "logged_out",
      carrierPresent: true,
      attestation: subscriptionAttestation({ route: "none" }),
    });
    expect(result.outcome).toBe("degraded");
    expect(result.fallback).toMatch(/unverified/);
  });
});

describe("toMarkdownTable", () => {
  it("renders one row per canary with its evidence", () => {
    const table = toMarkdownTable([
      classifyHostileAmbient({
        injectedHostileNames: ["ANTHROPIC_API_KEY"],
        decisions: [decision("ANTHROPIC_API_KEY", "denied-hostile")],
        attestation: subscriptionAttestation(),
      }),
      classifyCredentialLifecycle({
        scenario: "carrier_absent",
        carrierPresent: false,
        attestation: subscriptionAttestation({ route: "none" }),
      }),
    ]);
    const rows = table.split("\n");
    expect(rows).toHaveLength(4);
    expect(table).toContain("hostileAmbient");
    expect(table).toContain("credentialLifecycle");
    for (const row of rows) expect(row.startsWith("|")).toBe(true);
  });
});
