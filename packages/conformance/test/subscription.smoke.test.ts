import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSubscriptionOnly } from "../src/smoke/subscription/attestation.js";
import { readSubscriptionSmokeConfig } from "../src/smoke/subscription/gate.js";
import {
  probeClaudeBillingRoute,
  probeCodexBillingRoute,
} from "../src/smoke/subscription/probe.js";
import { buildIsolatedEnvironment } from "../src/smoke/subscription/variables.js";

/**
 * Opt-in subscription-isolation canaries. Disabled in CI by construction: the
 * gate requires both HENIEK_CONFORMANCE_SMOKE=1 (with its mandatory
 * AUTH_ROUTE) and HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION=1.
 *
 * The skip title names the required variables so the pending state is
 * visible in CI output rather than silently absent, matching
 * `claudexor.smoke.test.ts`. Everything these tests exercise is already
 * covered hermetically and exhaustively by `subscription-variables.test.ts`,
 * `subscription-attestation.test.ts`, and `subscription-canaries.test.ts` —
 * this file's only job is to prove the pieces still compose against a real,
 * locally-installed `claude` / `heniek-codex`, not to add new classifier
 * coverage.
 */
const config = readSubscriptionSmokeConfig();

describe.skipIf(!config.enabled)(
  "subscription isolation canaries [requires HENIEK_CONFORMANCE_SMOKE=1 + HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION=1]",
  () => {
    it("attests a subscription-only route for the isolated Claude profile", async () => {
      if (!config.enabled) return;
      const home = mkdtempSync(join(config.profileRoot ?? tmpdir(), "heniek-claude-profile-"));
      try {
        const isolated = buildIsolatedEnvironment({
          engine: "claude",
          ambient: process.env,
          configHome: home,
        });
        const { attestation } = await probeClaudeBillingRoute(isolated);
        expect(() => assertSubscriptionOnly(attestation)).not.toThrow();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("attests a subscription-only route for the isolated Codex profile", async () => {
      if (!config.enabled) return;
      const home = mkdtempSync(join(config.profileRoot ?? tmpdir(), "heniek-codex-profile-"));
      try {
        const isolated = buildIsolatedEnvironment({
          engine: "codex",
          ambient: process.env,
          configHome: home,
        });
        const { attestation } = await probeCodexBillingRoute(isolated);
        expect(() => assertSubscriptionOnly(attestation)).not.toThrow();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  },
);
