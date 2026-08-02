/**
 * The `ArtifactFileSystem` port (plan Task 3.2, R3 / design D9, D13n) — the
 * fault-injection seam for the artifact store. Production code reaches the
 * real filesystem only through `createNodeArtifactFileSystem`'s thin
 * `node:fs` adapter below; `packages/state/test/artifact-fault.test.ts`
 * (Task 3.5) arms a fake implementation of this same interface to inject
 * failures at each durability boundary. No test-only branch ships here or
 * in any caller — the adapter is a mechanical, unconditional wrapper.
 *
 * Deliberately **module-visible only** — exported from this module but not
 * re-exported from `src/index.ts`, mirroring `openStateDatabaseInternal`'s
 * package-private-by-construction discipline (`database/open.ts`).
 *
 * Error behaviour: every method throws the underlying `node:fs`
 * `ErrnoException` unchanged — no wrapping at this boundary, matching
 * `commit.ts`'s discipline for raw SQLite errors. Callers narrow by
 * `.code`; `openExclusive`'s and `link`'s `EEXIST` are the two *expected*
 * signals this port's callers branch on.
 */

import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";

export interface ArtifactFileSystemStat {
  readonly ino: number;
  readonly dev: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly isSymbolicLink: boolean;
  readonly isDirectory: boolean;
}

export interface ArtifactFileSystem {
  /** O_RDWR|O_CREAT|O_EXCL, mode 0o600 (S1). EEXIST on name collision — caller retries with a new random name. */
  openExclusive(path: string): number;
  /** O_RDONLY|O_NOFOLLOW. ENOENT if absent, ELOOP if `path` is a symlink. */
  openReadOnly(path: string): number;
  /** O_RDONLY|O_NOFOLLOW|O_DIRECTORY — for directory-fsync opens only (H2). ENOTDIR if `path` is not a directory, including a symlink (real symlinks never satisfy O_DIRECTORY). */
  openDirectoryReadOnly(path: string): number;
  /** Sequential write at the fd's current position. */
  write(fd: number, chunk: Uint8Array): void;
  /** Positional read, no shared cursor. Requires `fd` opened O_RDWR (S1) — EBADF on an O_WRONLY fd. Returns bytes read; 0 at EOF. */
  readAt(fd: number, buffer: Uint8Array, position: number): number;
  fsync(fd: number): void;
  fchmod(fd: number, mode: number): void;
  /** Hard link. EEXIST if `newPath` exists — never clobbers (D3 rejects `rename` for this). */
  link(existingPath: string, newPath: string): void;
  /** ENOENT if `path` is already absent — this port does not tolerate that itself; a best-effort caller must catch it. */
  unlink(path: string): void;
  close(fd: number): void;
  fstat(fd: number): ArtifactFileSystemStat;
  /** Never follows a symlink. ENOENT if absent. */
  lstat(path: string): ArtifactFileSystemStat;
  readdir(path: string): readonly string[];
  /** Recursive, idempotent — tolerates EEXIST. */
  mkdir(path: string): void;
}

function toArtifactFileSystemStat(stats: Stats): ArtifactFileSystemStat {
  return {
    ino: stats.ino,
    dev: stats.dev,
    nlink: stats.nlink,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    isSymbolicLink: stats.isSymbolicLink(),
    isDirectory: stats.isDirectory(),
  };
}

/** The production `ArtifactFileSystem` — a mechanical `node:fs` adapter, no branching. */
export function createNodeArtifactFileSystem(): ArtifactFileSystem {
  return {
    openExclusive(path: string): number {
      return openSync(path, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    },
    openReadOnly(path: string): number {
      return openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    },
    openDirectoryReadOnly(path: string): number {
      return openSync(
        path,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY,
      );
    },
    write(fd: number, chunk: Uint8Array): void {
      writeSync(fd, chunk);
    },
    readAt(fd: number, buffer: Uint8Array, position: number): number {
      return readSync(fd, buffer, 0, buffer.length, position);
    },
    fsync(fd: number): void {
      fsyncSync(fd);
    },
    fchmod(fd: number, mode: number): void {
      fchmodSync(fd, mode);
    },
    link(existingPath: string, newPath: string): void {
      linkSync(existingPath, newPath);
    },
    unlink(path: string): void {
      unlinkSync(path);
    },
    close(fd: number): void {
      closeSync(fd);
    },
    fstat(fd: number): ArtifactFileSystemStat {
      return toArtifactFileSystemStat(fstatSync(fd));
    },
    lstat(path: string): ArtifactFileSystemStat {
      return toArtifactFileSystemStat(lstatSync(path));
    },
    readdir(path: string): readonly string[] {
      return readdirSync(path);
    },
    mkdir(path: string): void {
      mkdirSync(path, { recursive: true });
    },
  };
}

/** Narrows an unknown thrown value to a `node:fs` `ErrnoException` with a given `code`. Shared by every module under `artifact/**`. */
export function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
