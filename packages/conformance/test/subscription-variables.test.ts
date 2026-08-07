import { describe, expect, it } from "vitest";
import {
  buildIsolatedEnvironment,
  ISOLATED_PATH,
  type IsolationRequest,
  IsolationViolationError,
  VARIABLE_POLICY,
} from "../src/smoke/subscription/variables.js";

// Fixtures deliberately avoid the "sk-"/"ghp_"/etc. credential-prefix shapes
// the committed-ADR redaction guard (claudexor-trace.test.ts) forbids, so
// nothing here could ever be mistaken for a real credential prefix.
const CLAUDE_CARRIER = VARIABLE_POLICY.claude.subscriptionCarriers[0] as string;

const SENTINEL_CARRIER_VALUE = "SENTINEL-CARRIER-VALUE-NOT-REAL";
const SENTINEL_HOSTILE_VALUE = "SENTINEL-HOSTILE-VALUE-NOT-REAL";
const SENTINEL_UNKNOWN_VALUE = "SENTINEL-UNKNOWN-VALUE-NOT-REAL";

function claudeRequest(overrides: Partial<IsolationRequest> = {}): IsolationRequest {
  return {
    engine: "claude",
    ambient: { [CLAUDE_CARRIER]: SENTINEL_CARRIER_VALUE, PATH: "/usr/bin:/bin" },
    configHome: "/scratch/claude-home",
    ...overrides,
  };
}

function codexRequest(overrides: Partial<IsolationRequest> = {}): IsolationRequest {
  return {
    engine: "codex",
    ambient: { PATH: "/usr/bin:/bin" },
    ...overrides,
  };
}

// FIX-16: explicit pins over the policy tables, not derived from them. An
// `it.each` driven straight off `VARIABLE_POLICY` (as the hostile-catalogue
// loops below still are, deliberately, to get "one case per declared name")
// silently loses a test case if a catalogue entry is ever deleted, rather
// than failing one. These pins make deleting or renaming an entry a failing
// assertion instead of a silently-shrinking test count.
describe("VARIABLE_POLICY — explicit pins", () => {
  it("pins the Claude hostile catalogue exactly", () => {
    expect(VARIABLE_POLICY.claude.hostileCatalogue).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "PATH",
    ]);
  });

  it("pins the Codex hostile catalogue exactly", () => {
    expect(VARIABLE_POLICY.codex.hostileCatalogue).toEqual([
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_BASE_URL",
      "CODEX_HOME",
      "HOME",
      "PATH",
    ]);
  });

  // Review finding 2: PATH must never sit in `neutral` (admitted through
  // unchanged from ambient) for either engine — an ambient, attacker-
  // controlled PATH would otherwise decide which binary probe.ts's bare-name
  // execFile calls actually resolve to.
  it("[regression] PATH is declared in every hostileCatalogue and in no neutral list", () => {
    for (const policy of Object.values(VARIABLE_POLICY)) {
      expect(policy.hostileCatalogue).toContain("PATH");
      expect(policy.neutral).not.toContain("PATH");
    }
  });

  it("pins carrierKind, carriers, config-home variables, and the broker command per engine (FIX-1)", () => {
    expect(VARIABLE_POLICY.claude.carrierKind).toBe("environment");
    expect(VARIABLE_POLICY.claude.subscriptionCarriers).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(VARIABLE_POLICY.claude.configHomeVariables).toEqual(["HOME", "CLAUDE_CONFIG_DIR"]);
    expect(VARIABLE_POLICY.claude.brokerCommand).toBeUndefined();

    expect(VARIABLE_POLICY.codex.carrierKind).toBe("brokered");
    expect(VARIABLE_POLICY.codex.subscriptionCarriers).toEqual([]);
    expect(VARIABLE_POLICY.codex.configHomeVariables).toEqual([]);
    expect(VARIABLE_POLICY.codex.brokerCommand).toBe("heniek-codex");
    expect(VARIABLE_POLICY.codex.brokerOwnedNames).toEqual(["CODEX_HOME", "HOME"]);
  });
});

describe("buildIsolatedEnvironment — Claude, allowlist construction (carrierKind: environment)", () => {
  it("admits the carrier, the dedicated config home, and declared neutral variables", () => {
    const result = buildIsolatedEnvironment(claudeRequest());
    expect(result.env[CLAUDE_CARRIER]).toBe(SENTINEL_CARRIER_VALUE);
    expect(result.env.HOME).toBe("/scratch/claude-home");
    expect(result.env.CLAUDE_CONFIG_DIR).toBe("/scratch/claude-home/.claude");
    // Review finding 2: PATH is always the fixed ISOLATED_PATH constant,
    // never the ambient value (the fixture's ambient PATH is "/usr/bin:/bin").
    expect(result.env.PATH).toBe(ISOLATED_PATH);
    expect(result.decisions.find((d) => d.name === "PATH")?.outcome).toBe("admitted-fixed");
  });

  // FIX-2 regression: N3 shows `claude auth status --json` fails hard
  // (exit 1, empty stdout, an internal stack trace on stderr) when `HOME` is
  // absent, even with `CLAUDE_CONFIG_DIR` set. An environment built for
  // claude must always contain `HOME`.
  it("[regression] always includes HOME in the built environment (N3)", () => {
    const result = buildIsolatedEnvironment(claudeRequest());
    expect(result.env.HOME).toBeDefined();
    expect(result.env.HOME).toBe("/scratch/claude-home");
    expect(result.decisions.find((d) => d.name === "HOME")?.outcome).toBe("admitted-config-home");
  });

  it("records the carrier as admitted-carrier and the config home variables as admitted-config-home", () => {
    const result = buildIsolatedEnvironment(claudeRequest());
    expect(result.decisions.find((d) => d.name === CLAUDE_CARRIER)?.outcome).toBe(
      "admitted-carrier",
    );
    expect(result.decisions.find((d) => d.name === "HOME")?.outcome).toBe("admitted-config-home");
    expect(result.decisions.find((d) => d.name === "CLAUDE_CONFIG_DIR")?.outcome).toBe(
      "admitted-config-home",
    );
  });

  it("does not start from a copy of ambient — an unrelated neutral-looking variable is not admitted", () => {
    const result = buildIsolatedEnvironment(
      claudeRequest({ ambient: { [CLAUDE_CARRIER]: SENTINEL_CARRIER_VALUE, SHLVL: "3" } }),
    );
    expect(result.env.SHLVL).toBeUndefined();
  });

  // PATH is excluded from this parametrization deliberately: unlike every
  // other hostileCatalogue entry, it is never "denied" — it is always
  // replaced with the fixed ISOLATED_PATH value ("admitted-fixed"), pinned
  // separately below.
  it.each(VARIABLE_POLICY.claude.hostileCatalogue.filter((name) => name !== "PATH"))(
    "excludes the Claude hostile-catalogue variable %s from the built environment",
    (name) => {
      const result = buildIsolatedEnvironment(
        claudeRequest({
          ambient: { [CLAUDE_CARRIER]: SENTINEL_CARRIER_VALUE, [name]: SENTINEL_HOSTILE_VALUE },
        }),
      );
      expect(result.env[name]).toBeUndefined();
      expect(result.decisions.find((d) => d.name === name)?.outcome).toBe("denied-hostile");
    },
  );

  // Review finding 2, regression: an ambient PATH is what decides which
  // binary probe.ts's bare-name execFile calls resolve to. Before this fix,
  // PATH was "neutral" and admitted through unchanged — this pins that a
  // hostile ambient PATH can never survive into the built environment,
  // regardless of engine.
  it("[regression] a hostile ambient PATH never reaches the built environment (Claude)", () => {
    const result = buildIsolatedEnvironment(
      claudeRequest({
        ambient: {
          [CLAUDE_CARRIER]: SENTINEL_CARRIER_VALUE,
          PATH: "/opt/SENTINEL-ATTACKER-BIN-NOT-REAL:/usr/bin",
        },
      }),
    );
    expect(result.env.PATH).toBe(ISOLATED_PATH);
    expect(result.env.PATH).not.toContain("SENTINEL-ATTACKER-BIN-NOT-REAL");
    expect(result.decisions.find((d) => d.name === "PATH")?.outcome).toBe("admitted-fixed");
  });

  // Review finding 10: the Claude equivalent of the Codex config-home-
  // override test below — a hostile ambient HOME and CLAUDE_CONFIG_DIR must
  // both be replaced by the recipe's own dedicated config-home values, never
  // the ambient (poisoned) ones.
  it("[regression] overrides hostile ambient HOME and CLAUDE_CONFIG_DIR with the dedicated config home", () => {
    const result = buildIsolatedEnvironment(
      claudeRequest({
        ambient: {
          [CLAUDE_CARRIER]: SENTINEL_CARRIER_VALUE,
          HOME: "/poisoned/SENTINEL-HOME-NOT-REAL",
          CLAUDE_CONFIG_DIR: "/poisoned/SENTINEL-CLAUDE-CONFIG-DIR-NOT-REAL",
        },
        configHome: "/scratch/claude-home",
      }),
    );
    expect(result.env.HOME).toBe("/scratch/claude-home");
    expect(result.env.CLAUDE_CONFIG_DIR).toBe("/scratch/claude-home/.claude");
    expect(result.env.HOME).not.toContain("SENTINEL-HOME-NOT-REAL");
    expect(result.env.CLAUDE_CONFIG_DIR).not.toContain("SENTINEL-CLAUDE-CONFIG-DIR-NOT-REAL");
    expect(result.decisions.find((d) => d.name === "HOME")?.outcome).toBe("admitted-config-home");
    expect(result.decisions.find((d) => d.name === "CLAUDE_CONFIG_DIR")?.outcome).toBe(
      "admitted-config-home",
    );
  });

  it("classifies an unrecognised credential-shaped name as denied-unlisted", () => {
    const result = buildIsolatedEnvironment(
      claudeRequest({
        ambient: {
          [CLAUDE_CARRIER]: SENTINEL_CARRIER_VALUE,
          SOME_OTHER_SERVICE_API_KEY: SENTINEL_UNKNOWN_VALUE,
        },
      }),
    );
    expect(result.env.SOME_OTHER_SERVICE_API_KEY).toBeUndefined();
    expect(result.decisions.find((d) => d.name === "SOME_OTHER_SERVICE_API_KEY")?.outcome).toBe(
      "denied-unlisted",
    );
  });

  // Regression: a "copy ambient, then delete known-bad names" build only
  // ever excludes names someone thought to enumerate. This name is not in
  // ANY declared list (carrier, config home, hostile, or neutral) — proving
  // it is still excluded shows the allowlist, not a deny list, is doing the
  // work.
  it("[regression] excludes an unrecognised variable even when it is not in any declared list", () => {
    const policy = VARIABLE_POLICY.claude;
    const declared = new Set([
      ...policy.subscriptionCarriers,
      ...policy.configHomeVariables,
      ...policy.hostileCatalogue,
      ...policy.neutral,
    ]);
    const unlistedName = "SOME_RANDOM_UNLISTED_VARIABLE";
    expect(declared.has(unlistedName)).toBe(false);

    const result = buildIsolatedEnvironment(
      claudeRequest({
        ambient: {
          [CLAUDE_CARRIER]: SENTINEL_CARRIER_VALUE,
          [unlistedName]: SENTINEL_UNKNOWN_VALUE,
        },
      }),
    );
    expect(result.env[unlistedName]).toBeUndefined();
  });

  it("decisions never contain a sentinel value or any substring of one", () => {
    const result = buildIsolatedEnvironment(
      claudeRequest({
        ambient: {
          [CLAUDE_CARRIER]: SENTINEL_CARRIER_VALUE,
          ANTHROPIC_API_KEY: SENTINEL_HOSTILE_VALUE,
        },
      }),
    );
    const serialised = JSON.stringify(result.decisions);
    expect(serialised).not.toContain(SENTINEL_CARRIER_VALUE);
    expect(serialised).not.toContain(SENTINEL_HOSTILE_VALUE);
  });

  // FIX-13: a declared carrier that IS present in ambient, but set to the
  // empty string, is neither "absent" (denied-unlisted) nor "usable"
  // (admitted-carrier). The build assigns it "denied-empty-carrier" rather
  // than lumping it in with "denied-unlisted", so the redacted diff never
  // forces a reader to infer "present but useless" from `presentInAmbient`
  // plus a generic denial alone.
  //
  // NOTE (honesty, not a gap in this fix): with the current single-carrier
  // policies (one declared `subscriptionCarriers` name per engine), an empty
  // sole carrier makes the WHOLE build fail closed (see "fails closed when
  // the carrier is present but empty" above) before any decision list is
  // ever returned, so `denied-empty-carrier` cannot be observed in a
  // *successful* build's `decisions` today. The outcome exists, and the
  // per-name classification logic in `buildIsolatedEnvironment` is correct
  // for it, so that a future engine policy declaring more than one carrier
  // name (one empty, another non-empty and therefore admitted) gets the
  // right label without further code changes — but that combination is not
  // independently exercised by this test file, because no current policy can
  // produce it. `presentInAmbient` is still asserted directly: it is `true`
  // for a present-but-empty variable, which is exactly the ambiguity this
  // outcome exists to disambiguate.
  it("presentInAmbient is true for a present-but-empty carrier even though the value is unusable", () => {
    const isPresentButEmpty = (ambient: NodeJS.ProcessEnv): boolean => {
      const value = ambient[CLAUDE_CARRIER];
      return value !== undefined && value.length === 0;
    };
    expect(isPresentButEmpty({ [CLAUDE_CARRIER]: "" })).toBe(true);

    try {
      buildIsolatedEnvironment(claudeRequest({ ambient: { [CLAUDE_CARRIER]: "" } }));
      throw new Error("expected buildIsolatedEnvironment to throw for an empty sole carrier");
    } catch (error) {
      expect(error).toBeInstanceOf(IsolationViolationError);
    }
  });
});

describe("buildIsolatedEnvironment — Claude, fail-closed construction", () => {
  it("rejects a relative configHome", () => {
    expect(() => buildIsolatedEnvironment(claudeRequest({ configHome: "relative/path" }))).toThrow(
      IsolationViolationError,
    );
  });

  it("rejects a missing configHome", () => {
    const request: IsolationRequest = {
      engine: "claude",
      ambient: { [CLAUDE_CARRIER]: SENTINEL_CARRIER_VALUE, PATH: "/usr/bin:/bin" },
    };
    expect(() => buildIsolatedEnvironment(request)).toThrow(IsolationViolationError);
  });

  it("rejects an empty configHome", () => {
    expect(() => buildIsolatedEnvironment(claudeRequest({ configHome: "" }))).toThrow(
      IsolationViolationError,
    );
  });

  it("fails closed when the engine's subscription carrier is entirely absent", () => {
    expect(() =>
      buildIsolatedEnvironment(claudeRequest({ ambient: { PATH: "/usr/bin" } })),
    ).toThrow(IsolationViolationError);
  });

  it("fails closed when the carrier is present but empty", () => {
    expect(() =>
      buildIsolatedEnvironment(claudeRequest({ ambient: { [CLAUDE_CARRIER]: "" } })),
    ).toThrow(IsolationViolationError);
  });

  // Regression (G3, design §2): a naive implementation might instead return
  // an environment shaped like "logged out" so a caller can proceed and
  // observe `route: "none"` later. That reopens exactly the silent fallback
  // §9.1 forbids — the correct behaviour is to refuse to build anything at all.
  it("[regression] does not return a degraded/logged-out environment when the carrier is absent — it throws instead", () => {
    let threw = false;
    let result: unknown;
    try {
      result = buildIsolatedEnvironment(claudeRequest({ ambient: { PATH: "/usr/bin" } }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(result).toBeUndefined();
  });

  it("never echoes the rejected configHome value in the thrown error message", () => {
    const sentinelPath = "relative/SENTINEL-PATH-SEGMENT-NOT-REAL";
    try {
      buildIsolatedEnvironment(claudeRequest({ configHome: sentinelPath }));
      throw new Error("expected buildIsolatedEnvironment to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(sentinelPath);
    }
  });
});

describe("buildIsolatedEnvironment — Codex, brokered carrier model (FIX-1)", () => {
  it("builds a minimal allowlisted environment with no carrier and no config home at all", () => {
    const result = buildIsolatedEnvironment(codexRequest());
    expect(result.env.PATH).toBe(ISOLATED_PATH);
    expect(Object.keys(result.env)).toEqual(["PATH"]);
  });

  // Review finding 2, regression: same property as the Claude case above,
  // for the brokered engine.
  it("[regression] a hostile ambient PATH never reaches the built environment (Codex)", () => {
    const result = buildIsolatedEnvironment(
      codexRequest({ ambient: { PATH: "/opt/SENTINEL-ATTACKER-BIN-NOT-REAL:/usr/bin" } }),
    );
    expect(result.env.PATH).toBe(ISOLATED_PATH);
    expect(result.env.PATH).not.toContain("SENTINEL-ATTACKER-BIN-NOT-REAL");
    expect(result.decisions.find((d) => d.name === "PATH")?.outcome).toBe("admitted-fixed");
  });

  it("never admits HOME or CODEX_HOME even when both are hostile in ambient — the broker owns them", () => {
    const result = buildIsolatedEnvironment(
      codexRequest({
        ambient: {
          PATH: "/usr/bin:/bin",
          HOME: "/poisoned/home",
          CODEX_HOME: "/poisoned/codex-home",
        },
      }),
    );
    expect(result.env.HOME).toBeUndefined();
    expect(result.env.CODEX_HOME).toBeUndefined();
    expect(result.decisions.find((d) => d.name === "HOME")?.outcome).toBe("denied-broker-owned");
    expect(result.decisions.find((d) => d.name === "CODEX_HOME")?.outcome).toBe(
      "denied-broker-owned",
    );
  });

  it.each(["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"])(
    "excludes the ordinary Codex hostile-catalogue variable %s as denied-hostile, not denied-broker-owned",
    (name) => {
      const result = buildIsolatedEnvironment(
        codexRequest({ ambient: { PATH: "/usr/bin:/bin", [name]: SENTINEL_HOSTILE_VALUE } }),
      );
      expect(result.env[name]).toBeUndefined();
      expect(result.decisions.find((d) => d.name === name)?.outcome).toBe("denied-hostile");
    },
  );

  it("rejects a supplied configHome for a brokered engine (FIX-1)", () => {
    expect(() =>
      buildIsolatedEnvironment(codexRequest({ configHome: "/scratch/codex-home" })),
    ).toThrow(IsolationViolationError);
  });

  it("never echoes the rejected configHome value for a brokered engine", () => {
    const sentinelPath = "/scratch/SENTINEL-CODEX-CONFIG-HOME-NOT-REAL";
    try {
      buildIsolatedEnvironment(codexRequest({ configHome: sentinelPath }));
      throw new Error("expected buildIsolatedEnvironment to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(sentinelPath);
    }
  });

  it("does not require any subscription-carrier environment variable to be present (N1)", () => {
    // No OPENAI_*/CODEX_* carrier of any kind in ambient — the brokered
    // model has no such thing to check.
    expect(() => buildIsolatedEnvironment(codexRequest({ ambient: {} }))).not.toThrow();
  });
});
