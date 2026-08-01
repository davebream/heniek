import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SensitiveValue } from "./sensitive-value.js";
import { assertValidEntryName, InsecureSecretStoreError, type SecretStore } from "./store.js";

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
 *  - the directory is created `0o700` and re-`chmod`ed back to `0o700` if a
 *    permissive umask left group/other bits set; a directory that still
 *    cannot be made private throws `InsecureSecretStoreError` rather than
 *    silently storing credentials somewhere readable;
 *  - entries are named `<name>.entry`, one per credential;
 *  - writes go to a same-directory temp file opened with `wx` (exclusive
 *    create — never overwrites another writer's in-flight temp file) and
 *    mode `0o600`, are `fsync`ed, then atomically `rename`d over the real
 *    target, so a crash mid-write never leaves a partial or world-readable
 *    credential;
 *  - reads re-check the entry's mode on every call and refuse a
 *    group/other-readable file, so an entry widened out-of-band (a `chmod`
 *    run by something else) is caught the next time it is read, not just at
 *    directory-creation time.
 */
export function createFileSecretStore(options: FileSecretStoreOptions): SecretStore {
  const directory = resolve(options.directory);
  let ready: Promise<void> | undefined;

  function ensureReady(): Promise<void> {
    ready ??= prepareDirectory(directory);
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

  const stats = await stat(directory);
  if (!hasGroupOrOtherAccess(stats.mode)) {
    return;
  }

  // `mkdir`'s `mode` option is subject to the process umask, so a
  // permissive umask can leave group/other bits set even after requesting
  // `0o700`. Repair once, then verify — a filesystem that refuses the
  // `chmod` (some network mounts do) must fail loudly rather than silently
  // storing credentials in a world-readable directory.
  await chmod(directory, DIRECTORY_MODE);
  const repaired = await stat(directory);
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

  const handle = await open(temp, "wx", ENTRY_MODE);
  try {
    await handle.writeFile(value.expose(), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temp, target);
  } catch (error) {
    // The temp file was never meant to survive — clean it up before
    // propagating so a failed rename does not also leak a stray credential
    // file with a permanent-looking name.
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function readEntry(directory: string, name: string): Promise<SensitiveValue | undefined> {
  const target = entryPath(directory, name);

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(target);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }

  if (hasGroupOrOtherAccess(stats.mode)) {
    throw new InsecureSecretStoreError(
      target,
      `entry mode ${(stats.mode & 0o777).toString(8)} allows group or other access`,
    );
  }

  const raw = await readFile(target, "utf8");
  return SensitiveValue.from(raw);
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
  return files
    .filter((file) => file.endsWith(ENTRY_SUFFIX))
    .map((file) => file.slice(0, -ENTRY_SUFFIX.length))
    .sort();
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
