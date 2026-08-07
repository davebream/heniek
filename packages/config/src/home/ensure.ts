import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Diagnostic } from "../diagnostics.js";
import { createDiagnostic, sortDiagnostics } from "../diagnostics.js";
import type { ApplicationHomeRootCategory } from "./layout.js";
import { APPLICATION_HOME_DIRECTORY_ENTRIES, APPLICATION_HOME_LAYOUT } from "./layout.js";
import type { ApplicationHome } from "./resolve.js";

const DIRECTORY_MODE = 0o700;

export interface ApplicationHomeDirectoryReport {
  readonly path: string;
  readonly created: boolean;
  readonly permissionsRepaired: boolean;
  /**
   * Omitted (not fabricated) when permission enforcement was skipped for the
   * platform injected via `ApplicationHomeEnsureOptions.platform` (LOW) —
   * POSIX mode bits carry no meaning there, so there is no real mode to
   * report.
   */
  readonly mode?: number;
}

export interface ApplicationHomeEnsureReport {
  readonly directories: readonly ApplicationHomeDirectoryReport[];
  readonly diagnostics: readonly Diagnostic[];
}

/** True when `mode`'s group or other permission bits (the low 6 bits) are set. */
function hasGroupOrOtherAccess(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

const ROOT_CATEGORIES: readonly ApplicationHomeRootCategory[] = [
  "config",
  "data",
  "state",
  "runtime",
];

/**
 * LOW: `process.platform` used to be read inline inside
 * `ensureApplicationHomeDirectories`, which made the win32 (no-POSIX-mode)
 * branch unreachable from a test running on any other host. Every other
 * ambient input in this package is injected (`ApplicationHomeSource`); this
 * mirrors that convention. Gated on this injectable `options.platform`,
 * never on `home.platform`: `home.platform` is the closed `"darwin" |
 * "linux" | "other"` union used for *path resolution*, and every BSD or
 * other POSIX platform collapses into `"other"` there — reusing it here
 * would silently disable 0700 enforcement on a real POSIX system that needs
 * it.
 */
export interface ApplicationHomeEnsureOptions {
  /** Defaults to `process.platform`. Enforcement applies to everything except `"win32"`. */
  readonly platform?: NodeJS.Platform;
}

/** One directory this pass must materialise/verify: a canonical layout entry, or a bare root (H2). `name`/`origin` are used only in diagnostics — never the resolved `path` itself (M3). */
interface DirectoryTarget {
  readonly path: string;
  readonly name: string;
  readonly origin: string;
}

/**
 * POSIX segment count of `path` — used purely to order `DirectoryTarget`s
 * shallowest-first (H2), so a parent directory is always created and
 * permission-checked before any child that lives under it. `resolve.ts` is
 * documented as POSIX-pure (design R2), so every path this module ever sees
 * is `/`-separated regardless of host, and a literal split on `/` is exact.
 */
function posixSegmentCount(path: string): number {
  return path.split("/").filter((segment) => segment.length > 0).length;
}

/**
 * Collects every directory this pass must ensure: every directory-shaped
 * layout entry (`configDirectory`, `secretsDirectory`, …) *and* every
 * `home.roots[*].path` (H2) — the layout table only pins a `relative: "."`
 * entry to two of the four roots (config, runtime) today, so the data and
 * state roots were previously only ever touched implicitly as a `mkdir -p`
 * parent: never permission-checked, never repaired, never reported. A
 * pre-existing `0755` data root would sail through silently.
 *
 * De-duplicated by resolved path (a root and a layout entry can coincide,
 * e.g. `configDirectory` *is* `roots.config` when its relative segment is
 * `"."`, or `roots.data`/`roots.state` coincide with each other in
 * single-root `HENIEK_HOME`/`.heniek`-fallback mode) and sorted
 * shallowest-first, so a parent is always ensured before any child nested
 * under it.
 */
function collectDirectoryTargets(home: ApplicationHome): readonly DirectoryTarget[] {
  const byPath = new Map<string, DirectoryTarget>();

  for (const category of ROOT_CATEGORIES) {
    const root = home.roots[category];
    if (!byPath.has(root.path)) {
      byPath.set(root.path, { path: root.path, name: `roots.${category}`, origin: root.origin });
    }
  }

  for (const entry of APPLICATION_HOME_DIRECTORY_ENTRIES) {
    const path = home.paths[entry];
    if (!byPath.has(path)) {
      const layoutEntry = APPLICATION_HOME_LAYOUT[entry];
      byPath.set(path, { path, name: entry, origin: home.roots[layoutEntry.root].origin });
    }
  }

  return [...byPath.values()].sort((a, b) => posixSegmentCount(a.path) - posixSegmentCount(b.path));
}

/**
 * Materialises every directory of `home` on disk (design §2.4): each is
 * `mkdir`ed `0o700`, then re-`lstat`ed (H1 — never `stat`, see below) and
 * `chmod`ed back to `0o700` if group/other bits are present — `mkdir({
 * mode })` alone is not enough because (a) a process umask can only ever
 * *widen* the gap between the requested mode and the applied one when the
 * umask itself clears bits `mkdir` was asked to set, and more importantly
 * (b) `mkdir({ recursive: true })` is a silent no-op for a directory that
 * already exists, so it never touches the mode of a directory that
 * predates this call (an older, laxer version of this store; a restored
 * backup; one planted by something else).
 *
 * H1: every post-`mkdir` check uses `lstat`, never `stat`. `mkdir({
 * recursive: true })` silently succeeds when the final path component is a
 * symlink to a directory, and `stat` would then follow that link and
 * report on the *target* — every permission check below would then silently
 * apply to an attacker-redirected directory instead of the one that was
 * asked for. A symlinked entry, a non-directory entry, or (on POSIX) an
 * entry not owned by the current process is refused outright: an `error`
 * diagnostic is added and `permissionsRepaired` stays `false` — this pass
 * never reports success for a directory it did not actually verify (mirrors
 * `packages/secrets/src/file-store.ts`'s `prepareDirectory`).
 *
 * H3: after a repair `chmod`, the directory is re-`lstat`ed and the repair
 * is only reported as successful if the group/other bits are actually gone
 * afterwards — a filesystem that silently ignores `chmod` (some network
 * mounts do) is caught here rather than trusted on faith.
 *
 * H2: includes every `home.roots[*].path`, not just the canonical layout's
 * directory entries — see `collectDirectoryTargets`.
 *
 * M3: every raw `fs` failure is reported as an `error` diagnostic naming
 * the *layout entry or root* (`secretsDirectory`, `roots.data`, …) and its
 * *origin*, never the resolved path itself — a `HENIEK_HOME`/`XDG_*`-derived
 * path can itself be sensitive (see `ApplicationHomeResolutionError`'s
 * house rule), and a raw `fs` error's own message embeds the full path
 * (`EACCES: permission denied, mkdir '/opt/secret-home/config'`).
 *
 * File entries (`defaultsFile`, `stateDatabaseFile`, `daemonSocketFile`,
 * `daemonPidFile`) are not created here — only their parent directories are
 * materialised, since the files themselves are written by their respective
 * owning subsystems (Q006's SQLite state, Q014's defaults document, the
 * daemon's own socket/pid lifecycle), each of which knows its own correct
 * initial content and permission profile.
 *
 * Skipped on non-POSIX platforms (see `ApplicationHomeEnsureOptions`),
 * where POSIX mode bits have no meaning — an `info` diagnostic records the
 * skip rather than reporting fabricated permission evidence.
 */
export async function ensureApplicationHomeDirectories(
  home: ApplicationHome,
  options: ApplicationHomeEnsureOptions = {},
): Promise<ApplicationHomeEnsureReport> {
  const platform = options.platform ?? process.platform;
  const enforcePermissions = platform !== "win32";

  const targets = collectDirectoryTargets(home);
  const diagnostics: Diagnostic[] = [];
  if (!enforcePermissions) {
    diagnostics.push(
      createDiagnostic(
        "home.directory-permissions-skipped",
        "info",
        "Directory permission enforcement (mode 0700) was skipped: POSIX mode bits do not apply on this platform.",
      ),
    );
  }

  const directories: ApplicationHomeDirectoryReport[] = [];
  for (const target of targets) {
    const report = await ensureDirectory(target, enforcePermissions, diagnostics);
    if (report !== undefined) {
      directories.push(report);
    }
  }

  // H6: spec §7 is normative that product state lives outside repositories.
  // A `.git` entry found walking up from a root is only ever a `warning` —
  // never a rejection — since a home directory living inside e.g. a
  // dotfiles repository is a legitimate, common setup; this only exists so
  // that fact is visible rather than silent.
  for (const category of ROOT_CATEGORIES) {
    const root = home.roots[category];
    const repositoryRoot = await findEnclosingGitRepository(root.path);
    if (repositoryRoot !== undefined) {
      diagnostics.push(
        createDiagnostic(
          "home.root-inside-repository",
          "warning",
          `The "${category}" root sits inside a git repository.`,
        ),
      );
    }
  }

  return { directories, diagnostics: sortDiagnostics(diagnostics) };
}

/**
 * Walks up from `startPath` (inclusive) looking for a `.git` entry — a
 * directory for an ordinary repository, or a file for a linked worktree;
 * either is sufficient evidence the path sits inside a git-managed tree —
 * stopping at the filesystem root. Returns the directory carrying the
 * `.git` entry, or `undefined` if none is found (H6).
 */
async function findEnclosingGitRepository(startPath: string): Promise<string | undefined> {
  let current = startPath;
  for (;;) {
    const hasGit = await lstat(join(current, ".git"))
      .then(() => true)
      .catch(() => false);
    if (hasGit) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function errnoCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "unknown error";
}

/** M3: builds an `error` diagnostic naming `target.name`/`target.origin` — never `target.path` — for a raw `fs` failure. */
function fsFailureDiagnostic(code: string, message: string, target: DirectoryTarget): Diagnostic {
  return createDiagnostic(
    code,
    "error",
    `${message} for "${target.name}" (root origin: ${target.origin}).`,
  );
}

async function ensureDirectory(
  target: DirectoryTarget,
  enforcePermissions: boolean,
  diagnostics: Diagnostic[],
): Promise<ApplicationHomeDirectoryReport | undefined> {
  const { path } = target;

  let before: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    before = await lstat(path);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      diagnostics.push(
        fsFailureDiagnostic(
          "home.directory-stat-failed",
          `Could not inspect a required application-home directory (${errnoCode(error)})`,
          target,
        ),
      );
      return undefined;
    }
    before = undefined;
  }

  if (before?.isSymbolicLink()) {
    diagnostics.push(
      createDiagnostic(
        "home.directory-is-symlink",
        "error",
        `Refusing "${target.name}" (root origin: ${target.origin}): the resolved path is a ` +
          "symlink, not a real directory — materialising it could silently follow an " +
          "attacker-redirected location.",
      ),
    );
    return undefined;
  }

  // H1: on POSIX, a pre-existing directory not owned by the current process
  // is refused outright, mirroring `packages/secrets/src/file-store.ts`'s
  // `prepareDirectory`. An attacker with write access to a shared parent
  // could otherwise pre-create this directory (with permissive-looking mode
  // bits this pass would then "repair" to 0700) while still controlling it
  // via ownership-independent means. `process.getuid` is undefined on
  // Windows, where this check does not apply.
  if (before !== undefined) {
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && before.uid !== currentUid) {
      diagnostics.push(
        createDiagnostic(
          "home.directory-wrong-owner",
          "error",
          `Refusing "${target.name}" (root origin: ${target.origin}): the directory exists but ` +
            "is owned by a different user than the current process.",
        ),
      );
      return undefined;
    }
  }

  try {
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  } catch (error) {
    diagnostics.push(
      fsFailureDiagnostic(
        "home.directory-create-failed",
        `Could not create a required application-home directory (${errnoCode(error)})`,
        target,
      ),
    );
    return undefined;
  }

  if (!enforcePermissions) {
    return { path, created: before === undefined, permissionsRepaired: false };
  }

  let after: Awaited<ReturnType<typeof lstat>>;
  try {
    after = await lstat(path);
  } catch (error) {
    diagnostics.push(
      fsFailureDiagnostic(
        "home.directory-stat-failed",
        `Could not inspect a required application-home directory after creation (${errnoCode(error)})`,
        target,
      ),
    );
    return undefined;
  }

  if (!hasGroupOrOtherAccess(after.mode)) {
    return {
      path,
      created: before === undefined,
      permissionsRepaired: false,
      mode: after.mode & 0o777,
    };
  }

  try {
    await chmod(path, DIRECTORY_MODE);
  } catch (error) {
    diagnostics.push(
      fsFailureDiagnostic(
        "home.directory-chmod-failed",
        `Could not repair permissions on a required application-home directory (${errnoCode(error)})`,
        target,
      ),
    );
    return {
      path,
      created: before === undefined,
      permissionsRepaired: false,
      mode: after.mode & 0o777,
    };
  }

  // H3: the `chmod` call not throwing is not itself proof the repair took —
  // some network filesystems silently ignore `chmod`. Re-`lstat` and only
  // report `permissionsRepaired: true` if the group/other bits are actually
  // gone (mirrors `packages/secrets/src/file-store.ts:162-169`).
  const repaired = await lstat(path);
  if (hasGroupOrOtherAccess(repaired.mode)) {
    diagnostics.push(
      createDiagnostic(
        "home.directory-repair-failed",
        "error",
        `Refusing "${target.name}" (root origin: ${target.origin}): permission repair to mode ` +
          `0700 did not take effect (mode ${(repaired.mode & 0o777).toString(8)} still allows ` +
          "group/other access).",
      ),
    );
    return {
      path,
      created: before === undefined,
      permissionsRepaired: false,
      mode: repaired.mode & 0o777,
    };
  }

  return {
    path,
    created: before === undefined,
    permissionsRepaired: true,
    mode: repaired.mode & 0o777,
  };
}

/**
 * The directory a `SecretStore` file adapter should default to when the
 * caller does not supply an explicit location — `home.paths.secretsDirectory`
 * (design §2.3/§5). Kept as a named function rather than inlined at call
 * sites so "which directory backs the default secret store" has exactly one
 * answer.
 */
export function defaultSecretStoreDirectory(home: ApplicationHome): string {
  return home.paths.secretsDirectory;
}
