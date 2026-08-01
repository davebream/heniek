import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Diagnostic } from "../diagnostics.js";
import { createDiagnostic, sortDiagnostics } from "../diagnostics.js";
import { deepFreeze } from "../json.js";
import { ApplicationHomeResolutionError } from "./errors.js";
import type { ApplicationHomeEntry, ApplicationHomeRootCategory } from "./layout.js";
import { APPLICATION_HOME_LAYOUT } from "./layout.js";

export type ApplicationHomePlatform = "darwin" | "linux" | "other";

export interface ApplicationHomeSource {
  readonly platform: ApplicationHomePlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}

export type ApplicationHomeRootOrigin =
  | "heniek-home-variable" // HENIEK_HOME
  | "xdg-base-directory" // XDG_*_HOME / XDG_RUNTIME_DIR on Linux
  | "user-home-fallback"; // <homeDirectory>/.heniek

export interface ApplicationHomeRoot {
  readonly path: string;
  readonly origin: ApplicationHomeRootOrigin;
}

export interface ApplicationHome {
  readonly platform: ApplicationHomePlatform;
  readonly roots: Readonly<Record<ApplicationHomeRootCategory, ApplicationHomeRoot>>;
  readonly paths: Readonly<Record<ApplicationHomeEntry, string>>;
  readonly diagnostics: readonly Diagnostic[];
}

const HENIEK_HOME_VAR = "HENIEK_HOME";

const XDG_VARS: Readonly<Record<ApplicationHomeRootCategory, string>> = {
  config: "XDG_CONFIG_HOME",
  data: "XDG_DATA_HOME",
  state: "XDG_STATE_HOME",
  runtime: "XDG_RUNTIME_DIR",
};

/**
 * Relative path from a shared base directory to each root category. Used
 * both by the `.heniek` fallback (spec §7's canonical tree, design §2.2
 * step 3) and by a `HENIEK_HOME` override (design §2.2 step 1) — the design
 * states the override reproduces the *same* canonical tree shape, just
 * rooted at the override value instead of `<homeDirectory>/.heniek`, so
 * both cases share this one table rather than duplicating it. (The design's
 * prose for the override case, "every root is `path.resolve(value)`", reads
 * literally as all four roots collapsing to one identical path; taken
 * literally that would put `config/`'s children as siblings of `data/`'s
 * children instead of nested under a `config/` directory, which would NOT
 * reproduce §7's tree — the explicit acceptance requirement is byte-for-byte
 * tree reproduction, so this table, not the literal prose, is what is
 * implemented. See the phase-2 build report for this call.)
 */
const BASE_RELATIVE_ROOT: Readonly<Record<ApplicationHomeRootCategory, string>> = {
  config: "config",
  data: ".",
  state: ".",
  runtime: "runtime",
};

const NUL_BYTE = String.fromCharCode(0);

function containsNulByte(value: string): boolean {
  return value.includes(NUL_BYTE);
}

function joinRelative(base: string, relative: string): string {
  return relative === "." ? base : join(base, relative);
}

function rootsFromBase(
  base: string,
  origin: ApplicationHomeRootOrigin,
): Record<ApplicationHomeRootCategory, ApplicationHomeRoot> {
  return {
    config: { path: joinRelative(base, BASE_RELATIVE_ROOT.config), origin },
    data: { path: joinRelative(base, BASE_RELATIVE_ROOT.data), origin },
    state: { path: joinRelative(base, BASE_RELATIVE_ROOT.state), origin },
    runtime: { path: joinRelative(base, BASE_RELATIVE_ROOT.runtime), origin },
  };
}

/**
 * Resolves one application home from an already-collected `source` (design
 * §2.1). Pure: no `process.env`, no `os.homedir()`, no filesystem access, no
 * clock — every input arrives through `source`. That purity is what makes
 * AC1's "deterministic on macOS and Linux" testable as an injected-platform
 * table without ever running on a Mac; `readApplicationHomeSource` below is
 * the only function in this module that touches the ambient environment.
 */
export function resolveApplicationHome(source: ApplicationHomeSource): ApplicationHome {
  const { platform, env, homeDirectory } = source;

  // Nothing downstream — the `.heniek` fallback, and every XDG category
  // that falls through to it — can be deterministic without a usable home
  // directory, so this is checked first, regardless of which branch below
  // ultimately fires (even a HENIEK_HOME override does not need
  // `homeDirectory`, but requiring it unconditionally keeps the function's
  // precondition simple and independent of which branch is taken).
  if (homeDirectory === "" || !isAbsolute(homeDirectory)) {
    throw new ApplicationHomeResolutionError(
      "home.user-directory-invalid",
      "The resolved user home directory must be a non-empty absolute path.",
    );
  }

  const diagnostics: Diagnostic[] = [];
  const override = env[HENIEK_HOME_VAR];

  const roots =
    override !== undefined
      ? resolveOverrideRoots(override, env, diagnostics)
      : platform === "linux"
        ? resolveLinuxRoots(env, homeDirectory, diagnostics)
        : rootsFromBase(resolve(homeDirectory, ".heniek"), "user-home-fallback");

  // Deeply frozen — a caller that holds a reference to `home.roots.config`
  // or `home.paths` (rather than the root `home` object) must not be able to
  // mutate resolved state either.
  return deepFreeze({
    platform,
    roots,
    paths: buildPaths(roots),
    diagnostics: sortDiagnostics(diagnostics),
  });
}

/**
 * Step 1 of §7's resolution order: `HENIEK_HOME` is present (its mere
 * presence is the gate — an empty value is rejected below by the
 * absoluteness check, rather than being treated as "unset", since a
 * present-but-empty override is a caller mistake, not the absence of one).
 */
function resolveOverrideRoots(
  override: string,
  env: Readonly<Record<string, string | undefined>>,
  diagnostics: Diagnostic[],
): Record<ApplicationHomeRootCategory, ApplicationHomeRoot> {
  // Checked first: an empty string, a whitespace-only string, and any
  // relative path all fail `isAbsolute` (none starts with a path
  // separator), so all three land on this one, more specific diagnosis
  // rather than the generic "invalid content" branch below.
  if (!isAbsolute(override)) {
    throw new ApplicationHomeResolutionError(
      "home.override-not-absolute",
      `${HENIEK_HOME_VAR} must be set to a non-empty absolute path when present.`,
    );
  }
  // A NUL byte can still slip through an absolute-looking value (e.g. a
  // value containing an embedded NUL) and would otherwise propagate into
  // every derived filesystem path, including the daemon socket path — it is
  // rejected outright rather than silently normalised away.
  if (containsNulByte(override)) {
    throw new ApplicationHomeResolutionError(
      "home.override-invalid",
      `${HENIEK_HOME_VAR} must not contain a NUL byte.`,
    );
  }

  const ignoredXdgVars = (Object.keys(XDG_VARS) as ApplicationHomeRootCategory[])
    .map((category) => XDG_VARS[category])
    .filter((variable) => env[variable] !== undefined)
    .sort();
  if (ignoredXdgVars.length > 0) {
    // Info, not a warning: this is expected, documented behaviour ("HENIEK_HOME
    // overrides platform defaults"), not a misconfiguration — but a silent
    // override could otherwise look like the XDG variables were simply
    // never noticed, so the conflict is still surfaced.
    diagnostics.push(
      createDiagnostic(
        "home.xdg-ignored-under-override",
        "info",
        `${HENIEK_HOME_VAR} overrides platform defaults; ignoring: ${ignoredXdgVars.join(", ")}.`,
      ),
    );
  }

  return rootsFromBase(resolve(override), "heniek-home-variable");
}

/** Step 2 of §7's resolution order: per-category XDG Base Directory variables, Linux only. */
function resolveLinuxRoots(
  env: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
  diagnostics: Diagnostic[],
): Record<ApplicationHomeRootCategory, ApplicationHomeRoot> {
  const fallbackBase = resolve(homeDirectory, ".heniek");
  return {
    config: resolveXdgCategory("config", env, fallbackBase, diagnostics),
    data: resolveXdgCategory("data", env, fallbackBase, diagnostics),
    state: resolveXdgCategory("state", env, fallbackBase, diagnostics),
    runtime: resolveXdgCategory("runtime", env, fallbackBase, diagnostics),
  };
}

function fallbackRoot(
  category: ApplicationHomeRootCategory,
  fallbackBase: string,
): ApplicationHomeRoot {
  return {
    path: joinRelative(fallbackBase, BASE_RELATIVE_ROOT[category]),
    origin: "user-home-fallback",
  };
}

function resolveXdgCategory(
  category: ApplicationHomeRootCategory,
  env: Readonly<Record<string, string | undefined>>,
  fallbackBase: string,
  diagnostics: Diagnostic[],
): ApplicationHomeRoot {
  const variable = XDG_VARS[category];
  const value = env[variable];

  // Unset or empty is not an error: it simply means this category was not
  // configured, and falls through to the `.heniek` default like any other
  // unconfigured category ("categories are independent, so a partially
  // configured Linux host is still deterministic").
  if (value === undefined || value === "") {
    return fallbackRoot(category, fallbackBase);
  }

  if (!isAbsolute(value) || containsNulByte(value)) {
    diagnostics.push(
      createDiagnostic(
        "home.xdg-variable-not-absolute",
        "warning",
        `${variable} is set but is not an absolute path; falling back to the .heniek default for this category.`,
      ),
    );
    return fallbackRoot(category, fallbackBase);
  }

  return { path: join(resolve(value), "heniek"), origin: "xdg-base-directory" };
}

function buildPaths(
  roots: Record<ApplicationHomeRootCategory, ApplicationHomeRoot>,
): Record<ApplicationHomeEntry, string> {
  const entries = Object.keys(APPLICATION_HOME_LAYOUT) as ApplicationHomeEntry[];
  const paths = {} as Record<ApplicationHomeEntry, string>;
  for (const entry of entries) {
    const layoutEntry = APPLICATION_HOME_LAYOUT[entry];
    paths[entry] = joinRelative(roots[layoutEntry.root].path, layoutEntry.relative);
  }
  return paths;
}

/**
 * Reads the ambient environment, platform, and home directory into an
 * `ApplicationHomeSource` for `resolveApplicationHome` — the only function
 * in this module allowed to touch `process`/`os` (mirrors
 * `packages/conformance/src/smoke/env.ts`'s injected-input convention).
 * Parameters default to the real ambient values so production call sites
 * need no arguments, while tests can inject any combination.
 */
export function readApplicationHomeSource(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
): ApplicationHomeSource {
  return {
    platform: platform === "darwin" || platform === "linux" ? platform : "other",
    env,
    homeDirectory,
  };
}
