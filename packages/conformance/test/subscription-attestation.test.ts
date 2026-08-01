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

  // FIX-10 relabel: this asserts a hardcoded constant — `validity` is
  // `"presence_only"` on EVERY input this issue's code can produce, so no
  // input variation could ever make this test catch a regression the way a
  // genuine regression test does. It documents an invariant (a
  // characterization), not a defect an alternate implementation might
  // reintroduce depending on what it does with the diagnostic.
  it("[characterization] validity is always presence_only, never provider_verified", () => {
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
  // FIX-10 relabel: `validity` is `"presence_only"` on every input this code
  // can produce (see the characterization test above) — no input to this
  // function can ever make `validity` vary, so this is a characterization of
  // that constant restated for the G1 shape specifically, not an independent
  // regression case.
  it("[characterization] a G1-shaped (fabricated carrier) diagnostic never attests provider_verified", () => {
    const result = classifyClaudeBillingRoute({
      loggedIn: true,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
    });
    expect(result.route).toBe("subscription");
    expect(result.validity).toBe("presence_only");
  });
});

describe("bounded() redaction of engine-controlled diagnostic strings (FIX-3)", () => {
  // `bounded()` is not exported; it is exercised indirectly through
  // `classifyClaudeBillingRoute`'s `detail` message, which is the only place
  // it is ever used.
  it("reduces an sk-prefixed authMethod to the fixed placeholder, never echoing it", () => {
    const sentinel = "sk-SENTINEL0123456789abcdefghijklmnopqrstuvwxyz";
    const result = classifyClaudeBillingRoute({
      loggedIn: true,
      authMethod: sentinel,
      apiProvider: "firstParty",
    });
    expect(result.detail).toContain("<unexpected-value>");
    expect(result.detail).not.toContain(sentinel);
  });

  it("reduces an absolute-path-shaped apiProvider to the fixed placeholder, never echoing it", () => {
    const sentinelPath = "/home/SENTINEL-USER-NOT-REAL/evil";
    const result = classifyClaudeBillingRoute({
      loggedIn: true,
      authMethod: "third_party",
      apiProvider: sentinelPath,
    });
    expect(result.detail).toContain("<unexpected-value>");
    expect(result.detail).not.toContain(sentinelPath);
  });

  it("reduces a Bearer-prefixed authMethod to the fixed placeholder, never echoing it", () => {
    const sentinelBearer = "Bearer SENTINEL-TOKEN-NOT-REAL";
    const result = classifyClaudeBillingRoute({
      loggedIn: true,
      authMethod: sentinelBearer,
      apiProvider: "firstParty",
    });
    expect(result.detail).toContain("<unexpected-value>");
    expect(result.detail).not.toContain(sentinelBearer);
  });

  it("still interpolates a genuine environment-variable-name-shaped apiKeySource verbatim", () => {
    const result = classifyClaudeBillingRoute({
      loggedIn: true,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
      apiKeySource: SENTINEL_KEY_SOURCE,
    });
    expect(result.detail).toContain(SENTINEL_KEY_SOURCE);
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

  // Review finding 6 (revises FIX-4's throw-based approach): a credential-
  // shaped apiKeySource is a finding about the diagnostic's content, not a
  // parse failure — parseClaudeAuthDiagnostic must sanitise it to the fixed
  // literal rather than throw, so classification can still proceed and fail
  // closed (assertSubscriptionOnly) instead of aborting entirely.
  it("[regression] sanitises a non-env-var-name-shaped apiKeySource to the fixed placeholder instead of throwing", () => {
    const diagnostic = parseClaudeAuthDiagnostic(
      JSON.stringify({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        apiKeySource: "sk-SENTINEL0123456789abcdefghijklmnopqrstuvwxyz",
      }),
    );
    expect(diagnostic.apiKeySource).toBe("<unexpected-value>");
  });

  it("[regression] a credential-shaped apiKeySource never reaches the parsed diagnostic", () => {
    const sentinel = "sk-SENTINEL0123456789abcdefghijklmnopqrstuvwxyz";
    const diagnostic = parseClaudeAuthDiagnostic(
      JSON.stringify({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        apiKeySource: sentinel,
      }),
    );
    expect(diagnostic.apiKeySource).not.toContain(sentinel);
  });

  // Full round-trip (review finding 6): a credential-shaped apiKeySource
  // still ends up sanitised inside a thrown SubscriptionRouteViolationError's
  // message — never the raw sk- string — because the sanitisation happens at
  // parse time, before classification or assertion ever see the value.
  it("[regression] a sanitised apiKeySource never reaches a thrown SubscriptionRouteViolationError's message", () => {
    const sentinel = "sk-SENTINEL0123456789abcdefghijklmnopqrstuvwxyz";
    const diagnostic = parseClaudeAuthDiagnostic(
      JSON.stringify({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        apiKeySource: sentinel,
      }),
    );
    const attestation = classifyClaudeBillingRoute(diagnostic);
    try {
      assertSubscriptionOnly(attestation);
      throw new Error("expected assertSubscriptionOnly to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionRouteViolationError);
      expect((error as Error).message).not.toContain(sentinel);
      expect((error as Error).message).toContain("<unexpected-value>");
    }
  });

  it("throws MalformedClaudeDiagnosticError when apiKeySource is present but not a string at all", () => {
    expect(() =>
      parseClaudeAuthDiagnostic(
        JSON.stringify({
          loggedIn: true,
          authMethod: "oauth_token",
          apiProvider: "firstParty",
          apiKeySource: 12345,
        }),
      ),
    ).toThrow(MalformedClaudeDiagnosticError);
  });

  it("accepts a genuine environment-variable-name-shaped apiKeySource", () => {
    const diagnostic = parseClaudeAuthDiagnostic(
      JSON.stringify({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        apiKeySource: SENTINEL_KEY_SOURCE,
      }),
    );
    expect(diagnostic.apiKeySource).toBe(SENTINEL_KEY_SOURCE);
  });
});

describe("classifyCodexBillingRoute", () => {
  it("classifies the observed ChatGPT-subscription line as subscription", () => {
    expect(classifyCodexBillingRoute("Logged in using ChatGPT").route).toBe("subscription");
  });

  // Review finding 11: a realistic near-miss phrase that mentions both
  // "not logged in" and "ChatGPT" in the same line, but does NOT contain the
  // exact "logged in using chatgpt" phrasing the subscription pattern
  // requires — it must still classify unambiguously as `none`, not
  // `indeterminate`. This documents that CODEX_SUBSCRIPTION_PATTERN's
  // specificity (requiring "using", not just "with") is what keeps a
  // plausible not-logged-in message from tripping the ambiguity check.
  it("classifies a not-logged-in phrasing that also mentions ChatGPT as none, not ambiguous", () => {
    const text = "Not logged in with ChatGPT";
    expect(/not logged in/i.test(text)).toBe(true);
    expect(/logged in using chatgpt/i.test(text)).toBe(false);
    const result = classifyCodexBillingRoute(text);
    expect(result.route).toBe("none");
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

  // FIX-15: ordering must not decide an ambiguous match. The prior
  // implementation took the first matching branch (API-key, then
  // subscription, then not-logged-in) in a fixed order, which is only
  // correct if the three patterns are disjoint — an assumption this issue
  // never verified, since only the subscription phrasing was ever actually
  // observed (F1/F2). If two patterns both matched, first-match-wins would
  // silently pick a route rather than report the ambiguity.
  it("[regression] classifies text matching more than one recognised phrasing as indeterminate, not a first-match pass", () => {
    const ambiguous = "Logged in using ChatGPT. Also: Logged in using an API key.";
    // Sanity: both patterns this classifier recognises actually match the
    // fixture, so this test would fail loudly (rather than vacuously pass)
    // if either pattern were later changed to no longer match it.
    expect(/logged in using chatgpt/i.test(ambiguous)).toBe(true);
    expect(/logged in using an? api key/i.test(ambiguous)).toBe(true);
    const result = classifyCodexBillingRoute(ambiguous);
    expect(result.route).toBe("indeterminate");
    expect(result.route).not.toBe("subscription");
    expect(result.route).not.toBe("api_key");
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
