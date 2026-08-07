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
 * `subscription-attestation.test.ts`, `subscription-canaries.test.ts` and
 * `subscription-probe.test.ts` — this file's only job is to prove the pieces
 * still compose against a real, locally-installed `claude` / `heniek-codex`,
 * not to add new classifier coverage.
 *
 * FIX-1 (post-hoc model correction): the two arms below are deliberately
 * asymmetric, because N1/N2 (design doc §2) showed the original symmetric
 * model was wrong for Codex. The Claude arm builds a `carrierKind:
 * "environment"` environment with a dedicated, temporary `configHome`, since
 * Claude's credential IS carried by an environment variable this recipe
 * checks and admits. The Codex arm builds a `carrierKind: "brokered"`
 * environment with NO `configHome` at all — supplying one would throw
 * `IsolationViolationError` — because the `heniek-codex` broker owns its own
 * credential storage and config home entirely outside this recipe's control.
 */
const config = readSubscriptionSmokeConfig();

describe.skipIf(!config.enabled)(
  "subscription isolation canaries [requires HENIEK_CONFORMANCE_SMOKE=1 + HENIEK_CONFORMANCE_SMOKE_SUBSCRIPTION=1]",
  () => {
    it("attests a subscription-only route for the isolated Claude profile (carrierKind: environment)", async () => {
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

    it("attests a subscription-only route for the brokered Codex profile (carrierKind: brokered, no configHome)", async () => {
      if (!config.enabled) return;
      // No configHome: the heniek-codex broker owns its own config home
      // entirely (N1, N2). Supplying one here would throw
      // IsolationViolationError — see the buildIsolatedEnvironment fail-closed
      // regression test in subscription-variables.test.ts.
      const isolated = buildIsolatedEnvironment({
        engine: "codex",
        ambient: process.env,
      });
      const { attestation } = await probeCodexBillingRoute(isolated);
      expect(() => assertSubscriptionOnly(attestation)).not.toThrow();
    });
  },
);
