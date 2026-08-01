import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRepoRoot } from "../src/smoke/env.js";
import {
  classifyClaudeBillingRoute,
  classifyCodexBillingRoute,
} from "../src/smoke/subscription/attestation.js";
import {
  classifyCredentialLifecycle,
  classifyHostileAmbient,
  toMarkdownTable,
} from "../src/smoke/subscription/canaries.js";
import { renderEnvironmentDiff } from "../src/smoke/subscription/environment-diff.js";
import { buildIsolatedEnvironment } from "../src/smoke/subscription/variables.js";

/**
 * FIX-18: the evidence file (`docs/adr/evidence/0003-subscription-isolation-matrix.md`)
 * claims its tables are machine-rendered from documented fixtures, not
 * hand-typed to merely look like renderer output. This test regenerates each
 * table from the exact fixtures documented alongside it in that file and
 * asserts the regenerated text appears verbatim in the committed file, so
 * that claim cannot silently become false as the renderers or classifiers
 * change.
 *
 * A negative control (below) proves this check can actually fail — without
 * it, a vacuously-passing drift guard would be worse than no guard at all.
 */

const EVIDENCE_PATH = join(
  resolveRepoRoot(),
  "docs/adr/evidence/0003-subscription-isolation-matrix.md",
);

function readEvidenceFile(): string {
  return readFileSync(EVIDENCE_PATH, "utf8");
}

const SENTINEL_CLAUDE_CARRIER = "SENTINEL-CLAUDE-CARRIER-NOT-REAL";
const SENTINEL_HOSTILE = "SENTINEL-HOSTILE-VALUE-NOT-REAL";

describe("evidence file drift guard", () => {
  it("the Claude scenario-D environment diff table matches the fixture documented in the evidence file", () => {
    const result = buildIsolatedEnvironment({
      engine: "claude",
      ambient: {
        CLAUDE_CODE_OAUTH_TOKEN: SENTINEL_CLAUDE_CARRIER,
        ANTHROPIC_API_KEY: SENTINEL_HOSTILE,
        ANTHROPIC_AUTH_TOKEN: SENTINEL_HOSTILE,
        ANTHROPIC_BASE_URL: SENTINEL_HOSTILE,
        CLAUDE_CODE_USE_BEDROCK: SENTINEL_HOSTILE,
        CLAUDE_CODE_USE_VERTEX: SENTINEL_HOSTILE,
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        SOME_OTHER_SERVICE_API_KEY: SENTINEL_HOSTILE,
        SHLVL: "3",
      },
      configHome: "/scratch/claude-home",
    });
    const rendered = renderEnvironmentDiff(result.decisions);
    expect(readEvidenceFile()).toContain(rendered);
  });

  it("the Codex brokered-model environment diff table matches the fixture documented in the evidence file", () => {
    const result = buildIsolatedEnvironment({
      engine: "codex",
      ambient: {
        OPENAI_API_KEY: SENTINEL_HOSTILE,
        CODEX_API_KEY: SENTINEL_HOSTILE,
        OPENAI_BASE_URL: SENTINEL_HOSTILE,
        CODEX_HOME: "/poisoned/codex-home",
        HOME: "/poisoned/home",
        PATH: "/usr/bin:/bin",
      },
    });
    const rendered = renderEnvironmentDiff(result.decisions);
    expect(readEvidenceFile()).toContain(rendered);
  });

  it("the canary table matches the fixtures documented in the evidence file", () => {
    const claudeResult = buildIsolatedEnvironment({
      engine: "claude",
      ambient: {
        CLAUDE_CODE_OAUTH_TOKEN: SENTINEL_CLAUDE_CARRIER,
        ANTHROPIC_API_KEY: SENTINEL_HOSTILE,
        ANTHROPIC_AUTH_TOKEN: SENTINEL_HOSTILE,
        ANTHROPIC_BASE_URL: SENTINEL_HOSTILE,
        CLAUDE_CODE_USE_BEDROCK: SENTINEL_HOSTILE,
        CLAUDE_CODE_USE_VERTEX: SENTINEL_HOSTILE,
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        SOME_OTHER_SERVICE_API_KEY: SENTINEL_HOSTILE,
        SHLVL: "3",
      },
      configHome: "/scratch/claude-home",
    });

    const hostileAmbient = classifyHostileAmbient({
      injectedHostileNames: [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
      ],
      decisions: claudeResult.decisions,
      attestation: classifyClaudeBillingRoute({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        apiKeySource: "ANTHROPIC_API_KEY",
      }),
      env: claudeResult.env,
    });

    const lifecycleG3 = classifyCredentialLifecycle({
      scenario: "carrier_absent",
      carrierPresent: false,
      attestation: classifyClaudeBillingRoute({
        loggedIn: true,
        authMethod: "api_key",
        apiProvider: "firstParty",
        apiKeySource: "ANTHROPIC_API_KEY",
      }),
    });

    const lifecycleB = classifyCredentialLifecycle({
      scenario: "carrier_absent",
      carrierPresent: false,
      attestation: classifyClaudeBillingRoute({
        loggedIn: false,
        authMethod: "none",
        apiProvider: "firstParty",
      }),
    });

    const lifecycleExpiry = classifyCredentialLifecycle({
      scenario: "expiry",
      carrierPresent: true,
      attestation: classifyClaudeBillingRoute({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
      }),
    });

    // Review finding 3: the logout-inversion fix. A `logged_out` scenario
    // whose diagnostic still shows `subscription` must be `unsupported` (the
    // logout did not take effect), not the `supported` a prior version
    // incorrectly reported. Documented alongside the ordinary `baseline` pass
    // so the evidence file shows the corrected behaviour in both directions.
    const lifecycleBaselineOk = classifyCredentialLifecycle({
      scenario: "baseline",
      carrierPresent: true,
      attestation: classifyClaudeBillingRoute({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
      }),
    });

    const lifecycleLoggedOutInversionFixed = classifyCredentialLifecycle({
      scenario: "logged_out",
      carrierPresent: true,
      attestation: classifyClaudeBillingRoute({
        loggedIn: true,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
      }),
    });

    const rendered = toMarkdownTable([
      hostileAmbient,
      lifecycleG3,
      lifecycleB,
      lifecycleExpiry,
      lifecycleBaselineOk,
      lifecycleLoggedOutInversionFixed,
    ]);
    expect(readEvidenceFile()).toContain(rendered);
  });

  it("the N1/N2 Codex classification JSON matches what classifyCodexBillingRoute actually produces", () => {
    const attestation = classifyCodexBillingRoute("Logged in using ChatGPT");
    expect(readEvidenceFile()).toContain(JSON.stringify(attestation));
  });

  // Negative control: proves this check is capable of failing, so a
  // vacuously-passing drift guard (e.g. one that accidentally always
  // succeeds) cannot masquerade as a real one.
  it("[negative control] a deliberately wrong rendering is NOT found in the evidence file", () => {
    const bogusTable = renderEnvironmentDiff([
      { name: "THIS_ROW_SHOULD_NEVER_EXIST", outcome: "denied-hostile", presentInAmbient: true },
    ]);
    expect(readEvidenceFile()).not.toContain(bogusTable);
  });
});
