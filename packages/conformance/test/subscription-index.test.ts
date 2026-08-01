import { describe, expect, it } from "vitest";
import * as subscriptionIndex from "../src/smoke/subscription/index.js";

/**
 * Review finding 11: `smoke/subscription/index.ts` is a narrow, curated
 * re-export surface (matching `smoke/claudexor/index.ts`'s style — see the
 * design doc's module doc comment) that is not itself imported by any other
 * test, since every test file in this suite imports the individual modules
 * directly. Without a test importing the barrel file itself, a name silently
 * dropped from `index.ts` (or a typo in one of its re-export lists) would
 * never be caught — the declared public surface would be dead code. This
 * file exercises the barrel import directly and pins the runtime-visible
 * names (types are erased at runtime and are checked by `tsc` instead).
 */
describe("smoke/subscription/index.ts — export surface", () => {
  it("re-exports every runtime value declared across the module tree", () => {
    const expectedRuntimeExports = [
      // attestation.ts
      "assertSubscriptionOnly",
      "BILLING_ROUTES",
      "classifyClaudeBillingRoute",
      "classifyCodexBillingRoute",
      "MalformedClaudeDiagnosticError",
      "parseClaudeAuthDiagnostic",
      "SubscriptionRouteViolationError",
      // canaries.ts
      "classifyCredentialLifecycle",
      "classifyHostileAmbient",
      "toMarkdownTable",
      // environment-diff.ts
      "escapeMarkdownTableCell",
      "renderEnvironmentDiff",
      // gate.ts
      "readSubscriptionSmokeConfig",
      // probe.ts
      "classifyRawDiagnostic",
      "probeBillingRoute",
      "probeClaudeBillingRoute",
      "probeCodexBillingRoute",
      // variables.ts
      "buildIsolatedEnvironment",
      "ISOLATED_PATH",
      "IsolationViolationError",
      "VARIABLE_POLICY",
    ];

    for (const name of expectedRuntimeExports) {
      expect(
        Object.hasOwn(subscriptionIndex, name),
        `expected smoke/subscription/index.ts to re-export "${name}"`,
      ).toBe(true);
      expect(
        (subscriptionIndex as Record<string, unknown>)[name],
        `smoke/subscription/index.ts's "${name}" export is undefined`,
      ).toBeDefined();
    }
  });

  it("the re-exported buildIsolatedEnvironment and VARIABLE_POLICY are actually usable through the barrel", () => {
    const carrier = subscriptionIndex.VARIABLE_POLICY.claude.subscriptionCarriers[0] as string;
    const result = subscriptionIndex.buildIsolatedEnvironment({
      engine: "claude",
      ambient: { [carrier]: "SENTINEL-VALUE-NOT-REAL" },
      configHome: "/scratch/claude-home",
    });
    expect(result.env["PATH"]).toBe(subscriptionIndex.ISOLATED_PATH);
  });
});
