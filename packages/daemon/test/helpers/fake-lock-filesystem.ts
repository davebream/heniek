/**
 * `FakeLockFileSystem` — an in-memory `LockFileSystem` driving the claim
 * core's tests (plan Task 2 Step 1). Built *before* `acquire.ts` — design
 * `## Risks` item 3: "A plan that implements C1 before implementing that
 * fake will not be able to test the races — sequence the fake first."
 *
 * Models inode identity as `{dev, ino}` **`bigint`** (a `number` inode
 * aliases above 2^53 on XFS inode64, which is why the production adapter
 * uses `fstatSync(fd, {bigint: true})` — this fake mirrors that from day
 * one so no test can pass by accident on a `number`-inode shortcut).
 *
 * Enforces `O_EXCL` semantics on `createExclusive` (`"wx"` — never `"ax"`):
 * a second `createExclusive` at an occupied path throws `EEXIST`, never
 * silently succeeds and never appends.
 *
 * `rename` raises `ENOENT` when the source is already gone — the real
 * POSIX behaviour a raced takeover depends on — **unless**
 * `setRenameIdempotentOnMissing(true)` is toggled on for the positive
 * control the plan's Falsifiability section names (a fake that quietly
 * tolerates a missing rename source would let a real takeover race go
 * undetected).
 *
 * Exposes an interleaving hook (`setInterleaving`) so a test can run
 * caller-supplied code immediately before any named step — e.g. to
 * simulate a second racer's claim landing between this call's own
 * `EEXIST`-triggering check and its next action.
 *
 * Records every operation (`operations`) so a test can count reclaims and
 * retries, and — critically — cross-reference it against a scripted
 * `ProcessLiveness`'s own call count to assert a refusal path never reached
 * a process-liveness probe at all.
 */

export type FakeLockFileSystemStep =
  | "createExclusive"
  | "link"
  | "readFile"
  | "lstat"
  | "rename"
  | "unlink"
  | "chmod";

export type FakeLockFileSystemOutcome = "ok" | "EEXIST" | "ENOENT" | "EFBIG";

export interface FakeLockFileSystemOperation {
  readonly op: FakeLockFileSystemStep | "write" | "writeAt" | "sync" | "close";
  readonly path: string;
  readonly outcome: FakeLockFileSystemOutcome;
}

export type InterleavingHook = (step: FakeLockFileSystemStep, path: string) => void;

type EntryKind = "file" | "directory" | "socket" | "symlink";

interface FakeEntry {
  readonly kind: EntryKind;
  content: string;
  readonly dev: bigint;
  readonly ino: bigint;
  mode: number;
  readonly uid: number;
  readonly symlinkTarget?: string;
}

/** Package-local mirror of `../../src/ports.js`'s `FileStat` — duplicated rather than imported, so this helper has zero production-source coupling beyond the `LockFileSystem`/`ClaimFileHandle` shapes it implements. */
export interface FakeFileStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: number;
  readonly uid: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
}

export interface FakeClaimFileHandle {
  write(record: string): void;
  /**
   * One positional write at a byte offset, mirroring `pwrite(2)`. Refuses to
   * extend the file: a write whose end would pass the current last byte
   * raises `EFBIG` rather than growing the record. Publish rewrites the
   * fixed-width `state` field in place, so any write that would lengthen the
   * claim line is a caller bug — surfacing it here keeps that bug from
   * reaching the closed grammar as a silently over-long record.
   */
  writeAt(text: string, offset: number): void;
  /** Records the call only; the fake has no page cache to flush. */
  sync(): void;
  stat(): FakeFileStat;
  close(): void;
}

export interface FakeLockFileSystemOptions {
  /** The uid this fake reports as "the current process" (`ProcessLiveness.uid()`'s counterpart in tests). Defaults to `1000`. */
  readonly currentUid?: number;
}

function makeFsError(code: FakeLockFileSystemOutcome, path: string, op: string): Error {
  const error = new Error(`${op} ${path}: ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

function statFromEntry(entry: FakeEntry): FakeFileStat {
  return {
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    uid: entry.uid,
    isDirectory: () => entry.kind === "directory",
    isFile: () => entry.kind === "file",
    isSocket: () => entry.kind === "socket",
    isSymbolicLink: () => entry.kind === "symlink",
  };
}

export class FakeLockFileSystem {
  private readonly entries = new Map<string, FakeEntry>();
  private readonly log: FakeLockFileSystemOperation[] = [];
  private readonly currentUid: number;
  private readonly dev = 1n;
  private nextIno = 1n;
  private interleaving: InterleavingHook | undefined;
  private renameIdempotentOnMissing = false;

  constructor(options: FakeLockFileSystemOptions = {}) {
    this.currentUid = options.currentUid ?? 1000;
  }

  // ---- test setup -------------------------------------------------------

  seedDirectory(
    path: string,
    options: { readonly uid?: number; readonly mode?: number } = {},
  ): void {
    this.entries.set(path, {
      kind: "directory",
      content: "",
      dev: this.dev,
      ino: this.allocateIno(),
      mode: options.mode ?? 0o700,
      uid: options.uid ?? this.currentUid,
    });
  }

  seedSymlink(path: string, target: string, options: { readonly uid?: number } = {}): void {
    this.entries.set(path, {
      kind: "symlink",
      content: "",
      dev: this.dev,
      ino: this.allocateIno(),
      mode: 0o777,
      uid: options.uid ?? this.currentUid,
      symlinkTarget: target,
    });
  }

  seedSocket(path: string, options: { readonly uid?: number; readonly mode?: number } = {}): void {
    this.entries.set(path, {
      kind: "socket",
      content: "",
      dev: this.dev,
      ino: this.allocateIno(),
      mode: options.mode ?? 0o600,
      uid: options.uid ?? this.currentUid,
    });
  }

  seedRegularFile(
    path: string,
    content: string,
    options: { readonly uid?: number; readonly mode?: number } = {},
  ): void {
    this.entries.set(path, {
      kind: "file",
      content,
      dev: this.dev,
      ino: this.allocateIno(),
      mode: options.mode ?? 0o600,
      uid: options.uid ?? this.currentUid,
    });
  }

  setInterleaving(hook: InterleavingHook | undefined): void {
    this.interleaving = hook;
  }

  /** Positive control (plan Falsifiability, second control): a rename whose source is already gone silently succeeds instead of raising `ENOENT`. */
  setRenameIdempotentOnMissing(value: boolean): void {
    this.renameIdempotentOnMissing = value;
  }

  get operations(): readonly FakeLockFileSystemOperation[] {
    return [...this.log];
  }

  countOperations(
    op: FakeLockFileSystemOperation["op"],
    outcome?: FakeLockFileSystemOutcome,
  ): number {
    return this.log.filter(
      (entry) => entry.op === op && (outcome === undefined || entry.outcome === outcome),
    ).length;
  }

  /** A `path -> (dev, ino, mode)` snapshot for before/after "nothing mutated" assertions. */
  snapshot(): Record<
    string,
    { readonly dev: bigint; readonly ino: bigint; readonly mode: number }
  > {
    const result: Record<
      string,
      { readonly dev: bigint; readonly ino: bigint; readonly mode: number }
    > = {};
    for (const [path, entry] of this.entries) {
      result[path] = { dev: entry.dev, ino: entry.ino, mode: entry.mode };
    }
    return result;
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  // ---- LockFileSystem port ----------------------------------------------

  createExclusive(path: string, mode: number): FakeClaimFileHandle {
    this.trigger("createExclusive", path);
    if (this.entries.has(path)) {
      this.record("createExclusive", path, "EEXIST");
      throw makeFsError("EEXIST", path, "createExclusive");
    }
    const entry: FakeEntry = {
      kind: "file",
      content: "",
      dev: this.dev,
      ino: this.allocateIno(),
      mode,
      uid: this.currentUid,
    };
    this.entries.set(path, entry);
    this.record("createExclusive", path, "ok");
    return this.makeHandle(entry, path);
  }

  /**
   * Both paths end up sharing one `FakeEntry`, so they share an inode — the
   * property the claim protocol depends on: after `link`, the retained temp
   * handle's `stat()` and an `lstat` of the claim path report the same
   * `(dev, ino)`, which is exactly what `assertStillHeld()` compares.
   */
  link(existingPath: string, newPath: string): void {
    this.trigger("link", existingPath);
    const entry = this.entries.get(existingPath);
    if (entry === undefined) {
      this.record("link", existingPath, "ENOENT");
      throw makeFsError("ENOENT", existingPath, "link");
    }
    if (this.entries.has(newPath)) {
      this.record("link", newPath, "EEXIST");
      throw makeFsError("EEXIST", newPath, "link");
    }
    this.entries.set(newPath, entry);
    this.record("link", `${existingPath}->${newPath}`, "ok");
  }

  readFile(path: string, maxBytes: number): string {
    this.trigger("readFile", path);
    const entry = this.entries.get(path);
    if (entry === undefined) {
      this.record("readFile", path, "ENOENT");
      throw makeFsError("ENOENT", path, "readFile");
    }
    const size = new TextEncoder().encode(entry.content).length;
    if (size > maxBytes) {
      this.record("readFile", path, "EFBIG");
      throw makeFsError("EFBIG", path, "readFile");
    }
    this.record("readFile", path, "ok");
    return entry.content;
  }

  lstat(path: string): FakeFileStat {
    this.trigger("lstat", path);
    const entry = this.entries.get(path);
    if (entry === undefined) {
      this.record("lstat", path, "ENOENT");
      throw makeFsError("ENOENT", path, "lstat");
    }
    this.record("lstat", path, "ok");
    return statFromEntry(entry);
  }

  rename(fromPath: string, toPath: string): void {
    this.trigger("rename", fromPath);
    const entry = this.entries.get(fromPath);
    if (entry === undefined) {
      if (this.renameIdempotentOnMissing) {
        this.record("rename", `${fromPath}->${toPath}`, "ok");
        return;
      }
      this.record("rename", fromPath, "ENOENT");
      throw makeFsError("ENOENT", fromPath, "rename");
    }
    this.entries.delete(fromPath);
    this.entries.set(toPath, entry);
    this.record("rename", `${fromPath}->${toPath}`, "ok");
  }

  unlink(path: string): void {
    this.trigger("unlink", path);
    if (!this.entries.has(path)) {
      this.record("unlink", path, "ENOENT");
      throw makeFsError("ENOENT", path, "unlink");
    }
    this.entries.delete(path);
    this.record("unlink", path, "ok");
  }

  chmod(path: string, mode: number): void {
    this.trigger("chmod", path);
    const entry = this.entries.get(path);
    if (entry === undefined) {
      this.record("chmod", path, "ENOENT");
      throw makeFsError("ENOENT", path, "chmod");
    }
    entry.mode = mode;
    this.record("chmod", path, "ok");
  }

  // ---- internals ----------------------------------------------------------

  private allocateIno(): bigint {
    const ino = this.nextIno;
    this.nextIno += 1n;
    return ino;
  }

  private trigger(step: FakeLockFileSystemStep, path: string): void {
    this.interleaving?.(step, path);
  }

  private record(
    op: FakeLockFileSystemOperation["op"],
    path: string,
    outcome: FakeLockFileSystemOutcome,
  ): void {
    this.log.push({ op, path, outcome });
  }

  private makeHandle(entry: FakeEntry, path: string): FakeClaimFileHandle {
    let closed = false;
    return {
      write: (record: string): void => {
        if (closed) {
          throw new Error(`write on a closed claim handle: ${path}`);
        }
        entry.content = record;
        this.record("write", path, "ok");
      },
      writeAt: (text: string, offset: number): void => {
        if (closed) {
          throw new Error(`writeAt on a closed claim handle: ${path}`);
        }
        const encoder = new TextEncoder();
        const current = encoder.encode(entry.content);
        const patch = encoder.encode(text);
        if (offset < 0 || offset + patch.length > current.length) {
          this.record("writeAt", path, "EFBIG");
          throw makeFsError("EFBIG", path, "writeAt");
        }
        current.set(patch, offset);
        entry.content = new TextDecoder().decode(current);
        this.record("writeAt", path, "ok");
      },
      sync: (): void => {
        if (closed) {
          throw new Error(`sync on a closed claim handle: ${path}`);
        }
        this.record("sync", path, "ok");
      },
      stat: (): FakeFileStat => statFromEntry(entry),
      close: (): void => {
        closed = true;
        this.record("close", path, "ok");
      },
    };
  }
}
