/**
 * `acquireClaim` — the instance-claim decision function (design C1, plan
 * Task 2 Step 6). Pure over the injected `LockFileSystem`, `SocketBinder`,
 * `SocketProbe`, `ProcessLiveness`, `HostWitness`, and `RandomSource` ports:
 * no direct `process.*`, no filesystem built-in, no Node networking
 * built-in, no ambient clock, no ambient randomness, no timers. The order
 * below is the design — do not reorder.
 *
 * The forbidden primitives are named indirectly on purpose: the C10
 * determinism gate is a raw text scan with no comment stripping, so spelling
 * one out here — even to say this module does not use it — would trip the
 * gate on the very file it most needs to cover.
 *
 * Covers design C1 steps 1, 2, 3, 6, 7, 8, 9 (steps 4 "open and migrate" and
 * 5 "recover and classify" are C11/C12, wired in by a later phase's
 * composition root — this phase's `acquireClaim` returns once the socket is
 * bound and the `serving` record is published).
 */

import type {
  BoundSocket,
  ClaimFileHandle,
  FileStat,
  HostWitness,
  LifecycleTraceSink,
  LockFileSystem,
  ProcessLiveness,
  RandomSource,
  SocketBinder,
  SocketProbe,
} from "../ports.js";
import {
  CLAIM_RECORD_VERSION,
  type ClaimRecord,
  MAX_CLAIM_RECORD_BYTES,
  parseClaimRecord,
  serialiseClaimRecord,
} from "./claim-record.js";
import {
  AlreadyRunning,
  BindRaced,
  ClaimContended,
  ClaimInProgress,
  ForeignSocketOccupied,
  InsecureClaimFile,
  InsecureRuntimeDirectory,
  InsecureSocketPath,
  PidFileNamesLiveProcess,
} from "./errors.js";
import { type ClaimIdentity, createClaimGuard, type LockHandle } from "./guard.js";

/** design C1 step 7: exactly one takeover retry, then `ClaimContended`. Modelled as a two-attempt claim budget — see the loop in `acquireClaim`. */
const MAX_CLAIM_ATTEMPTS = 2;
const INSTANCE_ID_BYTES = 16;
const SCRATCH_SUFFIX_BYTES = 8;

export interface AcquireDeps {
  readonly lockFileSystem: LockFileSystem;
  readonly socketBinder: SocketBinder;
  readonly socketProbe: SocketProbe;
  readonly processLiveness: ProcessLiveness;
  readonly hostWitness: HostWitness;
  readonly randomSource: RandomSource;
  /** Accepted for API completeness with the design's C9 trace layer (Phase 6, `src/lifecycle/{state,trace}.ts`); not yet invoked from this phase's pure claim algorithm. */
  readonly traceSink: LifecycleTraceSink;
}

export interface AcquireOptions {
  readonly runtimeDirectory: string;
  readonly runtimeDirectoryParent: string;
  readonly daemonPidFile: string;
  readonly daemonSocketFile: string;
  /** This process's own pid — `acquire.ts` never reads `process.pid` itself; the composition root resolves it, exactly like the path options. */
  readonly ownPid: number;
}

export type AcquireOutcome =
  | {
      readonly kind: "acquired";
      readonly handle: LockHandle;
      readonly socket: BoundSocket;
      readonly instanceId: string;
    }
  | { readonly kind: "lost"; readonly error: AlreadyRunning | ClaimInProgress | BindRaced }
  | {
      readonly kind: "refused";
      readonly error:
        | PidFileNamesLiveProcess
        | ForeignSocketOccupied
        | InsecureRuntimeDirectory
        | InsecureClaimFile
        | InsecureSocketPath
        | ClaimContended;
    };

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomHex(source: RandomSource, length: number): string {
  const bytes = source.bytes(length);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type DirectoryCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * design C1 step 1: `runtimeDirectory` and its parent are each independently
 * `lstat`ed and required to be a real (non-symlink) directory, owned by this
 * process's uid, with no group/other access bits (mirrors
 * `packages/state/src/database/open.ts:263-290`).
 */
function verifyDirectorySecurity(deps: AcquireDeps, path: string): DirectoryCheck {
  let stat: FileStat;
  try {
    stat = deps.lockFileSystem.lstat(path);
  } catch (error) {
    return { ok: false, reason: `could not inspect ${path}: ${describeError(error)}` };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, reason: `${path} is a symlink` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: `${path} is not a directory` };
  }
  if (stat.uid !== deps.processLiveness.uid()) {
    return { ok: false, reason: `${path} is owned by uid ${stat.uid}, not the current process` };
  }
  if ((stat.mode & 0o077) !== 0) {
    return {
      ok: false,
      reason: `${path} mode ${(stat.mode & 0o777).toString(8)} allows group or other access`,
    };
  }
  return { ok: true };
}

type ClaimAttempt =
  | { readonly kind: "claimed"; readonly handle: ClaimFileHandle; readonly identity: ClaimIdentity }
  | { readonly kind: "contended" };

/**
 * design C1 step 2 (plan round-2 override 2): the claim is won by writing the
 * **complete** LF-terminated record to an `O_EXCL` temp, `fsync`ing it, then
 * `link(2)`ing that temp onto `daemonPidFile` — not by opening `daemonPidFile`
 * `"wx"` and writing into it.
 *
 * The difference matters to a reader, not to the winner. Under `"wx"` the
 * claim path exists, empty, from the instant of the open, so a racer that
 * `readFile`s between the open and the write observes a zero-length record.
 * That is indistinguishable from a torn write, so it classifies as
 * `claim-in-progress` and the racer spins. Linking a file that is already
 * complete and flushed means the claim path goes from absent to fully-formed
 * in one atomic step: no reader can ever observe a partial record there.
 *
 * `link` keeps the mutual exclusion `"wx"` provided — exactly one racer's link
 * lands, every other gets `EEXIST`, which routes to the contended path.
 *
 * The temp handle is retained as *the* claim handle and the temp path is
 * unlinked: after `link` both names denote one inode, so unlinking the temp
 * name leaves the claim path holding that inode with the handle still open on
 * it. This is what makes the retained fd's identity equal to
 * `lstat(daemonPidFile)`'s, which `assertStillHeld()` requires.
 */
function tryClaim(deps: AcquireDeps, options: AcquireOptions, instanceId: string): ClaimAttempt {
  const tempPath = `${options.runtimeDirectory}/.daemon.pid.claim.${randomHex(deps.randomSource, SCRATCH_SUFFIX_BYTES)}`;
  const handle: ClaimFileHandle = deps.lockFileSystem.createExclusive(tempPath, 0o600);

  let linked = false;
  try {
    const record: ClaimRecord = {
      recordVersion: CLAIM_RECORD_VERSION,
      state: "claiming",
      pid: options.ownPid,
      bootWitness: deps.hostWitness.current(),
      instanceId,
    };
    handle.write(serialiseClaimRecord(record));
    // Flush before publishing the name: a reader that follows the link must
    // never see bytes the writer has not committed.
    handle.sync();

    try {
      deps.lockFileSystem.link(tempPath, options.daemonPidFile);
    } catch (error) {
      if (isErrnoCode(error, "EEXIST")) {
        return { kind: "contended" };
      }
      throw error;
    }
    linked = true;

    const stat = handle.stat();
    return { kind: "claimed", handle, identity: { dev: stat.dev, ino: stat.ino } };
  } finally {
    // The temp name has served its purpose either way. On the contended and
    // error paths the handle is useless too, so close it; on the winning path
    // the handle is the caller's claim handle and stays open.
    discardQuietly(deps, tempPath);
    if (!linked) {
      handle.close();
    }
  }
}

/** Best-effort `unlink`; a leftover scratch name must never fail an acquire. */
function discardQuietly(deps: AcquireDeps, path: string): void {
  try {
    deps.lockFileSystem.unlink(path);
  } catch {
    // Nothing to do — the scratch name is inert either way.
  }
}

type ContendedInspection =
  /** The record that caused our `EEXIST` is already gone — nothing to inspect; the caller simply retries the claim. */
  | { readonly kind: "vanished" }
  /** Orphaned: witness mismatch/unobtainable, dead pid, or malformed/oversize content — the caller takes over. */
  | { readonly kind: "orphaned"; readonly witness: FileStat }
  | { readonly kind: "terminal"; readonly outcome: AcquireOutcome };

function terminal(outcome: AcquireOutcome): ContendedInspection {
  return { kind: "terminal", outcome };
}

/**
 * design C1 step 6: the contended-path classification. The closed,
 * exhaustive switch over `(state, witnessMatch, pidAlive)` is realised as an
 * if/else chain over `ClaimState`'s exactly two legal values — there is no
 * `default` branch that could route an unenumerated combination to
 * takeover; every combination this function can observe is one of the four
 * explicit branches below (witness mismatch, dead pid, `claiming`-concede,
 * `serving`-probe).
 */
async function inspectContendedClaim(
  deps: AcquireDeps,
  options: AcquireOptions,
): Promise<ContendedInspection> {
  const path = options.daemonPidFile;

  let witness: FileStat;
  try {
    witness = deps.lockFileSystem.lstat(path);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return { kind: "vanished" };
    }
    throw error;
  }

  if (witness.isSymbolicLink()) {
    return terminal({ kind: "refused", error: new InsecureClaimFile(path, "symlink") });
  }
  if (!witness.isFile()) {
    return terminal({ kind: "refused", error: new InsecureClaimFile(path, "not a regular file") });
  }
  if (witness.uid !== deps.processLiveness.uid()) {
    return terminal({
      kind: "refused",
      error: new InsecureClaimFile(path, `owned by uid ${witness.uid}, not the current process`),
    });
  }

  let content: string;
  try {
    content = deps.lockFileSystem.readFile(path, MAX_CLAIM_RECORD_BYTES);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return { kind: "vanished" };
    }
    // An oversize read (or any other read failure) is grouped with
    // "malformed content" — orphaned, takeover (design C1 step 6).
    return { kind: "orphaned", witness };
  }

  const parsed = parseClaimRecord(content);

  if (parsed.kind === "malformed") {
    return { kind: "orphaned", witness };
  }

  if (parsed.kind === "claim-in-progress") {
    const verdict = await deps.socketProbe.probe(options.daemonSocketFile);
    if (verdict === "serving") {
      return terminal({ kind: "lost", error: new AlreadyRunning(undefined) });
    }
    return terminal({ kind: "lost", error: new ClaimInProgress(path) });
  }

  const { record } = parsed;
  const localWitness = deps.hostWitness.current();
  const witnessMatches =
    record.bootWitness !== undefined &&
    localWitness !== undefined &&
    record.bootWitness === localWitness;

  if (!witnessMatches) {
    // "pid never probed" (design C1 step 6) — a boot-witness mismatch or an
    // unobtainable witness (on either side) is orphaned unconditionally,
    // without ever calling ProcessLiveness.isAlive.
    return { kind: "orphaned", witness };
  }

  if (!deps.processLiveness.isAlive(record.pid)) {
    return { kind: "orphaned", witness };
  }

  if (record.state === "claiming") {
    // The winner is still mid-startup by construction (bind is last) — the
    // ordinary contended case, not exotic. No probe needed to decide it.
    return terminal({ kind: "lost", error: new ClaimInProgress(path) });
  }

  // record.state === "serving", witness matches, pid alive.
  const verdict = await deps.socketProbe.probe(options.daemonSocketFile);
  if (verdict === "serving") {
    return terminal({ kind: "lost", error: new AlreadyRunning(record.pid) });
  }
  if (verdict === "hostile") {
    return terminal({
      kind: "refused",
      error: new ForeignSocketOccupied(options.daemonSocketFile),
    });
  }
  // "no-listener" or "absent" — nothing signalled, nothing removed.
  return terminal({ kind: "refused", error: new PidFileNamesLiveProcess(path) });
}

/**
 * design C1 step 7: re-`lstat` and abort unless the witness is unchanged
 * (the TOCTOU discipline of
 * `packages/state/src/artifact/recover.ts:182-194`), then `rename`-aside.
 * `rename` is itself the mutual-exclusion primitive: exactly one racer's
 * rename lands, every other gets `ENOENT`. Best-effort only — the caller
 * always simply retries the claim afterward, whether this succeeded, was
 * raced, or was skipped because the witness had already changed.
 */
function attemptTakeover(deps: AcquireDeps, options: AcquireOptions, witness: FileStat): void {
  let current: FileStat;
  try {
    current = deps.lockFileSystem.lstat(options.daemonPidFile);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (current.dev !== witness.dev || current.ino !== witness.ino) {
    // Someone else already acted on this exact record; do not take over a
    // file we no longer recognise.
    return;
  }

  const asidePath = `${options.runtimeDirectory}/.daemon.pid.stale.${randomHex(deps.randomSource, SCRATCH_SUFFIX_BYTES)}`;
  try {
    deps.lockFileSystem.rename(options.daemonPidFile, asidePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      // Raced — someone else's rename landed first.
      return;
    }
    throw error;
  }

  // We won the takeover race. Best-effort cleanup of the aside file — a
  // SIGKILL between here and the unlink leaves an inert
  // `.daemon.pid.stale.<hex>` orphan, swept best-effort on a future start,
  // never a poison pill.
  try {
    deps.lockFileSystem.unlink(asidePath);
  } catch {
    // Non-fatal — see above.
  }
}

/**
 * design C1 step 3: the socket is stale (`no-listener`) and we hold the
 * claim, so we are the only process that can be here — re-`lstat`, confirm
 * it is a socket owned by us, then `unlink` it. Returns a terminal outcome
 * only when the re-verification fails; `undefined` otherwise (reclaimed, or
 * already gone — either way, safe to proceed to bind).
 */
function reclaimStaleSocket(
  deps: AcquireDeps,
  options: AcquireOptions,
  guard: LockHandle,
): AcquireOutcome | undefined {
  let stat: FileStat;
  try {
    stat = deps.lockFileSystem.lstat(options.daemonSocketFile);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  if (!stat.isSocket() || stat.uid !== deps.processLiveness.uid()) {
    guard.release();
    return {
      kind: "refused",
      error: new InsecureSocketPath(options.daemonSocketFile, "not a socket this process owns"),
    };
  }
  deps.lockFileSystem.unlink(options.daemonSocketFile);
  return undefined;
}

/**
 * design C1 step 8 (plan round-2 override 3): publish rewrites the
 * fixed-width `state` field **in place, through the fd the claim is held
 * on**. It does not build a new record and it never `rename`s a new inode
 * onto `daemonPidFile`.
 *
 * A rename would install a *different* inode at the claim path, so from that
 * instant `fstat(claimFd).ino !== lstat(daemonPidFile).ino` permanently, and
 * `assertStillHeld()` — which runs on every accepted connection — would kill
 * the daemon on its first client. Re-anchoring the guard onto the new inode
 * was the previous workaround; it is strictly weaker, because between the
 * rename and the re-anchor the guard vouches for an inode the process no
 * longer holds.
 *
 * Rewriting `state` in place changes no other field and no byte count, so
 * the record stays complete and LF-terminated throughout: a concurrent
 * reader sees either `claiming` or `serving`, never a torn or truncated
 * line. `sync` then commits it.
 */
function publishServingRecord(guard: LockHandle): void {
  guard.publishState("serving");
}

async function proceedAfterClaim(
  deps: AcquireDeps,
  options: AcquireOptions,
  guard: LockHandle,
  instanceId: string,
): Promise<AcquireOutcome> {
  const verdict = await deps.socketProbe.probe(options.daemonSocketFile);

  if (verdict === "serving") {
    guard.release();
    return { kind: "lost", error: new AlreadyRunning(undefined) };
  }
  if (verdict === "hostile") {
    guard.release();
    return { kind: "refused", error: new ForeignSocketOccupied(options.daemonSocketFile) };
  }
  if (verdict === "no-listener") {
    const refusal = reclaimStaleSocket(deps, options, guard);
    if (refusal !== undefined) {
      return refusal;
    }
  }
  // verdict === "absent", or "no-listener" was successfully reclaimed.

  let socket: BoundSocket;
  try {
    socket = await deps.socketBinder.listen(options.daemonSocketFile);
  } catch (error) {
    if (isErrnoCode(error, "EADDRINUSE")) {
      guard.release();
      return { kind: "lost", error: new BindRaced(options.daemonSocketFile) };
    }
    throw error;
  }

  deps.lockFileSystem.chmod(options.daemonSocketFile, 0o600);
  publishServingRecord(guard);
  // Publish wrote in place, so the identity is unchanged by construction;
  // this re-check confirms the record survived the publish window.
  guard.assertStillHeld();

  return { kind: "acquired", handle: guard, socket, instanceId };
}

export async function acquireClaim(
  deps: AcquireDeps,
  options: AcquireOptions,
): Promise<AcquireOutcome> {
  const runtimeCheck = verifyDirectorySecurity(deps, options.runtimeDirectory);
  if (!runtimeCheck.ok) {
    return {
      kind: "refused",
      error: new InsecureRuntimeDirectory(options.runtimeDirectory, runtimeCheck.reason),
    };
  }
  const parentCheck = verifyDirectorySecurity(deps, options.runtimeDirectoryParent);
  if (!parentCheck.ok) {
    return {
      kind: "refused",
      error: new InsecureRuntimeDirectory(options.runtimeDirectoryParent, parentCheck.reason),
    };
  }

  const instanceId = randomHex(deps.randomSource, INSTANCE_ID_BYTES);

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const claimResult = tryClaim(deps, options, instanceId);
    if (claimResult.kind === "claimed") {
      const guard = createClaimGuard({
        instanceId,
        claimPath: options.daemonPidFile,
        claimHandle: claimResult.handle,
        claimIdentity: claimResult.identity,
        lockFileSystem: deps.lockFileSystem,
      });
      return proceedAfterClaim(deps, options, guard, instanceId);
    }

    const inspection = await inspectContendedClaim(deps, options);
    if (inspection.kind === "terminal") {
      return inspection.outcome;
    }
    if (inspection.kind === "vanished") {
      continue;
    }

    // inspection.kind === "orphaned"
    if (attempt === MAX_CLAIM_ATTEMPTS - 1) {
      // No attempts left to consume a freshly vacated slot — do not even
      // attempt the takeover.
      break;
    }
    attemptTakeover(deps, options, inspection.witness);
  }

  return { kind: "refused", error: new ClaimContended(options.daemonPidFile) };
}
