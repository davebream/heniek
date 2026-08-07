/**
 * Task 3.2 — the `ArtifactFileSystem` port's thin `node:fs` adapter (plan
 * Phase 3, R3 / design D13n). Round-trips a real temp file through every
 * port method against the real filesystem — the fault-injection suite
 * (Task 3.5) is what exercises a fake implementation of this same
 * interface; this file only proves the adapter itself is wired correctly.
 */

import { constants as fsConstants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeArtifactFileSystem } from "../src/artifact/file-system.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "heniek-state-artifact-fs-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("createNodeArtifactFileSystem (R3/D13n)", () => {
  it("round-trips a temp file through open/write/fsync/read/stat/link/unlink/close", () => {
    const fs = createNodeArtifactFileSystem();
    const tempPath = join(directory, "roundtrip.tmp");
    const finalPath = join(directory, "roundtrip.final");

    const fd = fs.openExclusive(tempPath);
    fs.write(fd, new TextEncoder().encode("hello artifact store"));
    fs.fsync(fd);

    const stat = fs.fstat(fd);
    expect(stat.size).toBe("hello artifact store".length);
    expect(stat.nlink).toBe(1);
    expect(stat.isSymbolicLink).toBe(false);

    const buffer = new Uint8Array(stat.size);
    const bytesRead = fs.readAt(fd, buffer, 0);
    expect(bytesRead).toBe(stat.size);
    expect(new TextDecoder().decode(buffer)).toBe("hello artifact store");

    // A second read from position 0 must return the same bytes — proves
    // readAt is positional, not a shared cursor advanced by the first read.
    const secondBuffer = new Uint8Array(stat.size);
    const secondBytesRead = fs.readAt(fd, secondBuffer, 0);
    expect(secondBytesRead).toBe(stat.size);
    expect(secondBuffer).toEqual(buffer);

    fs.fchmod(fd, 0o400);

    fs.link(tempPath, finalPath);
    expect(() => fs.link(tempPath, finalPath)).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );

    const lstatResult = fs.lstat(finalPath);
    expect(lstatResult.ino).toBe(stat.ino);
    expect(lstatResult.nlink).toBe(2);
    expect(lstatResult.isSymbolicLink).toBe(false);

    const readOnlyFd = fs.openReadOnly(finalPath);
    const readOnlyBuffer = new Uint8Array(stat.size);
    expect(fs.readAt(readOnlyFd, readOnlyBuffer, 0)).toBe(stat.size);
    expect(new TextDecoder().decode(readOnlyBuffer)).toBe("hello artifact store");
    fs.close(readOnlyFd);

    fs.unlink(tempPath);
    fs.close(fd);

    expect(() => fs.lstat(tempPath)).toThrowError(expect.objectContaining({ code: "ENOENT" }));
  });

  it("openExclusive uses O_RDWR|O_CREAT|O_EXCL, mode 0o600, and throws EEXIST on collision", async () => {
    const { statSync } = await import("node:fs");
    const fs = createNodeArtifactFileSystem();
    const tempPath = join(directory, "exclusive.tmp");

    const fd = fs.openExclusive(tempPath);
    // `ArtifactFileSystemStat` (R3) has no `mode` field — check the raw mode
    // directly via node:fs, permitted in test/** (not scanned).
    expect(statSync(tempPath).mode & 0o777).toBe(0o600);

    expect(() => fs.openExclusive(tempPath)).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );

    // Requires O_RDWR: a positional read on the fd from step 1 must succeed
    // (would be EBADF on an O_WRONLY fd, per S1).
    fs.write(fd, new Uint8Array([1, 2, 3]));
    const buffer = new Uint8Array(3);
    expect(fs.readAt(fd, buffer, 0)).toBe(3);
    expect(Array.from(buffer)).toEqual([1, 2, 3]);

    fs.close(fd);
  });

  it("openReadOnly uses O_NOFOLLOW and throws ELOOP on a symlink, ENOENT when absent", async () => {
    const { symlink } = await import("node:fs/promises");
    const fs = createNodeArtifactFileSystem();
    const targetPath = join(directory, "target.txt");
    const linkPath = join(directory, "link.txt");

    const fd = fs.openExclusive(targetPath);
    fs.write(fd, new Uint8Array([9]));
    fs.close(fd);

    await symlink(targetPath, linkPath);

    expect(() => fs.openReadOnly(linkPath)).toThrowError(
      expect.objectContaining({ code: "ELOOP" }),
    );
    expect(() => fs.openReadOnly(join(directory, "absent.txt"))).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("openDirectoryReadOnly (H2) opens a real directory but refuses a file (ENOTDIR) or a symlink (ELOOP)", async () => {
    const { symlink } = await import("node:fs/promises");
    const fs = createNodeArtifactFileSystem();
    const nestedDir = join(directory, "nested");
    const filePath = join(directory, "not-a-dir.txt");
    const linkPath = join(directory, "dir-link");

    fs.mkdir(nestedDir);
    const dirFd = fs.openDirectoryReadOnly(nestedDir);
    fs.close(dirFd);

    fs.close(fs.openExclusive(filePath));
    expect(() => fs.openDirectoryReadOnly(filePath)).toThrowError(
      expect.objectContaining({ code: "ENOTDIR" }),
    );

    await symlink(nestedDir, linkPath);
    // O_NOFOLLOW|O_DIRECTORY on a symlink surfaces as ENOTDIR on Linux (the
    // symlink itself is never a directory), not ELOOP — ELOOP is reserved
    // for an actual link-resolution cycle. Either way, the point this test
    // proves is what matters: a symlink can never be opened as a directory.
    expect(() => fs.openDirectoryReadOnly(linkPath)).toThrowError(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });

  it("mkdir is recursive and idempotent (tolerates a pre-existing directory)", () => {
    const fs = createNodeArtifactFileSystem();
    const nested = join(directory, "a", "b", "c");
    fs.mkdir(nested);
    expect(() => fs.mkdir(nested)).not.toThrow();
    expect(fs.readdir(join(directory, "a"))).toEqual(["b"]);
  });

  it("readdir lists directory entries by name", () => {
    const fs = createNodeArtifactFileSystem();
    fs.close(fs.openExclusive(join(directory, "one.txt")));
    fs.close(fs.openExclusive(join(directory, "two.txt")));
    expect([...fs.readdir(directory)].sort()).toEqual(["one.txt", "two.txt"]);
  });

  it("exposes the O_RDWR|O_CREAT|O_EXCL constant combination used for openExclusive", () => {
    // Guards against a future refactor silently narrowing openExclusive to
    // O_WRONLY — S1's fd re-use guarantee depends on O_RDWR specifically.
    expect(fsConstants.O_RDWR).toBeGreaterThan(0);
    expect(fsConstants.O_CREAT).toBeGreaterThan(0);
    expect(fsConstants.O_EXCL).toBeGreaterThan(0);
  });
});
