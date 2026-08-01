import { describe, expect, it } from "vitest";
import {
  buildIsolatedEnvironment,
  type IsolationRequest,
  IsolationViolationError,
  VARIABLE_POLICY,
} from "../src/smoke/subscription/variables.js";

// Fixtures deliberately avoid the "sk-"/"ghp_"/etc. credential-prefix shapes
// the committed-ADR redaction guard (claudexor-trace.test.ts) forbids, so
// nothing here could ever be mistaken for a real credential prefix.
const CLAUDE_CARRIER = VARIABLE_POLICY.claude.subscriptionCarriers[0] as string;
const CODEX_CARRIER = VARIABLE_POLICY.codex.subscriptionCarriers[0] as string;

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
    ambient: { [CODEX_CARRIER]: SENTINEL_CARRIER_VALUE, PATH: "/usr/bin:/bin" },
    configHome: "/scratch/codex-home",
    ...overrides,
  };
}

describe("buildIsolatedEnvironment — allowlist construction", () => {
  it("admits the carrier, the dedicated config home, and declared neutral variables", () => {
    const result = buildIsolatedEnvironment(claudeRequest());
    expect(result.env[CLAUDE_CARRIER]).toBe(SENTINEL_CARRIER_VALUE);
    expect(result.env["CLAUDE_CONFIG_DIR"]).toBe("/scratch/claude-home");
    expect(result.env["PATH"]).toBe("/usr/bin:/bin");
  });

  it("records the carrier as admitted-carrier and the config home as admitted-config-home", () => {
    const result = buildIsolatedEnvironment(claudeRequest());
    expect(result.decisions.find((d) => d.name === CLAUDE_CARRIER)?.outcome).toBe(
      "admitted-carrier",
    );
    expect(result.decisions.find((d) => d.name === "CLAUDE_CONFIG_DIR")?.outcome).toBe(
      "admitted-config-home",
    );
  });

  it("does not start from a copy of ambient — an unrelated neutral-looking variable is not admitted", () => {
    const result = buildIsolatedEnvironment(
      claudeRequest({ ambient: { [CLAUDE_CARRIER]: SENTINEL_CARRIER_VALUE, SHLVL: "3" } }),
    );
    expect(result.env["SHLVL"]).toBeUndefined();
  });

  it.each(VARIABLE_POLICY.claude.hostileCatalogue)(
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

  it.each(VARIABLE_POLICY.codex.hostileCatalogue)(
    "excludes the Codex hostile-catalogue variable %s from the built environment",
    (name) => {
      const result = buildIsolatedEnvironment(
        codexRequest({
          ambient: { [CODEX_CARRIER]: SENTINEL_CARRIER_VALUE, [name]: SENTINEL_HOSTILE_VALUE },
        }),
      );
      expect(result.env[name]).toBeUndefined();
      expect(result.decisions.find((d) => d.name === name)?.outcome).toBe("denied-hostile");
    },
  );

  // F2 (design §2): the ambient value must never win, even for a variable
  // this recipe knows about and handles — it must be replaced, not merely denied.
  it("overrides a hostile ambient CODEX_HOME value with the dedicated config home", () => {
    const result = buildIsolatedEnvironment(
      codexRequest({
        ambient: {
          [CODEX_CARRIER]: SENTINEL_CARRIER_VALUE,
          CODEX_HOME: "/poisoned/codex-home",
        },
        configHome: "/scratch/codex-home",
      }),
    );
    expect(result.env["CODEX_HOME"]).toBe("/scratch/codex-home");
    expect(result.decisions.find((d) => d.name === "CODEX_HOME")?.outcome).toBe(
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
    expect(result.env["SOME_OTHER_SERVICE_API_KEY"]).toBeUndefined();
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
});

describe("buildIsolatedEnvironment — fail-closed construction", () => {
  it("rejects a relative configHome", () => {
    expect(() => buildIsolatedEnvironment(claudeRequest({ configHome: "relative/path" }))).toThrow(
      IsolationViolationError,
    );
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
