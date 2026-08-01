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
  /** One-shot: the next call to `method` throws `error` before any effect is applied. */
  armFaultBefore(method: FakeFsMethod, error: unknown): void;
  /** One-shot: the next call to `method` applies its normal effect, then throws `error`. */
  armFaultAfter(method: FakeFsMethod, error: unknown): void;
  setMtime(path: string, mtimeMs: number): void;
  fileExists(path: string): boolean;
  readFile(path: string): Uint8Array;
  linkCountOf(path: string): number;
}

function errno(code: string, message: string = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function createFakeArtifactFileSystem(nowMs: number = 0): FakeArtifactFileSystem {
  const inodes: Inode[] = [];
  const pathToInode = new Map<string, Inode>();
  const dirs = new Set<string>();
  const fds = new Map<number, FdEntry>();
  const calls: RecordedCall[] = [];
  const before = new Map<FakeFsMethod, unknown[]>();
  const after = new Map<FakeFsMethod, unknown[]>();
  let nextFd = 1000;
  let nextInodeId = 1;

  function record(method: FakeFsMethod, args: readonly unknown[]): void {
    calls.push({ method, args });
  }

  function maybeThrowBefore(method: FakeFsMethod): void {
    const queue = before.get(method);
    if (queue !== undefined && queue.length > 0) {
      throw queue.shift();
    }
  }

  function maybeThrowAfter(method: FakeFsMethod): void {
    const queue = after.get(method);
    if (queue !== undefined && queue.length > 0) {
      throw queue.shift();
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
    };
  }

  const fs: FakeArtifactFileSystem = {
    calls,

    openExclusive(path: string): number {
      record("openExclusive", [path]);
      maybeThrowBefore("openExclusive");
      if (pathToInode.has(path)) {
        throw errno("EEXIST", `already exists: ${path}`);
      }
      const inode: Inode = {
        id: nextInodeId,
        data: new Uint8Array(0),
        mode: 0o600,
        mtimeMs: nowMs,
        paths: new Set([path]),
      };
      nextInodeId += 1;
      inodes.push(inode);
      pathToInode.set(path, inode);
      const fd = nextFd;
      nextFd += 1;
      fds.set(fd, { inode, access: "rdwr", writePosition: 0 });
      maybeThrowAfter("openExclusive");
      return fd;
    },

    openReadOnly(path: string): number {
      record("openReadOnly", [path]);
      maybeThrowBefore("openReadOnly");
      const inode = pathToInode.get(path);
      if (inode === undefined) {
        throw errno("ENOENT", `no such file: ${path}`);
      }
      const fd = nextFd;
      nextFd += 1;
      fds.set(fd, { inode, access: "rdonly", writePosition: 0 });
      maybeThrowAfter("openReadOnly");
      return fd;
    },

    write(fd: number, chunk: Uint8Array): void {
      record("write", [fd]);
      maybeThrowBefore("write");
      const entry = fdEntry(fd);
      if (entry.access !== "rdwr") {
        throw errno("EBADF", "write on a non-writable fd");
      }
      const merged = new Uint8Array(entry.inode.data.length + chunk.length);
      merged.set(entry.inode.data, 0);
      merged.set(chunk, entry.inode.data.length);
      entry.inode.data = merged;
      entry.writePosition += chunk.length;
      maybeThrowAfter("write");
    },

    readAt(fd: number, buffer: Uint8Array, position: number): number {
      record("readAt", [fd, position]);
      maybeThrowBefore("readAt");
      const entry = fdEntry(fd);
      const remaining = entry.inode.data.length - position;
      if (remaining <= 0) {
        maybeThrowAfter("readAt");
        return 0;
      }
      const bytesToCopy = Math.min(buffer.length, remaining);
      buffer.set(entry.inode.data.subarray(position, position + bytesToCopy), 0);
      maybeThrowAfter("readAt");
      return bytesToCopy;
    },

    fsync(fd: number): void {
      record("fsync", [fd]);
      maybeThrowBefore("fsync");
      fdEntry(fd);
      maybeThrowAfter("fsync");
    },

    fchmod(fd: number, mode: number): void {
      record("fchmod", [fd, mode]);
      maybeThrowBefore("fchmod");
      const entry = fdEntry(fd);
      entry.inode.mode = mode;
      maybeThrowAfter("fchmod");
    },

    link(existingPath: string, newPath: string): void {
      record("link", [existingPath, newPath]);
      maybeThrowBefore("link");
      const inode = pathToInode.get(existingPath);
      if (inode === undefined) {
        throw errno("ENOENT", `no such file: ${existingPath}`);
      }
      if (pathToInode.has(newPath)) {
        throw errno("EEXIST", `already exists: ${newPath}`);
      }
      pathToInode.set(newPath, inode);
      inode.paths.add(newPath);
      maybeThrowAfter("link");
    },

    unlink(path: string): void {
      record("unlink", [path]);
      maybeThrowBefore("unlink");
      const inode = pathToInode.get(path);
      if (inode === undefined) {
        throw errno("ENOENT", `no such file: ${path}`);
      }
      pathToInode.delete(path);
      inode.paths.delete(path);
      maybeThrowAfter("unlink");
    },

    close(fd: number): void {
      record("close", [fd]);
      maybeThrowBefore("close");
      if (!fds.has(fd)) {
        throw errno("EBADF", `no such fd: ${fd}`);
      }
      fds.delete(fd);
      maybeThrowAfter("close");
    },

    fstat(fd: number): ArtifactFileSystemStat {
      record("fstat", [fd]);
      maybeThrowBefore("fstat");
      const entry = fdEntry(fd);
      const result = toStat(entry.inode);
      maybeThrowAfter("fstat");
      return result;
    },

    lstat(path: string): ArtifactFileSystemStat {
      record("lstat", [path]);
      maybeThrowBefore("lstat");
      const inode = pathToInode.get(path);
      if (inode === undefined) {
        throw errno("ENOENT", `no such file: ${path}`);
      }
      const result = toStat(inode);
      maybeThrowAfter("lstat");
      return result;
    },

    readdir(path: string): readonly string[] {
      record("readdir", [path]);
      maybeThrowBefore("readdir");
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
      maybeThrowAfter("readdir");
      return [...names].sort();
    },

    mkdir(path: string): void {
      record("mkdir", [path]);
      maybeThrowBefore("mkdir");
      dirs.add(path);
      maybeThrowAfter("mkdir");
    },

    armFaultBefore(method: FakeFsMethod, error: unknown): void {
      const queue = before.get(method) ?? [];
      queue.push(error);
      before.set(method, queue);
    },

    armFaultAfter(method: FakeFsMethod, error: unknown): void {
      const queue = after.get(method) ?? [];
      queue.push(error);
      after.set(method, queue);
    },

    setMtime(path: string, mtimeMs: number): void {
      const inode = pathToInode.get(path);
      if (inode === undefined) {
        throw errno("ENOENT", `no such file: ${path}`);
      }
      inode.mtimeMs = mtimeMs;
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
  };

  return fs;
}

/** Joins path segments with `node:path`'s `join` — re-exported so tests never need a second import for it. */
export function joinPath(...segments: string[]): string {
  return join(...segments);
}
