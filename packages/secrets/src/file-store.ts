import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { SensitiveValue } from "./sensitive-value.js";
import {
  assertValidEntryName,
  CorruptSecretStoreEntryError,
  InsecureSecretStoreError,
  SECRET_ENTRY_NAME_PATTERN,
  type SecretStore,
  SecretStoreConfigurationError,
} from "./store.js";

const DIRECTORY_MODE = 0o700;
const ENTRY_MODE = 0o600;
const ENTRY_SUFFIX = ".entry";

export interface FileSecretStoreOptions {
  readonly directory: string;
}

/**
 * A `SecretStore` backed by one file per entry under `options.directory`
 * (§27.4/§6.3):
 *
 *  - the directory is created `0o700`, rejected outright if it is a symlink
 *    or not owned by this process, and re-`chmod`ed back to `0o700` if a
 *    *pre-existing* directory carried group/other bits (see the repair note
 *    on `prepareDirectory` for why a umask is not the cause); a directory
 *    that still cannot be made private throws `InsecureSecretStoreError`
 *    rather than silently storing credentials somewhere readable;
 *  - entries are named `<name>.entry`, one per credential;
 *  - writes go to a same-directory temp file opened with `wx` and mode
 *    `0o600`, are `fsync`ed, then atomically `rename`d over the real target,
 *    so a crash mid-write never leaves a partial or world-readable
 *    credential. The temp filename already carries 9 random bytes, so a
 *    same-name collision is vanishingly unlikely on its own — `wx` is
 *    defence in depth against that residual chance, not the primary
 *    collision guard;
 *  - reads re-check the entry's mode on every call and refuse a
 *    group/other-readable file, so an entry widened out-of-band (a `chmod`
 *    run by something else) is caught the next time it is read, not just at
 *    directory-creation time.
 *
 * Verification cadence is deliberately asymmetric, and will be recorded as
 * such in ADR 0004: the directory (symlink/ownership/mode) is verified once
 * per store instance, memoized by `ensureReady`'s `ready` promise; entry
 * files are verified on every single read. Re-`stat`ing the directory on
 * every operation would buy little once it is confirmed `0700` and
 * owner-verified — nothing this process does can widen it again without
 * going through `chmod`/`rename` itself — whereas an individual entry file
 * is cheap to re-check and is the thing most likely to be touched
 * out-of-band (a stray `chmod`, a hand-placed replacement).
 */
export function createFileSecretStore(options: FileSecretStoreOptions): SecretStore {
  // A relative `directory` must be rejected rather than silently resolved
  // against `process.cwd()`: run from a repository checkout, that would
  // route credential files straight into the repository — exactly what
  // "keep secrets out of … repository-local state" forbids. Requiring an
  // absolute path up front makes the caller's intent explicit instead of
  // depending on the process's working directory at store-creation time.
  if (!isAbsolute(options.directory)) {
    throw new SecretStoreConfigurationError(
      `Secret store directory must be an absolute path, got: ${options.directory}`,
    );
  }
  const directory = options.directory;
  let ready: Promise<void> | undefined;

  function ensureReady(): Promise<void> {
    // A failed `prepareDirectory` must not poison the store for the rest of
    // the process's lifetime: without the `.catch` below, `ready` would
    // permanently cache a *rejected* promise, and every subsequent call
    // would immediately reject with the same stale error even after a
    // transient condition (e.g. EACCES from a momentarily locked parent)
    // clears. Resetting `ready` before rethrowing lets the next call retry.
    ready ??= prepareDirectory(directory).catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  }

  return {
    id: `file:${directory}`,
    async read(name) {
      assertValidEntryName(name);
      await ensureReady();
      return readEntry(directory, name);
    },
    async write(name, value) {
      assertValidEntryName(name);
      await ensureReady();
      await writeEntry(directory, name, value);
    },
    async remove(name) {
      assertValidEntryName(name);
      await ensureReady();
      return removeEntry(directory, name);
    },
    async list() {
      await ensureReady();
      return listEntries(directory);
    },
  };
}

/** True when `mode`'s group or other permission bits (the low 6 bits) are set. */
function hasGroupOrOtherAccess(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

async function prepareDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });

  // `lstat` (not `stat`): `mkdir({ recursive: true })` succeeds silently
  // when the final path component is a symlink to a directory, and `stat`
  // would then follow that link and report on the *target* — so every mode
  // check below would silently apply to an attacker-controlled directory
  // instead of the one we asked for. `lstat` reports on the link itself,
  // so a symlink is caught here before any permission bit is trusted.
  const stats = await lstat(directory);
  if (stats.isSymbolicLink()) {
    throw new InsecureSecretStoreError(
      directory,
      "path is a symlink — refusing to store credentials through a link that could point somewhere else",
    );
  }
  if (!stats.isDirectory()) {
    throw new InsecureSecretStoreError(directory, "path exists and is not a directory");
  }

  // On POSIX, also require the directory to be owned by the current
  // process. Without this, an attacker with write access to a shared parent
  // directory could pre-create the secrets directory (with permissive-looking
  // mode bits that this store would then "repair" to 0700) while still
  // controlling it via ownership-independent means, or simply read it before
  // this process narrows the permissions. `process.getuid` is undefined on
  // Windows, where this check does not apply.
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stats.uid !== currentUid) {
    throw new InsecureSecretStoreError(
      directory,
      `directory is owned by uid ${stats.uid}, not the current process (uid ${currentUid})`,
    );
  }

  if (!hasGroupOrOtherAccess(stats.mode)) {
    return;
  }

  // A umask can only *clear* permission bits, so `mkdir(mode: 0o700)` above
  // can never itself yield a mode wider than `0700` on a freshly created
  // directory. The repair below exists for a different reason:
  // `mkdir({ recursive: true })` is a silent no-op when the final path
  // component already exists — it does not adjust the mode of a
  // pre-existing directory. A directory that predates this store (an
  // earlier, laxer version; a restored backup; one planted by something
  // else) can therefore already be group/other readable, and this is the
  // only place that ever repairs it. Repair once, then verify — a
  // filesystem that refuses the `chmod` (some network mounts do) must fail
  // loudly rather than silently storing credentials in a world-readable
  // directory.
  await chmod(directory, DIRECTORY_MODE);
  const repaired = await lstat(directory);
  if (hasGroupOrOtherAccess(repaired.mode)) {
    throw new InsecureSecretStoreError(
      directory,
      `directory mode ${(repaired.mode & 0o777).toString(8)} allows group or other access and could not be repaired`,
    );
  }
}

function entryPath(directory: string, name: string): string {
  return join(directory, `${name}${ENTRY_SUFFIX}`);
}

function temporaryEntryPath(directory: string, name: string): string {
  return join(directory, `.${name}.${randomBytes(9).toString("base64url")}.tmp`);
}

async function writeEntry(directory: string, name: string, value: SensitiveValue): Promise<void> {
  const target = entryPath(directory, name);
  const temp = temporaryEntryPath(directory, name);

  // The whole open -> write -> sync -> close -> rename sequence is one unit:
  // any failure at any step (ENOSPC/EIO/EDQUOT on write, a failed fsync, a
  // failed close, a failed rename) must not leave the temp file behind. The
  // temp name is dot-prefixed and not `.entry`-suffixed, so `list()` never
  // surfaces it and, left uncleaned, it accumulates forever holding
  // whatever partial credential bytes were flushed before the failure.
  try {
    const handle = await open(temp, "wx", ENTRY_MODE);
    try {
      await handle.writeFile(value.expose(), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function readEntry(directory: string, name: string): Promise<SensitiveValue | undefined> {
  const target = entryPath(directory, name);

  // Opened once and re-used for both the mode check and the read, rather
  // than `stat(target)` followed by a separate `readFile(target)`: two
  // path-based calls resolve `target` twice and leave a TOCTOU window
  // between them (the file could be replaced in between). `handle.stat()`
  // and `handle.readFile()` both operate on the already-open file
  // descriptor, so the mode that is checked is guaranteed to be the mode of
  // the bytes that are then read.
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(target, "r");
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (hasGroupOrOtherAccess(stats.mode)) {
      throw new InsecureSecretStoreError(
        target,
        `entry mode ${(stats.mode & 0o777).toString(8)} allows group or other access`,
      );
    }
    const raw = await handle.readFile("utf8");
    if (raw.length === 0) {
      // `SensitiveValue.from` would throw its own generic "requires a
      // non-empty value" error here, which reads as a caller programming
      // mistake. An empty entry file on disk is not a programming mistake —
      // it is a corrupt store (the file was truncated or hand-placed
      // out-of-band; the atomic write path above never produces one) — so
      // it gets its own error naming the path.
      throw new CorruptSecretStoreEntryError(target);
    }
    return SensitiveValue.from(raw);
  } finally {
    await handle.close();
  }
}

async function removeEntry(directory: string, name: string): Promise<boolean> {
  const target = entryPath(directory, name);
  try {
    await unlink(target);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function listEntries(directory: string): Promise<readonly string[]> {
  const files = await readdir(directory);
  return (
    files
      .filter((file) => file.endsWith(ENTRY_SUFFIX))
      .map((file) => file.slice(0, -ENTRY_SUFFIX.length))
      // A hand-placed file such as `.hidden.entry` would strip to a name
      // (`.hidden`) that the port's own validator rejects — `read()` would
      // then throw `SecretStoreEntryNameError` for a name `list()` just
      // handed back. Filtering through the same pattern here means `list()`
      // only ever returns names every other port method accepts.
      .filter((name) => SECRET_ENTRY_NAME_PATTERN.test(name))
      .sort()
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
