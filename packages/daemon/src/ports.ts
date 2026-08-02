import type { Clock, IdGenerator } from "@heniek/state";

/**
 * `@heniek/daemon`'s port surface (design C10). Declarations only — no
 * implementation lives outside `src/runtime/**`, which is the package's
 * single determinism-gate exemption (`test/no-ambient-sources.test.ts`,
 * landing Phase 3).
 *
 * No file under `src/` outside `src/runtime/**` may contain the literal
 * specifiers for the Node networking, cryptography, and filesystem built-ins,
 * not even in an `import type` —
 * the determinism gate is a text scan, so a type-only import is textually
 * indistinguishable from a value import. Every port below is therefore
 * declared **structurally**: no built-in module type is referenced here.
 * `Clock`/`IdGenerator` are the one exception, and they are safe — they are
 * `@heniek/state`'s own ambient-free ports, re-exported rather than
 * redeclared, and `@heniek/state`'s own determinism gate already keeps them
 * free of built-in module types.
 */

export type { Clock, IdGenerator };

/** CSPRNG byte source. Implemented only by `src/runtime/random-source.ts`. */
export interface RandomSource {
  bytes(length: number): Uint8Array;
}

/**
 * A corroborating (never primary) liveness signal for a claim record's
 * `pid` (design C1 step 6, STD-6). `uid()` exists so `src/lifecycle/acquire.ts`
 * never reads `process.getuid()` directly (plan-review round 1, finding m4).
 */
export interface ProcessLiveness {
  isAlive(pid: number): boolean;
  uid(): number;
}

/**
 * A boot-scoped witness value distinguishing a claim record written during
 * *this* boot from a stale record surviving a reboot with PID reuse.
 * `undefined` means unobtainable on this platform.
 */
export interface HostWitness {
  current(): string | undefined;
}

/** Package-local stat shape — never the filesystem built-in's `Stats` type. */
export interface FileStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: number;
  readonly uid: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * An open claim-file handle retained for the process lifetime (design C1
 * step 2). The handle is never reopened and never replaced: the inode it
 * pins *is* the claim identity for the whole process lifetime.
 *
 * `writeAt` exists so publish can rewrite the fixed-width `state` field in
 * place at a known offset (design C1 step 8 / row R) instead of `rename`ing
 * a temp file over the claim, which would install a new inode and break
 * that identity permanently.
 */
export interface ClaimFileHandle {
  write(record: string): void;
  /** One positional write of `text` at `offset`, not extending the file. */
  writeAt(text: string, offset: number): void;
  /** Flush this handle's writes to stable storage. */
  sync(): void;
  stat(): FileStat;
  close(): void;
}

/**
 * The filesystem surface `src/lifecycle/acquire.ts` is pure over. Implemented
 * only by `src/runtime/lock-filesystem.ts`. Every method mirrors one POSIX
 * primitive design C1 names explicitly (`openSync(path, "wx", 0o600)`,
 * `renameSync`, `unlinkSync`, `lstatSync`, `chmodSync`).
 */
export interface LockFileSystem {
  createExclusive(path: string, mode: number): ClaimFileHandle;
  /**
   * `link(2)` — the mutual-exclusion primitive the claim is won with (design
   * C1 step 2 / plan round-2 override 2). The record is written and flushed
   * to an `O_EXCL` temp first, then linked onto the claim path: exactly one
   * racer's `link` lands and every other gets `EEXIST`, so no reader can
   * ever observe a half-written record at the claim path. Fails `EEXIST` if
   * `newPath` exists, `ENOENT` if `existingPath` does not.
   */
  link(existingPath: string, newPath: string): void;
  readFile(path: string, maxBytes: number): string;
  lstat(path: string): FileStat;
  rename(fromPath: string, toPath: string): void;
  unlink(path: string): void;
  chmod(path: string, mode: number): void;
}

/**
 * A bound listening socket. `dev`/`ino` are the **socket identity** design
 * C1 step 9 compares `assertStillHeld()` against once the socket is bound —
 * a listening socket survives `unlink` of its path, so a same-uid actor
 * could otherwise remove it and let a second daemon bind a new socket
 * there. Implemented only by `src/runtime/socket-server.ts`.
 */
export interface BoundSocket {
  readonly dev: bigint;
  readonly ino: bigint;
  close(): Promise<void>;
  onConnection(callback: (connection: unknown) => void): void;
  onClose(callback: () => void): void;
}

export interface SocketBinder {
  listen(path: string): Promise<BoundSocket>;
}

/** The four socket-liveness verdicts design C2 defines. */
export type SocketProbeVerdict = "serving" | "hostile" | "no-listener" | "absent";

export interface SocketProbe {
  probe(path: string): Promise<SocketProbeVerdict>;
}

/** One observable lifecycle-transition record (design C9, OR-19). */
export interface LifecycleTraceEvent {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly instanceId: string;
  readonly at: string;
}

export interface LifecycleTraceSink {
  emit(event: LifecycleTraceEvent): void;
}

/**
 * HMAC + constant-time comparison, isolated behind a port so
 * `src/auth/verify.ts` stays pure while the cryptography built-in is
 * quarantined to `src/runtime/mac.ts` — the resolution to the C6/C10 tension recorded in
 * the plan's Task 3 Step 8 planner note.
 */
export interface MacProvider {
  hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array;
  constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
