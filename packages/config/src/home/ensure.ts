import { chmod, mkdir, stat } from "node:fs/promises";
import type { Diagnostic } from "../diagnostics.js";
import { createDiagnostic, sortDiagnostics } from "../diagnostics.js";
import { APPLICATION_HOME_DIRECTORY_ENTRIES } from "./layout.js";
import type { ApplicationHome } from "./resolve.js";

const DIRECTORY_MODE = 0o700;

export interface ApplicationHomeDirectoryReport {
  readonly path: string;
  readonly created: boolean;
  readonly permissionsRepaired: boolean;
  readonly mode: number;
}

export interface ApplicationHomeEnsureReport {
  readonly directories: readonly ApplicationHomeDirectoryReport[];
  readonly diagnostics: readonly Diagnostic[];
}

/** True when `mode`'s group or other permission bits (the low 6 bits) are set. */
function hasGroupOrOtherAccess(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/**
 * Materialises every directory entry of `home` on disk (design §2.4): each
 * is `mkdir`ed `0o700`, then re-`stat`ed and `chmod`ed back to `0o700` if
 * group/other bits are present — `mkdir({ mode })` alone is not enough
 * because (a) a process umask can only ever *widen* the gap between the
 * requested mode and the applied one when the umask itself clears bits
 * `mkdir` was asked to set, and more importantly (b) `mkdir({ recursive:
 * true })` is a silent no-op for a directory that already exists, so it
 * never touches the mode of a directory that predates this call (an older,
 * laxer version of this store; a restored backup; one planted by
 * something else).
 *
 * File entries (`defaultsFile`, `stateDatabaseFile`, `daemonSocketFile`,
 * `daemonPidFile`) are not created here — only their parent directories are
 * materialised, since the files themselves are written by their respective
 * owning subsystems (Q006's SQLite state, Q014's defaults document, the
 * daemon's own socket/pid lifecycle), each of which knows its own correct
 * initial content and permission profile.
 *
 * Skipped on non-POSIX platforms (`process.platform === "win32"`), where
 * POSIX mode bits have no meaning — an `info` diagnostic records the skip
 * rather than reporting fabricated permission evidence.
 */
export async function ensureApplicationHomeDirectories(
  home: ApplicationHome,
): Promise<ApplicationHomeEnsureReport> {
  const enforcePermissions = process.platform !== "win32";

  const directories: ApplicationHomeDirectoryReport[] = [];
  for (const entry of APPLICATION_HOME_DIRECTORY_ENTRIES) {
    const path = home.paths[entry];
    directories.push(await ensureDirectory(path, enforcePermissions));
  }

  const diagnostics = enforcePermissions
    ? []
    : [
        createDiagnostic(
          "home.directory-permissions-skipped",
          "info",
          "Directory permission enforcement (mode 0700) was skipped: POSIX mode bits do not apply on this platform.",
        ),
      ];

  return { directories, diagnostics: sortDiagnostics(diagnostics) };
}

async function ensureDirectory(
  path: string,
  enforcePermissions: boolean,
): Promise<ApplicationHomeDirectoryReport> {
  const before = await stat(path).catch(() => undefined);
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });

  if (!enforcePermissions) {
    return {
      path,
      created: before === undefined,
      permissionsRepaired: false,
      mode: DIRECTORY_MODE,
    };
  }

  const after = await stat(path);
  let permissionsRepaired = false;
  if (hasGroupOrOtherAccess(after.mode)) {
    await chmod(path, DIRECTORY_MODE);
    permissionsRepaired = true;
  }
  const finalStats = permissionsRepaired ? await stat(path) : after;

  return {
    path,
    created: before === undefined,
    permissionsRepaired,
    mode: finalStats.mode & 0o777,
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
