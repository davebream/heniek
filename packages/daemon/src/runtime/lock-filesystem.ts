/**
 * The real `LockFileSystem`/`ClaimFileHandle` adapter (design C1, plan Task
 * 5 Step 8) — a mechanical `node:fs` wrapper mirroring
 * `packages/state/src/artifact/file-system.ts`'s
 * `createNodeArtifactFileSystem` discipline: every method is a thin,
 * unbranching call onto the matching POSIX primitive, and every thrown
 * error is the underlying `node:fs` `ErrnoException` unchanged, so callers
 * narrow by `.code` exactly as `acquire.ts` already does against the fake.
 *
 * Inode identity is **`bigint`** throughout (`fstatSync`/`lstatSync` called
 * with `{bigint: true}`) — a `number` inode aliases above 2^53 on XFS
 * inode64, which is exactly the failure mode `guard.ts`'s
 * `assertStillHeld()` exists to catch, so a lossy inode representation
 * would silently defeat it.
 *
 * `createExclusive` opens with `"wx"`, **never `"ax"`** (`"ax"` implies
 * `O_APPEND`, STD-4, and would let a second writer's bytes interleave with
 * the first's instead of failing `EEXIST`).
 *
 * `readFile`'s byte cap is enforced by `fstatSync` on the **open fd**,
 * before a single byte is read (design C1 step 6) — never by reading the
 * whole file and checking its length afterward, which would have already
 * paid the cost an oversize file is trying to impose.
 */

import {
  type BigIntStats,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  fstatSync as nodeFstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  chmodSync as writeChmodSync,
  writeSync,
} from "node:fs";
import type { ClaimFileHandle, FileStat, LockFileSystem } from "../ports.js";

function makeFsError(code: string, path: string, op: string): Error {
  const error = new Error(`${op} ${path}: ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

function toFileStat(stats: BigIntStats): FileStat {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: Number(stats.mode),
    uid: Number(stats.uid),
    isDirectory: () => stats.isDirectory(),
    isFile: () => stats.isFile(),
    isSocket: () => stats.isSocket(),
    isSymbolicLink: () => stats.isSymbolicLink(),
  };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function createFileHandle(fd: number, path: string): ClaimFileHandle {
  let closed = false;

  function assertOpen(op: string): void {
    if (closed) {
      throw new Error(`${op} on a closed claim handle: ${path}`);
    }
  }

  return {
    write(record: string): void {
      assertOpen("write");
      const bytes = textEncoder.encode(record);
      writeSync(fd, bytes, 0, bytes.length, 0);
    },

    writeAt(text: string, offset: number): void {
      assertOpen("writeAt");
      const patch = textEncoder.encode(text);
      const current = nodeFstatSync(fd, { bigint: true });
      if (offset < 0 || BigInt(offset) + BigInt(patch.length) > current.size) {
        // Publish rewrites a fixed-width field in place; a write that would
        // extend the file is a caller bug, not a legitimate positional
        // update — surfaced the same way the fake in-memory handle surfaces
        // it, so a real-vs-fake test divergence cannot hide this class of
        // bug (plan Task 5, `test/helpers/fake-lock-filesystem.ts` parity).
        throw makeFsError("EFBIG", path, "writeAt");
      }
      writeSync(fd, patch, 0, patch.length, offset);
    },

    sync(): void {
      assertOpen("sync");
      fsyncSync(fd);
    },

    stat(): FileStat {
      return toFileStat(nodeFstatSync(fd, { bigint: true }));
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      closeSync(fd);
    },
  };
}

export function createNodeLockFileSystem(): LockFileSystem {
  return {
    createExclusive(path: string, mode: number): ClaimFileHandle {
      const fd = openSync(path, "wx", mode);
      return createFileHandle(fd, path);
    },

    link(existingPath: string, newPath: string): void {
      linkSync(existingPath, newPath);
    },

    readFile(path: string, maxBytes: number): string {
      const fd = openSync(path, "r");
      try {
        const stat = nodeFstatSync(fd, { bigint: true });
        if (stat.size > BigInt(maxBytes)) {
          throw makeFsError("EFBIG", path, "readFile");
        }
        const size = Number(stat.size);
        const buffer = new Uint8Array(size);
        let readTotal = 0;
        while (readTotal < size) {
          const bytesRead = readSync(fd, buffer, readTotal, size - readTotal, readTotal);
          if (bytesRead === 0) {
            break;
          }
          readTotal += bytesRead;
        }
        return textDecoder.decode(buffer.subarray(0, readTotal));
      } finally {
        closeSync(fd);
      }
    },

    lstat(path: string): FileStat {
      return toFileStat(lstatSync(path, { bigint: true }));
    },

    rename(fromPath: string, toPath: string): void {
      renameSync(fromPath, toPath);
    },

    unlink(path: string): void {
      unlinkSync(path);
    },

    chmod(path: string, mode: number): void {
      writeChmodSync(path, mode);
    },
  };
}
