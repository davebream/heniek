import { describe, expect, it } from "vitest";
import { resolveRepoRoot } from "../src/smoke/env.js";
import { readSubscriptionSmokeConfig } from "../src/smoke/subscription/gate.js";

const OUTSIDE_ROOT = "/opt/heniek-subscription-profiles";
const SECRET = "s3cr3t-value-that-must-not-leak";

function enabledSmokeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HENIEK_CONFORMANCE_SMOKE: "1",
    HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE: "none",
    ...extra,
  };
}

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

  it("enables with both gates set and no profile root given", () => {
    const config = readSubscriptionSmokeConfig(
      enabledSmokeEnv({ HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION: "1" }),
    );
    expect(config.enabled).toBe(true);
    if (config.enabled) expect(config.profileRoot).toBeNull();
  });

  it("enables with an absolute, outside-repo profile root", () => {
    const config = readSubscriptionSmokeConfig(
      enabledSmokeEnv({
        HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION: "1",
        HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION_PROFILE_ROOT: OUTSIDE_ROOT,
      }),
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
    expect(() => readSubscriptionSmokeConfig(env)).toThrow(/OUTSIDE the repository/);
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
