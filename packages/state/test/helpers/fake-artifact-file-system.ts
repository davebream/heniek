/**
 * An in-memory, fault-injectable `ArtifactFileSystem` (plan Tasks 3.3/3.4/3.5).
 * Never imported from `src/` — `test/**` is not scanned for ambient
 * non-determinism (`no-ambient-sources.test.ts`), and this file has no
 * wall-clock or random source of its own: every timestamp is caller-supplied
 * via `setMtime`/the `mtimeMs` passed to `createFakeArtifactFileSystem`.
 *
 * Models enough POSIX semantics for the publish/store/recovery paths:
 * `link` creates a second name for the same inode (content-addressed
 * dedup), `unlink` removes one name, and `nlink` is the live name count —
 * exactly the S2 (`nlink >= 1`) semantics R4/D14n depend on.
 *
 * H3 (post-Phase-3 adversarial review): the fake used to be strictly more
 * permissive than the real filesystem, which made every test built on it
 * optimistic. It now models: `readdir` on an untracked directory throwing
 * `ENOENT` (not `[]`); `mkdir` throwing when a *file* already occupies the
 * target path; `unlink` throwing `EISDIR` on a directory path instead of
 * `ENOENT`; a plantable symlink (`plantSymlink`) so `isSymbolicLink` is no
 * longer hard-coded `false` and symlink discipline is falsifiable
 * (`openReadOnly` throws `ELOOP` on one, `openDirectoryReadOnly` throws
 * `ENOTDIR` on one — matching real `O_NOFOLLOW`/`O_NOFOLLOW|O_DIRECTORY`
 * behaviour respectively; `mkdir` treats one as already-existing exactly as
 * real recursive `mkdir` does);
 * and `mtimeMs` no longer frozen at `openExclusive` time — `write` bumps it
 * to the fake's current time (advance via `setNow`). `link`/`EEXIST`/`nlink`
 * accounting and `fsync`-as-recorded-no-op were already faithful and are
 * unchanged.
 */

import { join } from "node:path";
import type { ArtifactFileSystem, ArtifactFileSystemStat } from "../../src/artifact/file-system.js";

interface Inode {
  readonly id: number;
  data: Uint8Array;
  mode: number;
  mtimeMs: number;
  readonly paths: Set<string>;
}

interface FdEntry {
  readonly inode: Inode;
  readonly access: "rdwr" | "rdonly";
  writePosition: number;
}

export type FakeFsMethod = keyof ArtifactFileSystem;

export interface RecordedCall {
  readonly method: FakeFsMethod;
  readonly args: readonly unknown[];
}

export interface FakeArtifactFileSystem extends ArtifactFileSystem {
  readonly calls: readonly RecordedCall[];
  /**
   * Arms the *next not-yet-armed* call to `method` (1-indexed occurrence
   * count, auto-advancing per call to this function) to throw `error`
   * before any effect is applied.
   */
  armFaultBefore(method: FakeFsMethod, error: unknown): void;
  /** Same as `armFaultBefore`, but the call's normal effect is applied first, then `error` is thrown. */
  armFaultAfter(method: FakeFsMethod, error: unknown): void;
  /** Precisely targets the Nth (1-indexed) invocation of `method` — needed when a single `publishArtifact` call invokes the same method more than once (e.g. the quarantine-and-retry `link` sequence) and a generic "next call" arm would hit the wrong occurrence. */
  armFaultAtOccurrence(
    method: FakeFsMethod,
    occurrence: number,
    timing: "before" | "after",
    error: unknown,
  ): void;
  setMtime(path: string, mtimeMs: number): void;
  /** Advances the fake's internal "now" (H3) — `write` stamps `mtimeMs` with this value on every call, mirroring a real filesystem bumping mtime on write. */
  setNow(nowMs: number): void;
  fileExists(path: string): boolean;
  readFile(path: string): Uint8Array;
  linkCountOf(path: string): number;
  /** Overwrites the bytes stored at `path` in place — models a committed blob whose bytes no longer hash to its own address (corruption, not a race). */
  corruptFile(path: string, data: Uint8Array): void;
  /** H2/H3 test support: plants a symlink at `path` (no real target resolution — `isSymbolicLink` reads true and open* throw `ELOOP`, mirroring `O_NOFOLLOW`). */
  plantSymlink(path: string): void;
}

function errno(code: string, message: string = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function createFakeArtifactFileSystem(nowMs: number = 0): FakeArtifactFileSystem {
  const inodes: Inode[] = [];
  const pathToInode = new Map<string, Inode>();
  const dirs = new Set<string>();
  /** mtime for each tracked directory (H3 — `lstat` on a directory path is now supported). */
  const dirMtimes = new Map<string, number>();
  /** Lazily-created pseudo-inodes for directories, opened read-only purely to `fsync` them (R4 step 7/dirfsync). */
  const dirInodes = new Map<string, Inode>();
  /** Plantable symlinks (H2/H3) — no real target resolution, just an `isSymbolicLink` marker. */
  const symlinks = new Set<string>();
  const fds = new Map<number, FdEntry>();
  const calls: RecordedCall[] = [];
  /** The fake's current time (H3) — advances only via `setNow`, never a real clock read. */
  let currentTime = nowMs;
  /** occurrence count so far, per method — incremented once per call, before any fault check. */
  const occurrenceCounts = new Map<FakeFsMethod, number>();
  /** occurrence (1-indexed) -> armed fault, per method. */
  const armedBefore = new Map<FakeFsMethod, Map<number, unknown>>();
  const armedAfter = new Map<FakeFsMethod, Map<number, unknown>>();
  /** next occurrence the auto-advancing `armFaultBefore`/`armFaultAfter` convenience methods will target, per method. */
  const nextAutoArmOccurrence = new Map<FakeFsMethod, number>();
  let nextFd = 1000;
  let nextInodeId = 1;

  function nextOccurrence(method: FakeFsMethod): number {
    const occurrence = (occurrenceCounts.get(method) ?? 0) + 1;
    occurrenceCounts.set(method, occurrence);
    return occurrence;
  }

  function record(method: FakeFsMethod, args: readonly unknown[]): void {
    calls.push({ method, args });
  }

  function maybeThrowBefore(method: FakeFsMethod, occurrence: number): void {
    const armed = armedBefore.get(method);
    if (armed?.has(occurrence) === true) {
      const error = armed.get(occurrence);
      armed.delete(occurrence);
      throw error;
    }
  }

  function maybeThrowAfter(method: FakeFsMethod, occurrence: number): void {
    const armed = armedAfter.get(method);
    if (armed?.has(occurrence) === true) {
      const error = armed.get(occurrence);
      armed.delete(occurrence);
      throw error;
    }
  }

  function fdEntry(fd: number): FdEntry {
    const entry = fds.get(fd);
    if (entry === undefined) {
      throw errno("EBADF", `no such fd: ${fd}`);
    }
    return entry;
  }

  function toStat(inode: Inode): ArtifactFileSystemStat {
    return {
      ino: inode.id,
      dev: 1,
      nlink: inode.paths.size,
      size: inode.data.length,
      mtimeMs: inode.mtimeMs,
      isSymbolicLink: false,
      isDirectory: false,
    };
  }

  function toDirStat(path: string): ArtifactFileSystemStat {
    return {
      ino: -1,
      dev: 1,
      nlink: 1,
      size: 0,
      mtimeMs: dirMtimes.get(path) ?? currentTime,
      isSymbolicLink: false,
      isDirectory: true,
    };
  }

  function toSymlinkStat(): ArtifactFileSystemStat {
    return {
      ino: -1,
      dev: 1,
      nlink: 1,
      size: 0,
      mtimeMs: currentTime,
      isSymbolicLink: true,
      isDirectory: false,
    };
  }

  const fs: FakeArtifactFileSystem = {
    calls,

    openExclusive(path: string): number {
      record("openExclusive", [path]);
      const occurrence = nextOccurrence("openExclusive");
      maybeThrowBefore("openExclusive", occurrence);
      if (pathToInode.has(path) || symlinks.has(path)) {
        throw errno("EEXIST", `already exists: ${path}`);
      }
      const inode: Inode = {
        id: nextInodeId,
        data: new Uint8Array(0),
        mode: 0o600,
        mtimeMs: currentTime,
        paths: new Set([path]),
      };
      nextInodeId += 1;
      inodes.push(inode);
      pathToInode.set(path, inode);
      const fd = nextFd;
      nextFd += 1;
      fds.set(fd, { inode, access: "rdwr", writePosition: 0 });
      maybeThrowAfter("openExclusive", occurrence);
      return fd;
    },

    openReadOnly(path: string): number {
      record("openReadOnly", [path]);
      const occurrence = nextOccurrence("openReadOnly");
      maybeThrowBefore("openReadOnly", occurrence);
      if (symlinks.has(path)) {
        throw errno("ELOOP", `too many levels of symbolic links: ${path}`);
      }
      let inode = pathToInode.get(path);
      if (inode === undefined && dirs.has(path)) {
        inode = dirInodes.get(path);
        if (inode === undefined) {
          inode = {
            id: nextInodeId,
            data: new Uint8Array(0),
            mode: 0o700,
            mtimeMs: currentTime,
            paths: new Set([path]),
          };
          nextInodeId += 1;
          dirInodes.set(path, inode);
        }
      }
      if (inode === undefined) {
        throw errno("ENOENT", `no such file: ${path}`);
      }
      const fd = nextFd;
      nextFd += 1;
      fds.set(fd, { inode, access: "rdonly", writePosition: 0 });
      maybeThrowAfter("openReadOnly", occurrence);
      return fd;
    },

    openDirectoryReadOnly(path: string): number {
      record("openDirectoryReadOnly", [path]);
      const occurrence = nextOccurrence("openDirectoryReadOnly");
      maybeThrowBefore("openDirectoryReadOnly", occurrence);
      // Real O_NOFOLLOW|O_DIRECTORY surfaces ENOTDIR on a symlink, not
      // ELOOP — ELOOP is reserved for a real resolution cycle, which this
      // fake never models. Verified against the real node:fs adapter in
      // artifact-file-system.test.ts.
      if (symlinks.has(path)) {
        throw errno("ENOTDIR", `not a directory (symlink): ${path}`);
      }
      if (!dirs.has(path)) {
        throw errno(
          pathToInode.has(path) ? "ENOTDIR" : "ENOENT",
          `not a directory or absent: ${path}`,
        );
      }
      let inode = dirInodes.get(path);
      if (inode === undefined) {
        inode = {
          id: nextInodeId,
          data: new Uint8Array(0),
          mode: 0o700,
          mtimeMs: currentTime,
          paths: new Set([path]),
        };
        nextInodeId += 1;
        dirInodes.set(path, inode);
      }
      const fd = nextFd;
      nextFd += 1;
      fds.set(fd, { inode, access: "rdonly", writePosition: 0 });
      maybeThrowAfter("openDirectoryReadOnly", occurrence);
      return fd;
    },

    write(fd: number, chunk: Uint8Array): void {
      record("write", [fd]);
      const occurrence = nextOccurrence("write");
      maybeThrowBefore("write", occurrence);
      const entry = fdEntry(fd);
      if (entry.access !== "rdwr") {
        throw errno("EBADF", "write on a non-writable fd");
      }
      const merged = new Uint8Array(entry.inode.data.length + chunk.length);
      merged.set(entry.inode.data, 0);
      merged.set(chunk, entry.inode.data.length);
      entry.inode.data = merged;
      entry.writePosition += chunk.length;
      // H3: a real write bumps mtime — the fake used to freeze mtimeMs at
      // openExclusive time forever, which made a "write happened recently"
      // assertion unfalsifiable.
      entry.inode.mtimeMs = currentTime;
      maybeThrowAfter("write", occurrence);
    },

    readAt(fd: number, buffer: Uint8Array, position: number): number {
      record("readAt", [fd, position]);
      const occurrence = nextOccurrence("readAt");
      maybeThrowBefore("readAt", occurrence);
      const entry = fdEntry(fd);
      const remaining = entry.inode.data.length - position;
      if (remaining <= 0) {
        maybeThrowAfter("readAt", occurrence);
        return 0;
      }
      const bytesToCopy = Math.min(buffer.length, remaining);
      buffer.set(entry.inode.data.subarray(position, position + bytesToCopy), 0);
      maybeThrowAfter("readAt", occurrence);
      return bytesToCopy;
    },

    fsync(fd: number): void {
      record("fsync", [fd]);
      const occurrence = nextOccurrence("fsync");
      maybeThrowBefore("fsync", occurrence);
      fdEntry(fd);
      maybeThrowAfter("fsync", occurrence);
    },

    fchmod(fd: number, mode: number): void {
      record("fchmod", [fd, mode]);
      const occurrence = nextOccurrence("fchmod");
      maybeThrowBefore("fchmod", occurrence);
      const entry = fdEntry(fd);
      entry.inode.mode = mode;
      maybeThrowAfter("fchmod", occurrence);
    },

    link(existingPath: string, newPath: string): void {
      record("link", [existingPath, newPath]);
      const occurrence = nextOccurrence("link");
      maybeThrowBefore("link", occurrence);
      const inode = pathToInode.get(existingPath);
      if (inode === undefined) {
        throw errno("ENOENT", `no such file: ${existingPath}`);
      }
      if (pathToInode.has(newPath)) {
        throw errno("EEXIST", `already exists: ${newPath}`);
      }
      pathToInode.set(newPath, inode);
      inode.paths.add(newPath);
      maybeThrowAfter("link", occurrence);
    },

    unlink(path: string): void {
      record("unlink", [path]);
      const occurrence = nextOccurrence("unlink");
      maybeThrowBefore("unlink", occurrence);
      const inode = pathToInode.get(path);
      if (inode === undefined) {
        // H3: a real unlink(2) on a directory fails EISDIR, not ENOENT.
        if (dirs.has(path)) {
          throw errno("EISDIR", `is a directory: ${path}`);
        }
        throw errno("ENOENT", `no such file: ${path}`);
      }
      pathToInode.delete(path);
      inode.paths.delete(path);
      maybeThrowAfter("unlink", occurrence);
    },

    close(fd: number): void {
      record("close", [fd]);
      const occurrence = nextOccurrence("close");
      maybeThrowBefore("close", occurrence);
      if (!fds.has(fd)) {
        throw errno("EBADF", `no such fd: ${fd}`);
      }
      fds.delete(fd);
      maybeThrowAfter("close", occurrence);
    },

    fstat(fd: number): ArtifactFileSystemStat {
      record("fstat", [fd]);
      const occurrence = nextOccurrence("fstat");
      maybeThrowBefore("fstat", occurrence);
      const entry = fdEntry(fd);
      const result = toStat(entry.inode);
      maybeThrowAfter("fstat", occurrence);
      return result;
    },

    lstat(path: string): ArtifactFileSystemStat {
      record("lstat", [path]);
      const occurrence = nextOccurrence("lstat");
      maybeThrowBefore("lstat", occurrence);
      // H2/H3: lstat never follows — a planted symlink reads as a symlink
      // regardless of what (if anything) is registered at its target.
      if (symlinks.has(path)) {
        const result = toSymlinkStat();
        maybeThrowAfter("lstat", occurrence);
        return result;
      }
      const inode = pathToInode.get(path);
      if (inode !== undefined) {
        const result = toStat(inode);
        maybeThrowAfter("lstat", occurrence);
        return result;
      }
      if (dirs.has(path)) {
        // H3: lstat on a tracked directory is now supported (needed by H2's
        // container symlink/type discipline check in store.ts).
        const result = toDirStat(path);
        maybeThrowAfter("lstat", occurrence);
        return result;
      }
      throw errno("ENOENT", `no such file: ${path}`);
    },

    readdir(path: string): readonly string[] {
      record("readdir", [path]);
      const readdirOccurrence = nextOccurrence("readdir");
      maybeThrowBefore("readdir", readdirOccurrence);
      // H3: readdir on an untracked directory throws ENOENT — the fake used
      // to return `[]`, which made the real adapter's ENOENT branch dead
      // code under test.
      if (!dirs.has(path)) {
        throw errno("ENOENT", `no such directory: ${path}`);
      }
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const candidate of pathToInode.keys()) {
        if (candidate.startsWith(prefix)) {
          const rest = candidate.slice(prefix.length);
          const first = rest.split("/")[0];
          if (first !== undefined && first.length > 0) {
            names.add(first);
          }
        }
      }
      maybeThrowAfter("readdir", readdirOccurrence);
      return [...names].sort();
    },

    mkdir(path: string): void {
      record("mkdir", [path]);
      const occurrence = nextOccurrence("mkdir");
      maybeThrowBefore("mkdir", occurrence);
      // H3: mkdir is no longer unconditionally successful — a *file*
      // already occupying the target path is a real EEXIST, mirroring
      // Node's recursive mkdirSync. A planted symlink or an already-tracked
      // directory is treated as "already there" (real recursive mkdir
      // resolves the symlink and finds a directory) — deliberately staying
      // silent here so store.ts's follow-up `lstat`-based discipline (H2)
      // is what actually catches the symlink case, exactly as the real
      // adapter behaves.
      if (pathToInode.has(path)) {
        throw errno("EEXIST", `already exists as a file: ${path}`);
      }
      dirs.add(path);
      if (!dirMtimes.has(path)) {
        dirMtimes.set(path, currentTime);
      }
      maybeThrowAfter("mkdir", occurrence);
    },

    armFaultBefore(method: FakeFsMethod, error: unknown): void {
      const occurrence = nextAutoArmOccurrence.get(method) ?? 1;
      nextAutoArmOccurrence.set(method, occurrence + 1);
      const armed = armedBefore.get(method) ?? new Map<number, unknown>();
      armed.set(occurrence, error);
      armedBefore.set(method, armed);
    },

    armFaultAfter(method: FakeFsMethod, error: unknown): void {
      const occurrence = nextAutoArmOccurrence.get(method) ?? 1;
      nextAutoArmOccurrence.set(method, occurrence + 1);
      const armed = armedAfter.get(method) ?? new Map<number, unknown>();
      armed.set(occurrence, error);
      armedAfter.set(method, armed);
    },

    armFaultAtOccurrence(
      method: FakeFsMethod,
      occurrence: number,
      timing: "before" | "after",
      error: unknown,
    ): void {
      const target = timing === "before" ? armedBefore : armedAfter;
      const armed = target.get(method) ?? new Map<number, unknown>();
      armed.set(occurrence, error);
      target.set(method, armed);
    },

    setMtime(path: string, mtimeMs: number): void {
      const inode = pathToInode.get(path);
      if (inode === undefined) {
        throw errno("ENOENT", `no such file: ${path}`);
      }
      inode.mtimeMs = mtimeMs;
    },

    setNow(nowMsValue: number): void {
      currentTime = nowMsValue;
    },

    plantSymlink(path: string): void {
      symlinks.add(path);
    },

    fileExists(path: string): boolean {
      return pathToInode.has(path);
    },

    readFile(path: string): Uint8Array {
      const inode = pathToInode.get(path);
      if (inode === undefined) {
        throw errno("ENOENT", `no such file: ${path}`);
      }
      return inode.data;
    },

    linkCountOf(path: string): number {
      const inode = pathToInode.get(path);
      if (inode === undefined) {
        throw errno("ENOENT", `no such file: ${path}`);
      }
      return inode.paths.size;
    },

    corruptFile(path: string, data: Uint8Array): void {
      const inode = pathToInode.get(path);
      if (inode === undefined) {
        throw errno("ENOENT", `no such file: ${path}`);
      }
      inode.data = data;
    },
  };

  return fs;
}

/** Joins path segments with `node:path`'s `join` — re-exported so tests never need a second import for it. */
export function joinPath(...segments: string[]): string {
  return join(...segments);
}
