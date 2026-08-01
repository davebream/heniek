import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApplicationHomeResolutionError,
  type ApplicationHomeSource,
  resolveApplicationHome,
} from "../src/home/index.js";

const HOME_DIRECTORY = "/home/alice";
const FALLBACK_BASE = join(HOME_DIRECTORY, ".heniek");

/**
 * Asserts that `paths` reproduces spec §7's canonical tree exactly, rooted
 * at `base` (used both for the `.heniek` fallback and for a `HENIEK_HOME`
 * override, which the design states must reproduce the identical shape).
 */
function expectCanonicalTree(paths: Record<string, string>, base: string): void {
  expect(paths).toEqual({
    configDirectory: join(base, "config"),
    accountsDirectory: join(base, "config", "accounts"),
    workersDirectory: join(base, "config", "workers"),
    rolesDirectory: join(base, "config", "roles"),
    profilesDirectory: join(base, "config", "profiles"),
    pipelinesDirectory: join(base, "config", "pipelines"),
    defaultsFile: join(base, "config", "defaults.yaml"),
    codebasesDirectory: join(base, "codebases"),
    workspacesDirectory: join(base, "workspaces"),
    artifactsDirectory: join(base, "artifacts"),
    exportsDirectory: join(base, "exports"),
    backupsDirectory: join(base, "backups"),
    runtimesDirectory: join(base, "runtimes"),
    stateDatabaseFile: join(base, "state.sqlite"),
    secretsDirectory: join(base, "secrets"),
    logsDirectory: join(base, "logs"),
    runtimeDirectory: join(base, "runtime"),
    daemonSocketFile: join(base, "runtime", "daemon.sock"),
    daemonPidFile: join(base, "runtime", "daemon.pid"),
  });
}

/** Runs `fn`, returning the thrown error (typed as `ApplicationHomeResolutionError`) instead of letting it propagate. */
function captureError(fn: () => unknown): ApplicationHomeResolutionError {
  try {
    fn();
  } catch (error) {
    return error as ApplicationHomeResolutionError;
  }
  throw new Error("Expected fn() to throw, but it did not.");
}

function source(overrides: Partial<ApplicationHomeSource> = {}): ApplicationHomeSource {
  return {
    platform: "linux",
    env: {},
    homeDirectory: HOME_DIRECTORY,
    ...overrides,
  };
}

describe("resolveApplicationHome — AC1 platform/preference table", () => {
  it("darwin, no environment variables set: falls back to <home>/.heniek for every root", () => {
    const home = resolveApplicationHome(source({ platform: "darwin" }));

    expect(home.roots).toEqual({
      config: { path: join(FALLBACK_BASE, "config"), origin: "user-home-fallback" },
      data: { path: FALLBACK_BASE, origin: "user-home-fallback" },
      state: { path: FALLBACK_BASE, origin: "user-home-fallback" },
      runtime: { path: join(FALLBACK_BASE, "runtime"), origin: "user-home-fallback" },
    });
    expectCanonicalTree(home.paths, FALLBACK_BASE);
    expect(home.diagnostics).toEqual([]);
  });

  it("darwin, XDG variables set: ignored — XDG applies on Linux only", () => {
    const home = resolveApplicationHome(
      source({
        platform: "darwin",
        env: {
          XDG_CONFIG_HOME: "/xdg/config",
          XDG_DATA_HOME: "/xdg/data",
          XDG_STATE_HOME: "/xdg/state",
          XDG_RUNTIME_DIR: "/xdg/runtime",
        },
      }),
    );

    expect(home.roots).toEqual({
      config: { path: join(FALLBACK_BASE, "config"), origin: "user-home-fallback" },
      data: { path: FALLBACK_BASE, origin: "user-home-fallback" },
      state: { path: FALLBACK_BASE, origin: "user-home-fallback" },
      runtime: { path: join(FALLBACK_BASE, "runtime"), origin: "user-home-fallback" },
    });
    // No "ignored" diagnostic here: this is not an override situation (design
    // §2.2's xdg-ignored-under-override diagnostic is specific to HENIEK_HOME
    // overriding an otherwise-applicable XDG configuration), it is simply
    // that XDG never applies on this platform at all.
    expect(home.diagnostics).toEqual([]);
  });

  it("linux, no XDG variables set: falls back to <home>/.heniek for every root", () => {
    const home = resolveApplicationHome(source({ platform: "linux" }));

    expect(home.roots).toEqual({
      config: { path: join(FALLBACK_BASE, "config"), origin: "user-home-fallback" },
      data: { path: FALLBACK_BASE, origin: "user-home-fallback" },
      state: { path: FALLBACK_BASE, origin: "user-home-fallback" },
      runtime: { path: join(FALLBACK_BASE, "runtime"), origin: "user-home-fallback" },
    });
    expectCanonicalTree(home.paths, FALLBACK_BASE);
    expect(home.diagnostics).toEqual([]);
  });

  it("linux, some XDG variables set: configured categories use XDG, the rest fall back independently", () => {
    const home = resolveApplicationHome(
      source({
        platform: "linux",
        env: {
          XDG_CONFIG_HOME: "/xdg/config",
          XDG_RUNTIME_DIR: "/xdg/runtime",
        },
      }),
    );

    expect(home.roots).toEqual({
      config: { path: "/xdg/config/heniek", origin: "xdg-base-directory" },
      data: { path: FALLBACK_BASE, origin: "user-home-fallback" },
      state: { path: FALLBACK_BASE, origin: "user-home-fallback" },
      runtime: { path: "/xdg/runtime/heniek", origin: "xdg-base-directory" },
    });
    expect(home.diagnostics).toEqual([]);
  });

  it("linux, all four XDG variables set: every root is redistributed under <value>/heniek", () => {
    const home = resolveApplicationHome(
      source({
        platform: "linux",
        env: {
          XDG_CONFIG_HOME: "/xdg/config",
          XDG_DATA_HOME: "/xdg/data",
          XDG_STATE_HOME: "/xdg/state",
          XDG_RUNTIME_DIR: "/xdg/runtime",
        },
      }),
    );

    expect(home.roots).toEqual({
      config: { path: "/xdg/config/heniek", origin: "xdg-base-directory" },
      data: { path: "/xdg/data/heniek", origin: "xdg-base-directory" },
      state: { path: "/xdg/state/heniek", origin: "xdg-base-directory" },
      runtime: { path: "/xdg/runtime/heniek", origin: "xdg-base-directory" },
    });
    expect(home.diagnostics).toEqual([]);
  });

  it.each(["darwin", "linux"] as const)(
    "HENIEK_HOME absolute on %s: single-root layout reproducing the canonical tree",
    (platform) => {
      const home = resolveApplicationHome(
        source({ platform, env: { HENIEK_HOME: "/custom/home" } }),
      );

      expect(home.roots.config).toEqual({
        path: "/custom/home/config",
        origin: "heniek-home-variable",
      });
      expect(home.roots.data).toEqual({ path: "/custom/home", origin: "heniek-home-variable" });
      expect(home.roots.state).toEqual({ path: "/custom/home", origin: "heniek-home-variable" });
      expect(home.roots.runtime).toEqual({
        path: "/custom/home/runtime",
        origin: "heniek-home-variable",
      });
      expectCanonicalTree(home.paths, "/custom/home");
      expect(home.diagnostics).toEqual([]);
    },
  );

  it("HENIEK_HOME absolute with XDG variables also set: XDG is ignored and the conflict is surfaced", () => {
    const home = resolveApplicationHome(
      source({
        platform: "linux",
        env: {
          HENIEK_HOME: "/custom/home",
          XDG_CONFIG_HOME: "/xdg/config",
          XDG_DATA_HOME: "/xdg/data",
        },
      }),
    );

    expect(home.roots.config.origin).toBe("heniek-home-variable");
    expect(home.roots.data.origin).toBe("heniek-home-variable");
    expect(home.diagnostics).toEqual([
      {
        code: "home.xdg-ignored-under-override",
        severity: "info",
        message: expect.stringContaining("XDG_CONFIG_HOME"),
      },
    ]);
    expect(home.diagnostics[0]?.message).toContain("XDG_DATA_HOME");
  });

  it("HENIEK_HOME absolute with XDG variables set on darwin: no 'ignored' diagnostic — XDG was never a platform default there (B5)", () => {
    const home = resolveApplicationHome(
      source({
        platform: "darwin",
        env: {
          HENIEK_HOME: "/custom/home",
          XDG_CONFIG_HOME: "/xdg/config",
          XDG_DATA_HOME: "/xdg/data",
        },
      }),
    );

    expect(home.roots.config.origin).toBe("heniek-home-variable");
    expect(home.diagnostics).toEqual([]);
  });

  it("rejects a relative HENIEK_HOME", () => {
    const error = captureError(() =>
      resolveApplicationHome(source({ env: { HENIEK_HOME: "relative/path" } })),
    );
    expect(error).toBeInstanceOf(ApplicationHomeResolutionError);
    expect(error.code).toBe("home.override-not-absolute");
    // The offending value must never be echoed back.
    expect(error.message).not.toContain("relative/path");
  });

  it.each(["linux", "darwin"] as const)(
    "HENIEK_HOME set to an empty string on %s: falls through to the platform default, not an error (A1)",
    (platform) => {
      const home = resolveApplicationHome(source({ platform, env: { HENIEK_HOME: "" } }));

      expect(home.roots).toEqual({
        config: { path: join(FALLBACK_BASE, "config"), origin: "user-home-fallback" },
        data: { path: FALLBACK_BASE, origin: "user-home-fallback" },
        state: { path: FALLBACK_BASE, origin: "user-home-fallback" },
        runtime: { path: join(FALLBACK_BASE, "runtime"), origin: "user-home-fallback" },
      });
      expect(home.diagnostics).toEqual([]);
    },
  );

  it("HENIEK_HOME='' on linux with an XDG variable also set: the XDG variable is honoured (empty override truly fell through)", () => {
    const home = resolveApplicationHome(
      source({ platform: "linux", env: { HENIEK_HOME: "", XDG_CONFIG_HOME: "/xdg/config" } }),
    );

    expect(home.roots.config).toEqual({ path: "/xdg/config/heniek", origin: "xdg-base-directory" });
  });

  it("rejects a whitespace-only HENIEK_HOME", () => {
    const error = captureError(() =>
      resolveApplicationHome(source({ env: { HENIEK_HOME: "   " } })),
    );
    expect(error.code).toBe("home.override-not-absolute");
  });

  it("rejects a HENIEK_HOME containing a NUL byte", () => {
    const withNul = `/tmp/valid${String.fromCharCode(0)}path`;
    const error = captureError(() =>
      resolveApplicationHome(source({ env: { HENIEK_HOME: withNul } })),
    );
    expect(error).toBeInstanceOf(ApplicationHomeResolutionError);
    expect(error.code).toBe("home.override-invalid");
    expect(error.message).not.toContain(withNul);
  });

  it("a relative XDG_* value is ignored with a warning and that category falls back", () => {
    const home = resolveApplicationHome(
      source({ platform: "linux", env: { XDG_DATA_HOME: "relative/data" } }),
    );

    expect(home.roots.data).toEqual({ path: FALLBACK_BASE, origin: "user-home-fallback" });
    expect(home.diagnostics).toEqual([
      {
        code: "home.xdg-variable-not-absolute",
        severity: "warning",
        message: expect.stringContaining("XDG_DATA_HOME"),
      },
    ]);
  });

  it("an empty XDG_* value is silently treated as unset", () => {
    const home = resolveApplicationHome(source({ platform: "linux", env: { XDG_STATE_HOME: "" } }));

    expect(home.roots.state).toEqual({ path: FALLBACK_BASE, origin: "user-home-fallback" });
    expect(home.diagnostics).toEqual([]);
  });

  // D6: only the HENIEK_HOME NUL-byte case was covered before this — the
  // per-category XDG resolver has its own, separate `containsNulByte` check
  // (`resolveXdgCategory`) that shared no test coverage with the override
  // path at all.
  it("a NUL-bearing XDG_* value is rejected with a warning and that category falls back (D6)", () => {
    const withNul = `/xdg/data${String.fromCharCode(0)}`;
    const home = resolveApplicationHome(
      source({ platform: "linux", env: { XDG_DATA_HOME: withNul } }),
    );

    expect(home.roots.data).toEqual({ path: FALLBACK_BASE, origin: "user-home-fallback" });
    expect(home.diagnostics).toEqual([
      {
        code: "home.xdg-variable-not-absolute",
        severity: "warning",
        message: expect.stringContaining("XDG_DATA_HOME"),
      },
    ]);
    expect(home.diagnostics[0]?.message).not.toContain(withNul);
  });

  it("rejects a relative homeDirectory", () => {
    expect(() => resolveApplicationHome(source({ homeDirectory: "relative/home" }))).toThrow(
      ApplicationHomeResolutionError,
    );
    try {
      resolveApplicationHome(source({ homeDirectory: "relative/home" }));
      expect.unreachable();
    } catch (error) {
      expect((error as ApplicationHomeResolutionError).code).toBe("home.user-directory-invalid");
    }
  });

  it("rejects an empty homeDirectory", () => {
    try {
      resolveApplicationHome(source({ homeDirectory: "" }));
      expect.unreachable();
    } catch (error) {
      expect((error as ApplicationHomeResolutionError).code).toBe("home.user-directory-invalid");
    }
  });

  it("rejects a homeDirectory containing a NUL byte (A3)", () => {
    const withNul = `/home/alice${String.fromCharCode(0)}`;
    const error = captureError(() => resolveApplicationHome(source({ homeDirectory: withNul })));
    expect(error).toBeInstanceOf(ApplicationHomeResolutionError);
    expect(error.code).toBe("home.user-directory-invalid");
    expect(error.message).not.toContain(withNul);
  });

  it("HENIEK_HOME override succeeds even when homeDirectory is unusable — e.g. HOME unset in a container (A2)", () => {
    const home = resolveApplicationHome(
      source({ env: { HENIEK_HOME: "/srv/heniek" }, homeDirectory: "" }),
    );
    expect(home.roots.data).toEqual({ path: "/srv/heniek", origin: "heniek-home-variable" });
    expectCanonicalTree(home.paths, "/srv/heniek");
  });

  it("HENIEK_HOME override succeeds even with a relative homeDirectory (A2)", () => {
    const home = resolveApplicationHome(
      source({ env: { HENIEK_HOME: "/srv/heniek" }, homeDirectory: "relative/home" }),
    );
    expect(home.roots.data).toEqual({ path: "/srv/heniek", origin: "heniek-home-variable" });
  });

  it("a Linux host with every XDG category configured never touches an unusable homeDirectory (A2)", () => {
    const home = resolveApplicationHome(
      source({
        platform: "linux",
        env: {
          XDG_CONFIG_HOME: "/xdg/config",
          XDG_DATA_HOME: "/xdg/data",
          XDG_STATE_HOME: "/xdg/state",
          XDG_RUNTIME_DIR: "/xdg/runtime",
        },
        homeDirectory: "",
      }),
    );
    expect(home.roots.config).toEqual({ path: "/xdg/config/heniek", origin: "xdg-base-directory" });
  });

  it("the Linux fall-through branch still rejects an unusable homeDirectory once a category actually needs it (A2)", () => {
    const error = captureError(() =>
      resolveApplicationHome(
        source({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg/config" }, homeDirectory: "" }),
      ),
    );
    expect(error.code).toBe("home.user-directory-invalid");
  });

  it("normalises HENIEK_HOME: resolves '..' segments and strips a trailing slash", () => {
    const home = resolveApplicationHome(source({ env: { HENIEK_HOME: "/a/b/../c/" } }));

    expect(home.roots.data.path).toBe("/a/c");
    expect(home.roots.config.path).toBe("/a/c/config");
  });

  it("is deterministic: the same input resolves to deep-equal output on repeated calls", () => {
    const input = source({
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/xdg/config" },
    });

    const first = resolveApplicationHome(input);
    const second = resolveApplicationHome(input);
    const third = resolveApplicationHome(
      source({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg/config" } }),
    );

    expect(first).toEqual(second);
    expect(first).toEqual(third);
  });

  // C3: a golden table replacing the former "call it twice" determinism
  // test, which could not fail against a broken implementation as long as
  // that implementation was internally consistent with itself. Each row
  // pins the exact expected `config`-root path and origin for one input
  // shape, checked twice (independently constructed `source()` calls) so a
  // regression that changes the *documented* output is caught, not just one
  // that varies call to call.
  const GOLDEN_TABLE: ReadonlyArray<{
    readonly name: string;
    readonly input: ApplicationHomeSource;
    readonly expectedConfigRoot: { readonly path: string; readonly origin: string };
  }> = [
    {
      name: "linux fallback",
      input: source({ platform: "linux" }),
      expectedConfigRoot: { path: join(FALLBACK_BASE, "config"), origin: "user-home-fallback" },
    },
    {
      name: "darwin fallback",
      input: source({ platform: "darwin" }),
      expectedConfigRoot: { path: join(FALLBACK_BASE, "config"), origin: "user-home-fallback" },
    },
    {
      name: "linux XDG_CONFIG_HOME set",
      input: source({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg/config" } }),
      expectedConfigRoot: { path: "/xdg/config/heniek", origin: "xdg-base-directory" },
    },
    {
      name: "HENIEK_HOME override",
      input: source({ env: { HENIEK_HOME: "/custom/home" } }),
      expectedConfigRoot: { path: "/custom/home/config", origin: "heniek-home-variable" },
    },
  ];

  it.each(GOLDEN_TABLE)(
    "golden table: $name resolves to the pinned config root, twice",
    ({ input, expectedConfigRoot }) => {
      expect(resolveApplicationHome(input).roots.config).toEqual(expectedConfigRoot);
      expect(resolveApplicationHome(input).roots.config).toEqual(expectedConfigRoot);
    },
  );

  it("returns a deeply frozen result — the caller cannot mutate resolved state", () => {
    const home = resolveApplicationHome(
      source({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg/config" } }),
    );

    expect(Object.isFrozen(home)).toBe(true);
    expect(Object.isFrozen(home.roots)).toBe(true);
    expect(Object.isFrozen(home.roots.config)).toBe(true);
    expect(Object.isFrozen(home.roots.data)).toBe(true);
    expect(Object.isFrozen(home.paths)).toBe(true);
    expect(Object.isFrozen(home.diagnostics)).toBe(true);

    expect(() => {
      // @ts-expect-error -- intentionally violating readonly to prove the freeze
      home.roots.config.path = "/tampered";
    }).toThrow(TypeError);
  });

  it("freezes a result whose diagnostics array is non-empty, including each element (C3)", () => {
    const home = resolveApplicationHome(
      source({
        platform: "linux",
        env: { HENIEK_HOME: "/custom/home", XDG_CONFIG_HOME: "/xdg/config" },
      }),
    );

    expect(home.diagnostics.length).toBeGreaterThan(0);
    expect(Object.isFrozen(home.diagnostics)).toBe(true);
    for (const diagnostic of home.diagnostics) {
      expect(Object.isFrozen(diagnostic)).toBe(true);
    }
    expect(() => {
      // @ts-expect-error -- intentionally violating readonly to prove the freeze
      home.diagnostics[0].message = "tampered";
    }).toThrow(TypeError);
  });

  // D6: pins `resolveApplicationHome`'s purity (design §2.1: "no
  // process.env, no os.homedir(), no filesystem access") against the one
  // channel that could quietly reintroduce ambient state — reading
  // `process.env` directly instead of the injected `source.env`. Setting a
  // *different*, deliberately-conflicting ambient `HENIEK_HOME` and
  // asserting the injected value still wins is what makes this a real
  // regression test: a version that fell back to `process.env` under some
  // internal branch would resolve to the ambient value instead.
  it("is pure: an ambient process.env.HENIEK_HOME never overrides the injected source.env (D6)", () => {
    const originalHeniekHome = process.env.HENIEK_HOME;
    process.env.HENIEK_HOME = "/ambient-should-be-ignored";
    try {
      const home = resolveApplicationHome(source({ env: { HENIEK_HOME: "/injected/home" } }));
      expect(home.roots.data).toEqual({ path: "/injected/home", origin: "heniek-home-variable" });
    } finally {
      if (originalHeniekHome === undefined) {
        delete process.env.HENIEK_HOME;
      } else {
        process.env.HENIEK_HOME = originalHeniekHome;
      }
    }
  });

  it("is pure: an ambient process.env.HENIEK_HOME does not leak in when the injected env has no override at all (D6)", () => {
    const originalHeniekHome = process.env.HENIEK_HOME;
    process.env.HENIEK_HOME = "/ambient-should-be-ignored";
    try {
      const home = resolveApplicationHome(source({ platform: "linux", env: {} }));
      expect(home.roots.data).toEqual({ path: FALLBACK_BASE, origin: "user-home-fallback" });
    } finally {
      if (originalHeniekHome === undefined) {
        delete process.env.HENIEK_HOME;
      } else {
        process.env.HENIEK_HOME = originalHeniekHome;
      }
    }
  });
});
