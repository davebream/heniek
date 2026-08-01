import { describe, expect, it } from "vitest";
import {
  assertSubscriptionOnly,
  type BillingRouteAttestation,
  type ClaudeAuthDiagnostic,
  classifyClaudeBillingRoute,
  classifyCodexBillingRoute,
  MalformedClaudeDiagnosticError,
  parseClaudeAuthDiagnostic,
  SubscriptionRouteViolationError,
} from "../src/smoke/subscription/attestation.js";

// One case per row of the design doc's grounded observation table (§2),
// mapping each `claude auth status --json` shape to the route this issue
// requires `classifyClaudeBillingRoute` to attest. Sentinel key-source names
// avoid the "sk-"/"ghp_"/etc. prefixes the committed-ADR redaction guard
// forbids; the CLI reports a variable NAME here, never a credential value.
const SENTINEL_KEY_SOURCE = "ANTHROPIC_API_KEY";

describe("classifyClaudeBillingRoute — the A–G matrix", () => {
  it.each<[string, ClaudeAuthDiagnostic, string]>([
    [
      "A — ambient hostile key, no isolation: oauth_token + visible apiKeySource",
      {
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        apiKeySource: SENTINEL_KEY_SOURCE,
      },
      "indeterminate",
    ],
    [
      "B — scrubbed env, no carrier: not logged in",
      { loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
      "none",
    ],
    [
      "C — isolated + carrier, hostile names denied: oauth_token, no apiKeySource",
      { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" },
      "subscription",
    ],
    [
      "D — C plus a leaked ANTHROPIC_API_KEY",
      {
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        apiKeySource: SENTINEL_KEY_SOURCE,
      },
      "indeterminate",
    ],
    [
      "E1 — C plus ANTHROPIC_AUTH_TOKEN (unchanged from C per the diagnostic)",
      { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" },
      "subscription",
    ],
    [
      "E2 — C plus ANTHROPIC_BASE_URL (unchanged from C per the diagnostic)",
      { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" },
      "subscription",
    ],
    [
      "E3 — C plus CLAUDE_CODE_USE_BEDROCK=1",
      { loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" },
      "third_party",
    ],
    [
      "E4 — C plus CLAUDE_CODE_USE_VERTEX=1",
      { loggedIn: true, authMethod: "third_party", apiProvider: "vertex" },
      "third_party",
    ],
    [
      "E5 — C plus API key and auth token together, as D",
      {
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        apiKeySource: SENTINEL_KEY_SOURCE,
      },
      "indeterminate",
    ],
    [
      "G1 — isolated home + fabricated carrier: reports as C",
      { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" },
      "subscription",
    ],
    [
      "G2 — isolated home + empty carrier: not logged in",
      { loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
      "none",
    ],
    [
      "G3 — isolated home, no carrier, hostile key present: api_key",
      {
        loggedIn: true,
        authMethod: "api_key",
        apiProvider: "firstParty",
        apiKeySource: SENTINEL_KEY_SOURCE,
      },
      "api_key",
    ],
  ])("%s -> %s", (_label, diagnostic, expectedRoute) => {
    expect(classifyClaudeBillingRoute(diagnostic).route).toBe(expectedRoute);
  });

  it("validity is always presence_only, never provider_verified", () => {
    const diagnostics: ClaudeAuthDiagnostic[] = [
      { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" },
      { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" },
      { loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
      { loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" },
      { loggedIn: true, authMethod: "mystery", apiProvider: "firstParty" },
    ];
    for (const diagnostic of diagnostics) {
      expect(classifyClaudeBillingRoute(diagnostic).validity).toBe("presence_only");
    }
  });

  it("classifies an unrecognised authMethod as indeterminate rather than a pass (totality)", () => {
    const result = classifyClaudeBillingRoute({
      loggedIn: true,
      authMethod: "some-future-auth-method",
      apiProvider: "firstParty",
    });
    expect(result.route).toBe("indeterminate");
  });

  it("carries the apiKeySource through as an exposed key-source NAME, never a value", () => {
    const result = classifyClaudeBillingRoute({
      loggedIn: true,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
      apiKeySource: SENTINEL_KEY_SOURCE,
    });
    expect(result.exposedKeySources).toEqual([SENTINEL_KEY_SOURCE]);
  });
});

describe("classifyClaudeBillingRoute — regression: order is load-bearing", () => {
  // The defect: attesting on `authMethod === "oauth_token"` alone passes D
  // and E5, where a visible ambient API key coexists with an oauth_token
  // session. The only correct discriminator is apiKeySource's presence.
  it("[regression] does not classify D/E5 (oauth_token + visible apiKeySource) as subscription", () => {
    const result = classifyClaudeBillingRoute({
      loggedIn: true,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
      apiKeySource: SENTINEL_KEY_SOURCE,
    });
    expect(result.route).not.toBe("subscription");
    expect(result.route).toBe("indeterminate");
  });

  // The defect: attesting on `loggedIn === true` alone passes E3/E4, where a
  // provider-routing switch silently re-routes billing while loggedIn stays true.
  it("[regression] does not classify a loggedIn=true, third-party-routed session as subscription", () => {
    const bedrock = classifyClaudeBillingRoute({
      loggedIn: true,
      authMethod: "third_party",
      apiProvider: "bedrock",
    });
    const vertex = classifyClaudeBillingRoute({
      loggedIn: true,
      authMethod: "third_party",
      apiProvider: "vertex",
    });
    expect(bedrock.route).toBe("third_party");
    expect(vertex.route).toBe("third_party");
  });

  // The defect: treating the local diagnostic as validity lets a fabricated
  // carrier (G1) attest as a live subscription. The route classification for
  // G1 is legitimately "subscription" (the diagnostic shape matches a real
  // session), but this pins that its `validity` can never be upgraded beyond
  // presence_only on that basis alone — G1's whole point is that this
  // diagnostic cannot tell a fabricated token from a real one.
  it("[regression] a G1-shaped (fabricated carrier) diagnostic never attests provider_verified", () => {
    const result = classifyClaudeBillingRoute({
      loggedIn: true,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
    });
    expect(result.route).toBe("subscription");
    expect(result.validity).toBe("presence_only");
  });
});

describe("parseClaudeAuthDiagnostic", () => {
  it("parses a full diagnostic including apiKeySource", () => {
    const diagnostic = parseClaudeAuthDiagnostic(
      JSON.stringify({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        apiKeySource: SENTINEL_KEY_SOURCE,
      }),
    );
    expect(diagnostic).toEqual({
      loggedIn: true,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
      apiKeySource: SENTINEL_KEY_SOURCE,
    });
  });

  it("parses a diagnostic without apiKeySource and omits the key entirely", () => {
    const diagnostic = parseClaudeAuthDiagnostic(
      JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }),
    );
    expect(diagnostic).toEqual({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" });
    expect(Object.hasOwn(diagnostic, "apiKeySource")).toBe(false);
  });

  it("throws MalformedClaudeDiagnosticError on invalid JSON", () => {
    expect(() => parseClaudeAuthDiagnostic("not json at all {{{")).toThrow(
      MalformedClaudeDiagnosticError,
    );
  });

  it.each([
    ["a JSON array", "[1,2,3]"],
    ["missing loggedIn", JSON.stringify({ authMethod: "none", apiProvider: "firstParty" })],
    [
      "a non-boolean loggedIn",
      JSON.stringify({ loggedIn: "yes", authMethod: "none", apiProvider: "firstParty" }),
    ],
    ["missing authMethod", JSON.stringify({ loggedIn: true, apiProvider: "firstParty" })],
    ["missing apiProvider", JSON.stringify({ loggedIn: true, authMethod: "none" })],
  ])("throws MalformedClaudeDiagnosticError for %s", (_label, stdout) => {
    expect(() => parseClaudeAuthDiagnostic(stdout)).toThrow(MalformedClaudeDiagnosticError);
  });

  it("never echoes the raw stdout in the thrown error message", () => {
    const sentinelGarbage = "SENTINEL-UNPARSEABLE-GARBAGE-NOT-REAL";
    try {
      parseClaudeAuthDiagnostic(sentinelGarbage);
      throw new Error("expected parseClaudeAuthDiagnostic to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(sentinelGarbage);
    }
  });
});

describe("classifyCodexBillingRoute", () => {
  it("classifies the observed ChatGPT-subscription line as subscription", () => {
    expect(classifyCodexBillingRoute("Logged in using ChatGPT").route).toBe("subscription");
  });

  it("is case-insensitive", () => {
    expect(classifyCodexBillingRoute("LOGGED IN USING CHATGPT").route).toBe("subscription");
  });

  it("classifies a defensive API-key phrasing as api_key, not subscription", () => {
    expect(classifyCodexBillingRoute("Logged in using an API key").route).toBe("api_key");
  });

  it("classifies a defensive not-logged-in phrasing as none", () => {
    expect(classifyCodexBillingRoute("Not logged in.").route).toBe("none");
  });

  it("classifies unrecognised output as indeterminate, never as a pass (totality)", () => {
    expect(classifyCodexBillingRoute("").route).toBe("indeterminate");
    expect(classifyCodexBillingRoute("some future CLI message we have never seen").route).toBe(
      "indeterminate",
    );
  });

  it("validity is always presence_only", () => {
    expect(classifyCodexBillingRoute("Logged in using ChatGPT").validity).toBe("presence_only");
  });

  // The defect: matching Codex status by a loose "Logged in" substring would
  // classify an API-key login as a subscription, because "Logged in using an
  // API key" also contains the substring "Logged in".
  it("[regression] a loose 'Logged in' substring match would wrongly classify an API-key login as subscription", () => {
    const text = "Logged in using an API key";
    expect(text.includes("Logged in")).toBe(true); // the loose match this regression guards against
    expect(classifyCodexBillingRoute(text).route).not.toBe("subscription");
    expect(classifyCodexBillingRoute(text).route).toBe("api_key");
  });

  it("never echoes the raw stdout in the detail message", () => {
    const sentinelText = "SENTINEL-CODEX-OUTPUT-NOT-REAL";
    expect(classifyCodexBillingRoute(sentinelText).detail).not.toContain(sentinelText);
  });
});

describe("assertSubscriptionOnly", () => {
  function attestation(overrides: Partial<BillingRouteAttestation> = {}): BillingRouteAttestation {
    return {
      engine: "claude",
      route: "subscription",
      validity: "presence_only",
      exposedKeySources: [],
      detail: "test fixture",
      ...overrides,
    };
  }

  it("does not throw for an unambiguous subscription route with no exposed key source", () => {
    expect(() => assertSubscriptionOnly(attestation())).not.toThrow();
  });

  it.each(["api_key", "third_party", "none", "indeterminate"] as const)(
    "throws SubscriptionRouteViolationError for route=%s",
    (route) => {
      expect(() => assertSubscriptionOnly(attestation({ route }))).toThrow(
        SubscriptionRouteViolationError,
      );
    },
  );

  it("throws even for route=subscription if a key source is exposed", () => {
    expect(() =>
      assertSubscriptionOnly(attestation({ exposedKeySources: [SENTINEL_KEY_SOURCE] })),
    ).toThrow(SubscriptionRouteViolationError);
  });

  it("names the route and exposed key-source variable NAMES, never a value, in the error", () => {
    try {
      assertSubscriptionOnly(
        attestation({ route: "api_key", exposedKeySources: [SENTINEL_KEY_SOURCE] }),
      );
      throw new Error("expected assertSubscriptionOnly to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("api_key");
      expect(message).toContain(SENTINEL_KEY_SOURCE);
    }
  });
});
