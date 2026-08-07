import { describe, expect, it } from "vitest";
import {
  classifyRawDiagnostic,
  probeBillingRoute,
  type RawDiagnosticResult,
} from "../src/smoke/subscription/probe.js";

/**
 * FIX-5 / FIX-11: `probe.ts` was the only module in `smoke/subscription/`
 * with zero committed test coverage before this fix — its failure
 * classification could only be exercised through the opt-in, real-CLI
 * `subscription.smoke.test.ts`, which never runs in CI. This file exercises
 * `classifyRawDiagnostic` (the pure classification function) and
 * `probeBillingRoute` (with an injected fake runner) hermetically, with no
 * real subprocess.
 */

function raw(overrides: Partial<RawDiagnosticResult> = {}): RawDiagnosticResult {
  return { exitCode: 0, spawnFailure: false, stdout: "", stderr: "", ...overrides };
}

describe("classifyRawDiagnostic — pure failure/route classification", () => {
  // FIX-11: a spawn-level failure ("the brokered command is not on PATH")
  // must classify as indeterminate, never as `none` — `none` means "a real,
  // successful diagnostic reported no active session", which is a
  // meaningfully different fact than "we could not even run the command".
  it("[regression] classifies a spawn failure as indeterminate, never as none", () => {
    const result = classifyRawDiagnostic(
      "codex",
      raw({ spawnFailure: true, exitCode: null, stdout: "" }),
    );
    expect(result.route).toBe("indeterminate");
    expect(result.route).not.toBe("none");
  });

  it("[regression] classifies unparseable claude stdout as indeterminate, never as none", () => {
    const result = classifyRawDiagnostic("claude", raw({ stdout: "not json at all {{{" }));
    expect(result.route).toBe("indeterminate");
    expect(result.route).not.toBe("none");
  });

  it("classifies codex output matching no recognised phrasing as indeterminate via the total classifier", () => {
    const result = classifyRawDiagnostic("codex", raw({ stdout: "some unseen future message" }));
    expect(result.route).toBe("indeterminate");
  });

  it("classifies a successful, well-formed claude diagnostic normally", () => {
    const result = classifyRawDiagnostic(
      "claude",
      raw({
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "oauth_token",
          apiProvider: "firstParty",
        }),
      }),
    );
    expect(result.route).toBe("subscription");
  });

  it("classifies a successful codex ChatGPT-subscription line normally", () => {
    const result = classifyRawDiagnostic("codex", raw({ stdout: "Logged in using ChatGPT" }));
    expect(result.route).toBe("subscription");
  });

  // FIX-11: captured stderr (which N3 shows can be a multi-kilobyte internal
  // stack trace) must never be echoed into any classification output.
  it("[regression] never includes captured stderr in the attestation detail, even on a spawn failure", () => {
    const sentinelStack =
      "SENTINEL-STACK-TRACE-NOT-REAL\n    at Object.<anonymous> (/x/y/z.js:1:1)\n    at Module._compile (node:internal/modules/cjs/loader:1234:14)";
    const result = classifyRawDiagnostic(
      "claude",
      raw({ spawnFailure: true, exitCode: null, stderr: sentinelStack }),
    );
    expect(result.detail).not.toContain(sentinelStack);
    expect(result.detail).not.toContain("SENTINEL-STACK-TRACE-NOT-REAL");
  });

  it("[regression] never includes captured stderr in the attestation detail on an unparseable-output path", () => {
    const sentinelStack = "SENTINEL-STDERR-NOISE-NOT-REAL";
    const result = classifyRawDiagnostic(
      "claude",
      raw({ stdout: "not valid json", stderr: sentinelStack }),
    );
    expect(result.detail).not.toContain(sentinelStack);
  });

  // N4 (ADR 0003, design doc §2): the brokered Codex diagnostic writes its
  // status line to STDERR, not stdout (N4a) — this is exactly the shape that
  // caused the opt-in canary's real failure (`route="indeterminate"` for a
  // live, logged-in ChatGPT subscription) before this fix. This test must
  // fail against the pre-fix, stdout-only `classifyCodexBillingRoute(raw.stdout)`
  // behaviour, since `raw.stdout` is empty here and only `raw.stderr` carries
  // the recognised phrasing.
  it("[regression] classifies codex from combined stdout+stderr — status line on stderr only (N4a)", () => {
    const result = classifyRawDiagnostic(
      "codex",
      raw({ stdout: "", stderr: "Logged in using ChatGPT\n" }),
    );
    expect(result.route).toBe("subscription");
  });

  it("classifies codex as indeterminate when a crash-style stderr matches no recognised phrasing", () => {
    const result = classifyRawDiagnostic(
      "codex",
      raw({
        stdout: "",
        stderr:
          "SENTINEL-CRASH-NOT-REAL\n    at Object.<anonymous> (/x/y/z.js:1:1)\n    at Module._compile (node:internal/modules/cjs/loader:1234:14)",
      }),
    );
    expect(result.route).toBe("indeterminate");
  });

  it("[regression] classifies codex as indeterminate when stdout and stderr carry conflicting recognised phrasings (ambiguity rule holds across the combined read)", () => {
    const result = classifyRawDiagnostic(
      "codex",
      raw({ stdout: "Logged in using ChatGPT", stderr: "Not logged in." }),
    );
    expect(result.route).toBe("indeterminate");
  });

  it("classifies a claude diagnostic from stdout only even with noisy stderr present", () => {
    const result = classifyRawDiagnostic(
      "claude",
      raw({
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "oauth_token",
          apiProvider: "firstParty",
        }),
        stderr: "some unrelated noise on stderr",
      }),
    );
    expect(result.route).toBe("subscription");
  });

  it("[regression] classifies unparseable claude stdout as indeterminate, never none, regardless of stderr content", () => {
    const result = classifyRawDiagnostic(
      "claude",
      raw({ stdout: "not json at all {{{", stderr: "Logged in using ChatGPT" }),
    );
    expect(result.route).toBe("indeterminate");
    expect(result.route).not.toBe("none");
  });
});

describe("probeBillingRoute — injectable runner (FIX-5)", () => {
  it("uses the injected runner instead of a real subprocess", async () => {
    let called = false;
    await probeBillingRoute(
      "claude",
      { HOME: "/scratch/home" },
      {
        run: async (command, args, env) => {
          called = true;
          expect(command).toBe("claude");
          expect(args).toEqual(["auth", "status", "--json"]);
          expect(env).toEqual({ HOME: "/scratch/home" });
          return raw({ stdout: "not valid json" });
        },
      },
    );
    expect(called).toBe(true);
  });

  it("routes codex through its own command and args", async () => {
    await probeBillingRoute(
      "codex",
      { PATH: "/usr/bin" },
      {
        run: async (command, args) => {
          expect(command).toBe("heniek-codex");
          expect(args).toEqual(["login", "status"]);
          return raw({ stdout: "Logged in using ChatGPT" });
        },
      },
    );
  });

  it("[regression] classifies unparseable output as indeterminate, not none, through the injected runner", async () => {
    const result = await probeBillingRoute(
      "claude",
      {},
      { run: async () => raw({ stdout: "not valid json" }) },
    );
    expect(result.attestation.route).toBe("indeterminate");
    expect(result.attestation.route).not.toBe("none");
  });

  it("propagates spawnFailure and a null exitCode from the injected runner (FIX-11)", async () => {
    const result = await probeBillingRoute(
      "codex",
      {},
      { run: async () => raw({ exitCode: null, spawnFailure: true }) },
    );
    expect(result.spawnFailure).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.attestation.route).toBe("indeterminate");
  });

  it("propagates a numeric exitCode from a command that ran but exited non-zero", async () => {
    const result = await probeBillingRoute(
      "codex",
      {},
      { run: async () => raw({ exitCode: 1, spawnFailure: false, stdout: "Not logged in." }) },
    );
    expect(result.spawnFailure).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.attestation.route).toBe("none");
  });
});
