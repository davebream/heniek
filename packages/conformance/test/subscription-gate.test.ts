import { describe, expect, it } from "vitest";
import { resolveRepoRoot } from "../src/smoke/env.js";
import { type GateProbes, readSubscriptionSmokeConfig } from "../src/smoke/subscription/gate.js";

const OUTSIDE_ROOT = "/opt/heniek-subscription-profiles";
const SECRET = "s3cr3t-value-that-must-not-leak";

function enabledSmokeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HENIEK_CONFORMANCE_SMOKE: "1",
    HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE: "subscription",
    ...extra,
  };
}

/** Identity realpath, for tests exercising fixture paths that do not exist on the real filesystem. */
const IDENTITY_PROBES: GateProbes = { realpathSync: (path) => path };

describe("readSubscriptionSmokeConfig", () => {
  it("is disabled by default, which is the CI posture", () => {
    expect(readSubscriptionSmokeConfig({}).enabled).toBe(false);
  });

  it("stays disabled when the general smoke gate is on but subscription is not opted in", () => {
    const config = readSubscriptionSmokeConfig(enabledSmokeEnv());
    expect(config.enabled).toBe(false);
  });

  it("stays disabled when HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION is set to something other than 1", () => {
    const config = readSubscriptionSmokeConfig(
      enabledSmokeEnv({ HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION: "true" }),
    );
    expect(config.enabled).toBe(false);
  });

  // Review finding 9: this suite provisions a subscription route, so an
  // AUTH_ROUTE of anything other than "subscription" is the wrong opt-in for
  // this suite, not a malformed one — it disables with a reason.
  it.each(["none", "api_key"] as const)(
    "stays disabled when HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE is %s, not subscription",
    (authRoute) => {
      const config = readSubscriptionSmokeConfig(
        enabledSmokeEnv({
          HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE: authRoute,
          HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION: "1",
        }),
      );
      expect(config.enabled).toBe(false);
      if (!config.enabled) expect(config.reason).toMatch(/subscription/);
    },
  );

  it("enables with both gates set and no profile root given", () => {
    const config = readSubscriptionSmokeConfig(
      enabledSmokeEnv({ HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION: "1" }),
    );
    expect(config.enabled).toBe(true);
    if (config.enabled) expect(config.profileRoot).toBeNull();
  });

  it("enables with an absolute, outside-repo, existing profile root", () => {
    const config = readSubscriptionSmokeConfig(
      enabledSmokeEnv({
        HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION: "1",
        HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT: OUTSIDE_ROOT,
      }),
      IDENTITY_PROBES,
    );
    expect(config.enabled).toBe(true);
    if (config.enabled) expect(config.profileRoot).toBe(OUTSIDE_ROOT);
  });

  it("rejects a relative profile root without echoing its value", () => {
    const env = enabledSmokeEnv({
      HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION: "1",
      HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT: `./${SECRET}`,
    });
    expect(() => readSubscriptionSmokeConfig(env)).toThrow(/absolute path/);
    try {
      readSubscriptionSmokeConfig(env);
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it("rejects a profile root INSIDE the repository", () => {
    const env = enabledSmokeEnv({
      HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION: "1",
      HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT: `${resolveRepoRoot()}/packages/conformance`,
    });
    // Real filesystem here: packages/conformance genuinely exists, so the
    // default realpath probe resolves it without throwing for the wrong reason.
    expect(() => readSubscriptionSmokeConfig(env)).toThrow(/OUTSIDE the repository/);
  });

  // Review finding 9: a symlink whose lexical path looks external but whose
  // target resolves inside the repository must still be rejected — a purely
  // lexical inside-repo check (on the unresolved path) would have missed
  // this, since the string itself never mentions the repository at all.
  it("[regression] rejects a profile root that is a symlink resolving INSIDE the repository", () => {
    const env = enabledSmokeEnv({
      HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION: "1",
      HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT: OUTSIDE_ROOT,
    });
    const probes: GateProbes = {
      realpathSync: () => `${resolveRepoRoot()}/packages/conformance`,
    };
    expect(() => readSubscriptionSmokeConfig(env, probes)).toThrow(/OUTSIDE the repository/);
  });

  // Review finding 9: this gate is a write path (mkdtempSync + recursive
  // rmSync under the profile root), so a nonexistent or unreadable path must
  // fail before any filesystem write is attempted.
  it("[regression] rejects a profile root that does not exist", () => {
    const env = enabledSmokeEnv({
      HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION: "1",
      HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT: OUTSIDE_ROOT,
    });
    const probes: GateProbes = {
      realpathSync: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    };
    expect(() => readSubscriptionSmokeConfig(env, probes)).toThrow(/must resolve to an existing/);
  });

  it("never echoes the profile-root value in the not-found error message", () => {
    const env = enabledSmokeEnv({
      HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION: "1",
      HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT: `/opt/${SECRET}`,
    });
    const probes: GateProbes = {
      realpathSync: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    };
    try {
      readSubscriptionSmokeConfig(env, probes);
      throw new Error("expected readSubscriptionSmokeConfig to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it("treats an empty-string profile root the same as unset", () => {
    const config = readSubscriptionSmokeConfig(
      enabledSmokeEnv({
        HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION: "1",
        HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT: "   ",
      }),
    );
    expect(config.enabled).toBe(true);
    if (config.enabled) expect(config.profileRoot).toBeNull();
  });
});
