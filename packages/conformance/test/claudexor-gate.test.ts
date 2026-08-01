import { describe, expect, it } from "vitest";
import {
  type GateProbes,
  readClaudexorSmokeConfig,
  resolveTraceOut,
} from "../src/smoke/claudexor/gate.js";
import { resolveRepoRoot } from "../src/smoke/env.js";

const alwaysExists: GateProbes = { exists: () => true };
const neverExists: GateProbes = { exists: () => false };

const OUTSIDE_ROOT = "/opt/pinned-claudexor";
const SECRET = "s3cr3t-value-that-must-not-leak";

function enabledEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HENIEK_CONFORMANCE_SMOKE: "1",
    // readSmokeConfig THROWS when smoke is on and this is missing or invalid,
    // so every enabled-path test must set it or it fails for the wrong reason.
    HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE: "none",
    ...extra,
  };
}

describe("readClaudexorSmokeConfig", () => {
  it("is disabled by default, which is the CI posture", () => {
    const config = readClaudexorSmokeConfig({}, alwaysExists);
    expect(config.enabled).toBe(false);
  });

  it("stays disabled when smoke is on but no Claudexor root is given", () => {
    const config = readClaudexorSmokeConfig(enabledEnv(), alwaysExists);
    expect(config.enabled).toBe(false);
  });

  it("enables only with both the smoke gate and an absolute outside root", () => {
    const config = readClaudexorSmokeConfig(
      enabledEnv({ HENIEK_CONFORMANCE_SMOKE_CLAUDEXOR_ROOT: OUTSIDE_ROOT }),
      alwaysExists,
    );
    expect(config.enabled).toBe(true);
    if (config.enabled) expect(config.claudexorRoot).toBe(OUTSIDE_ROOT);
  });

  it("rejects a relative root without echoing its value", () => {
    const env = enabledEnv({ HENIEK_CONFORMANCE_SMOKE_CLAUDEXOR_ROOT: `./${SECRET}` });
    expect(() => readClaudexorSmokeConfig(env, alwaysExists)).toThrow(/absolute path/);
    try {
      readClaudexorSmokeConfig(env, alwaysExists);
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  // The inverse of env.ts's `..._MODULE` rule. Reusing that helper here would
  // be a security inversion: the engine checkout carries its own runtime state
  // and a 0600 token, none of which may enter this repository.
  it("rejects a root INSIDE the repository", () => {
    const env = enabledEnv({
      HENIEK_CONFORMANCE_SMOKE_CLAUDEXOR_ROOT: `${resolveRepoRoot()}/packages/conformance`,
    });
    expect(() => readClaudexorSmokeConfig(env, alwaysExists)).toThrow(/OUTSIDE the repository/);
  });

  it("rejects a root that does not exist", () => {
    const env = enabledEnv({ HENIEK_CONFORMANCE_SMOKE_CLAUDEXOR_ROOT: OUTSIDE_ROOT });
    expect(() => readClaudexorSmokeConfig(env, neverExists)).toThrow(/does not exist/);
  });

  it("does not touch the filesystem when a probe is injected", () => {
    let calls = 0;
    const counting: GateProbes = {
      exists: () => {
        calls += 1;
        return true;
      },
    };
    readClaudexorSmokeConfig(
      enabledEnv({ HENIEK_CONFORMANCE_SMOKE_CLAUDEXOR_ROOT: OUTSIDE_ROOT }),
      counting,
    );
    expect(calls).toBe(1);
  });
});

describe("resolveTraceOut", () => {
  it("is null when unset", () => {
    expect(resolveTraceOut({})).toBeNull();
  });

  // Resolved against the repo root, not process.cwd(): the same relative path
  // otherwise lands in packages/conformance/docs/... when vitest is invoked
  // from the package rather than the repo root.
  it("resolves a relative path against the repository root, not the cwd", () => {
    const resolved = resolveTraceOut({
      HENIEK_CONFORMANCE_SMOKE_TRACE_OUT: "docs/adr/evidence/x.md",
    });
    expect(resolved).toBe(`${resolveRepoRoot()}/docs/adr/evidence/x.md`);
  });

  it("rejects a path outside the repository without echoing it", () => {
    const env = { HENIEK_CONFORMANCE_SMOKE_TRACE_OUT: `/etc/${SECRET}` };
    expect(() => resolveTraceOut(env)).toThrow(/inside the repository/);
    try {
      resolveTraceOut(env);
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it("rejects a traversal escape", () => {
    expect(() =>
      resolveTraceOut({ HENIEK_CONFORMANCE_SMOKE_TRACE_OUT: "../../escape.md" }),
    ).toThrow(/inside the repository/);
  });
});
