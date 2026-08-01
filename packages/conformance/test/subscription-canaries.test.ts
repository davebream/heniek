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
    env: { CLAUDE_CODE_OAUTH_TOKEN: "SENTINEL-CARRIER-NOT-REAL", PATH: "/usr/bin" },
  };

  it("supports the fully satisfied case: every hostile name denied, absent from env, route is subscription", () => {
    expect(classifyHostileAmbient(cleanFacts).outcome).toBe("supported");
  });

  it("reports unsupported when any injected hostile name was admitted (per decisions)", () => {
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

  // FIX-6 positive control: the decision list can lie (a bug elsewhere could
  // record "denied" while the value still made it into the built
  // environment). Checking `env` directly closes that gap — this must be
  // `unsupported` even though every decision says denied-hostile.
  it("[regression] reports unsupported when a hostile name is present in env even though its decision says denied-hostile", () => {
    const facts: HostileAmbientFacts = {
      ...cleanFacts,
      env: { ...cleanFacts.env, ANTHROPIC_API_KEY: "SENTINEL-LEAKED-NOT-REAL" },
    };
    const result = classifyHostileAmbient(facts);
    expect(result.outcome).toBe("unsupported");
  });

  it("degrades when hostile names were excluded but the route is not subscription", () => {
    const result = classifyHostileAmbient({
      ...cleanFacts,
      attestation: subscriptionAttestation({ route: "indeterminate" }),
    });
    expect(result.outcome).toBe("degraded");
    expect(result.fallback).toMatch(/isolation held/);
  });

  // FIX-6: an injected name absent from `decisions` altogether (never
  // processed) must not be treated as a lenient "supported" default. It is
  // "not evaluated", a distinct and less trustworthy state than "evaluated
  // and found absent", and must be reported as degraded rather than a pass.
  it("[regression] degrades, rather than silently passing, when an injected hostile name has no recorded decision at all", () => {
    const result = classifyHostileAmbient({
      injectedHostileNames: ["ANTHROPIC_API_KEY"],
      decisions: [],
      attestation: subscriptionAttestation(),
      env: { PATH: "/usr/bin" },
    });
    expect(result.outcome).toBe("degraded");
    expect(result.fallback).toMatch(/not evaluated/);
  });

  // Discovered while generating this ADR's evidence tables (review finding 2
  // interacting with FIX-6): PATH is legitimately always present in `env`
  // under the fixed ISOLATED_PATH value (never the ambient one). A naive
  // "present in env ⇒ unsupported" ground-truth check would misreport a
  // properly-isolated PATH as a leaked hostile name. This must be
  // `supported`, not `unsupported`, when PATH is injected as a hostile name
  // but its decision is `admitted-fixed`.
  it("[regression] PATH being present in env with outcome admitted-fixed is not treated as a leak", () => {
    const result = classifyHostileAmbient({
      injectedHostileNames: ["ANTHROPIC_API_KEY", "PATH"],
      decisions: [
        decision("ANTHROPIC_API_KEY", "denied-hostile"),
        decision("PATH", "admitted-fixed"),
        decision("CLAUDE_CODE_OAUTH_TOKEN", "admitted-carrier"),
      ],
      attestation: subscriptionAttestation(),
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "SENTINEL-CARRIER-NOT-REAL",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
    });
    expect(result.outcome).toBe("supported");
  });

  // The safe-substitution carve-out must not weaken the FIX-6 ground-truth
  // check for outcomes that genuinely CAN carry the ambient value: an
  // ordinary hostile name recorded as "admitted-carrier"/"admitted-neutral"
  // (rather than "admitted-fixed"/"admitted-config-home") and present in env
  // is still unsupported.
  it("[regression] a hostile name admitted as admitted-neutral (not a safe substitution) is still unsupported", () => {
    const result = classifyHostileAmbient({
      injectedHostileNames: ["ANTHROPIC_API_KEY"],
      decisions: [decision("ANTHROPIC_API_KEY", "admitted-neutral")],
      attestation: subscriptionAttestation(),
      env: { ANTHROPIC_API_KEY: "SENTINEL-LEAKED-NOT-REAL" },
    });
    expect(result.outcome).toBe("unsupported");
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

  it("supports the ordinary case: a baseline run attesting subscription", () => {
    const result = classifyCredentialLifecycle({
      scenario: "baseline",
      carrierPresent: true,
      attestation: subscriptionAttestation(),
    });
    expect(result.outcome).toBe("supported");
  });

  it("supports a logged-out probe that correctly resolves to route=none", () => {
    const result = classifyCredentialLifecycle({
      scenario: "logged_out",
      carrierPresent: true,
      attestation: subscriptionAttestation({ route: "none" }),
    });
    expect(result.outcome).toBe("supported");
  });

  // Review finding 3 — the inversion this fix corrects. Before this fix,
  // `{scenario: "logged_out", carrierPresent: true, route: "subscription"}`
  // was classified `supported` (a logout that did NOT take effect was
  // reported as a pass), while the correct post-logout `route: "none"` fell
  // through to a generic `degraded`. This is named for the inversion: the
  // logged-out+subscription combination must be `unsupported`, never a pass.
  it("[regression] the logout inversion: a logged-out probe that still attests subscription is unsupported, not supported", () => {
    const result = classifyCredentialLifecycle({
      scenario: "logged_out",
      carrierPresent: true,
      attestation: subscriptionAttestation({ route: "subscription" }),
    });
    expect(result.outcome).toBe("unsupported");
    expect(result.fallback).toMatch(/did not take effect/);
  });

  it("reports unsupported when a logged-out probe attests api_key", () => {
    const result = classifyCredentialLifecycle({
      scenario: "logged_out",
      carrierPresent: true,
      attestation: subscriptionAttestation({ route: "api_key" }),
    });
    expect(result.outcome).toBe("unsupported");
  });

  // Every supported branch additionally requires no exposed key source.
  it("[regression] a route that would otherwise pass is unsupported if a key source is exposed", () => {
    const result = classifyCredentialLifecycle({
      scenario: "baseline",
      carrierPresent: true,
      attestation: subscriptionAttestation({ exposedKeySources: ["ANTHROPIC_API_KEY"] }),
    });
    expect(result.outcome).toBe("unsupported");
  });

  // Total fallback: an unenumerated route within a scenario must never
  // default to a pass.
  it.each(["baseline", "carrier_absent", "logged_out", "expiry", "revocation"] as const)(
    "[regression] an indeterminate route under scenario=%s is degraded, not a silent pass",
    (scenario) => {
      const result = classifyCredentialLifecycle({
        scenario,
        carrierPresent: true,
        attestation: subscriptionAttestation({ route: "indeterminate" }),
      });
      expect(result.outcome).toBe("degraded");
      expect(result.fallback).toMatch(/unverified|not one of the enumerated/);
    },
  );
});

describe("toMarkdownTable", () => {
  it("renders one row per canary with its evidence", () => {
    const table = toMarkdownTable([
      classifyHostileAmbient({
        injectedHostileNames: ["ANTHROPIC_API_KEY"],
        decisions: [decision("ANTHROPIC_API_KEY", "denied-hostile")],
        attestation: subscriptionAttestation(),
        env: { PATH: "/usr/bin" },
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

  // FIX-12: consistent escaping with renderEnvironmentDiff. A canary's
  // `name` or `evidence` values are, in principle, just as
  // attacker/ambient-influenced as a VariableDecision's name — nothing stops
  // a caller from constructing a SubscriptionCanaryResult with a pipe or
  // newline embedded in either.
  it("escapes pipe and newline characters in rendered cells", () => {
    const table = toMarkdownTable([
      {
        name: "weird|name\nwith-break",
        outcome: "supported",
        evidence: { note: "a|b\nc" },
      },
    ]);
    const rows = table.split("\n");
    // Exactly 3 lines: header, separator, one data row — a raw unescaped
    // newline embedded in a cell would have split into extra lines instead.
    expect(rows).toHaveLength(3);
    expect(rows[2]).toBe("| weird\\|name with-break | supported | note=a\\|b c |");
  });
});
