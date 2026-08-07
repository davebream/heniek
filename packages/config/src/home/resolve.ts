import { homedir } from "node:os";
// Explicitly `node:path/posix`, not the ambient `node:path`: the
// cross-platform determinism this module promises (AC1, "deterministic on
// macOS and Linux") only holds because darwin and linux share POSIX path
// semantics. Importing the ambient module would make `isAbsolute`/`join`/
// `resolve` behave per the *host* platform's rules, not per the *injected*
// `source.platform` — on a win32 host, `isAbsolute("/x")` is `true` and
// `join` emits backslashes, so the same injected `platform: "linux"` input
// would resolve differently depending on where the code happens to run.
// Using `path.posix` unconditionally makes every path decision here a pure
// function of `source`, matching the module's own purity docstring below.
// This module is documented and tested against POSIX-shaped inputs only
// (darwin/linux/`.heniek` fallback); it does not attempt to produce
// win32-correct paths for the "other" platform bucket.
import { posix } from "node:path";
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
 * implemented. See the internal design record for Q005 §2.2
 * for the full resolution procedure this table backs.)
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
  return relative === "." ? base : posix.join(base, relative);
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

  const diagnostics: Diagnostic[] = [];
  const override = env[HENIEK_HOME_VAR];

  // §7 line 429 / design §2.2 step 1: "use HENIEK_HOME when set to a
  // *non-empty* absolute path". An empty value (`HENIEK_HOME=""`, e.g. from
  // `systemd Environment="HENIEK_HOME="` or `export HENIEK_HOME=$UNSET_VAR`)
  // is ordinary, not a caller mistake, and must fall through to step 2/3
  // exactly like an unset variable — it is deliberately *not* routed into
  // `resolveOverrideRoots`, which is reserved for a present-and-non-empty
  // value that fails validation (relative, whitespace-only, NUL-bearing).
  //
  // `homeDirectory` is validated lazily, inside `resolveLinuxRoots` and the
  // `.heniek`-fallback branch below — the only branches that actually
  // consume it — rather than as an unconditional precondition of this
  // function. A `HENIEK_HOME` override does not need `homeDirectory` at all,
  // so a host where `os.homedir()` returns `""` (a container or CI runner
  // with `HOME` unset) must not defeat the exact override the variable
  // exists for.
  const roots =
    override !== undefined && override !== ""
      ? resolveOverrideRoots(override, env, platform, diagnostics)
      : platform === "linux"
        ? resolveLinuxRoots(env, homeDirectory, diagnostics)
        : rootsFromBase(resolveFallbackBase(homeDirectory), "user-home-fallback");

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
 * Validates `homeDirectory` and resolves the `.heniek` fallback base from
 * it (design §2.2 step 3). Called only from the branches that actually
 * consume `homeDirectory` — never unconditionally — so a `HENIEK_HOME`
 * override, or a Linux host whose XDG variables cover every category, never
 * fails on an unusable `homeDirectory` it never needed.
 */
function resolveFallbackBase(homeDirectory: string): string {
  if (homeDirectory === "" || !posix.isAbsolute(homeDirectory) || containsNulByte(homeDirectory)) {
    throw new ApplicationHomeResolutionError(
      "home.user-directory-invalid",
      "The resolved user home directory must be a non-empty absolute path.",
    );
  }
  return posix.resolve(homeDirectory, ".heniek");
}

/**
 * Step 1 of §7's resolution order: `HENIEK_HOME` is present *and non-empty*
 * (R1) — a present-but-empty override is treated as unset by the caller
 * above and never reaches this function at all; only a genuinely invalid
 * non-empty value (relative, whitespace-only, NUL-bearing) is diagnosed
 * here.
 */
function resolveOverrideRoots(
  override: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: ApplicationHomePlatform,
  diagnostics: Diagnostic[],
): Record<ApplicationHomeRootCategory, ApplicationHomeRoot> {
  // Checked first: a whitespace-only string and any relative path both fail
  // `isAbsolute` (neither starts with a path separator), so both land on
  // this one, more specific diagnosis rather than the generic "invalid
  // content" branch below. (An empty override never reaches this function —
  // see the fall-through in `resolveApplicationHome`.)
  if (!posix.isAbsolute(override)) {
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

  // XDG is a Linux-only platform default (spec §7 step 2); on darwin it was
  // never consulted in the first place, so reporting that the override
  // "ignored" it would be false and would contradict the very reason XDG is
  // absent from the darwin branch below.
  if (platform === "linux") {
    const ignoredXdgVars = (Object.keys(XDG_VARS) as ApplicationHomeRootCategory[])
      .map((category) => XDG_VARS[category])
      // An empty XDG_* value is already treated as unset everywhere else in
      // this module (see `resolveXdgCategory` below) — surfacing it here as
      // "ignored" would report a variable that was never actually going to
      // apply in the first place.
      .filter((variable) => env[variable] !== undefined && env[variable] !== "")
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
  }

  return rootsFromBase(posix.resolve(override), "heniek-home-variable");
}

/**
 * Step 2 of §7's resolution order: per-category XDG Base Directory
 * variables, Linux only. `homeDirectory` is only validated (and only
 * resolved into a fallback base) the first time some category actually
 * falls through to it — a Linux host with all four `XDG_*` variables set
 * validly never touches `homeDirectory` at all, so it never fails on one
 * that happens to be unusable.
 */
function resolveLinuxRoots(
  env: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
  diagnostics: Diagnostic[],
): Record<ApplicationHomeRootCategory, ApplicationHomeRoot> {
  let fallbackBaseCache: string | undefined;
  const getFallbackBase = (): string => {
    fallbackBaseCache ??= resolveFallbackBase(homeDirectory);
    return fallbackBaseCache;
  };

  return {
    config: resolveXdgCategory("config", env, getFallbackBase, diagnostics),
    data: resolveXdgCategory("data", env, getFallbackBase, diagnostics),
    state: resolveXdgCategory("state", env, getFallbackBase, diagnostics),
    runtime: resolveXdgCategory("runtime", env, getFallbackBase, diagnostics),
  };
}

function fallbackRoot(
  category: ApplicationHomeRootCategory,
  getFallbackBase: () => string,
): ApplicationHomeRoot {
  return {
    path: joinRelative(getFallbackBase(), BASE_RELATIVE_ROOT[category]),
    origin: "user-home-fallback",
  };
}

function resolveXdgCategory(
  category: ApplicationHomeRootCategory,
  env: Readonly<Record<string, string | undefined>>,
  getFallbackBase: () => string,
  diagnostics: Diagnostic[],
): ApplicationHomeRoot {
  const variable = XDG_VARS[category];
  const value = env[variable];

  // Unset or empty is not an error: it simply means this category was not
  // configured, and falls through to the `.heniek` default like any other
  // unconfigured category ("categories are independent, so a partially
  // configured Linux host is still deterministic").
  if (value === undefined || value === "") {
    return fallbackRoot(category, getFallbackBase);
  }

  const notAbsolute = !posix.isAbsolute(value);
  const hasNulByte = containsNulByte(value);
  if (notAbsolute || hasNulByte) {
    // LOW: the two conditions are genuinely different failures — a relative
    // path and an absolute-but-NUL-bearing path — and only one of them makes
    // "is set but is not an absolute path" a true statement. The code stays
    // the single `home.xdg-variable-not-absolute` (both are still "ignore
    // and fall back to the .heniek default" outcomes), but the message no
    // longer claims something false about a NUL-bearing absolute value.
    const reason = notAbsolute
      ? "is set but is not an absolute path"
      : "is set but contains a NUL byte";
    diagnostics.push(
      createDiagnostic(
        "home.xdg-variable-not-absolute",
        "warning",
        `${variable} ${reason}; falling back to the .heniek default for this category.`,
      ),
    );
    return fallbackRoot(category, getFallbackBase);
  }

  return { path: posix.join(posix.resolve(value), "heniek"), origin: "xdg-base-directory" };
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
 *
 * R2: `env` defaults to a *snapshot* (`{ ...process.env }`), not a live
 * reference to `process.env` itself. `resolveApplicationHome` is documented
 * and tested as pure, and a caller is expected to be able to hold a
 * previously-read `ApplicationHomeSource` and resolve it later without its
 * meaning silently changing; a live `process.env` reference would let an
 * unrelated later mutation of the ambient environment (elsewhere in the
 * process, between when the source was read and when it is resolved)
 * retroactively change what an already-captured source describes.
 */
export function readApplicationHomeSource(
  env: NodeJS.ProcessEnv = { ...process.env },
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
): ApplicationHomeSource {
  return {
    platform: platform === "darwin" || platform === "linux" ? platform : "other",
    env,
    homeDirectory,
  };
}
