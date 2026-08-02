/**
 * The design C1/C9 typed error hierarchy for the instance-claim core (plan
 * Task 2 Step 8). Every subclass carries a fixed `exitCode` — `10` for a
 * *retryable* loss (another instance is legitimately running or starting;
 * `AlreadyRunning` carries the incumbent pid, when known, for Q009's future
 * wait-and-connect) and `11` for a refusal (something is wrong enough that
 * retrying blindly is not safe). Exit `12` (recovery failure) is Task 4's
 * concern and has no class here.
 *
 * **No error carries credential material, a challenge, or a MAC** — this
 * package's standing rule. Every message names only a path already known to
 * the caller (it was either a caller-supplied option or a value this module
 * itself resolved from one) and an already-safe reason string, matching
 * `packages/secrets/src/store.ts:40-59` and `packages/state/src/errors.ts`'s
 * identical house rule.
 */

export type DaemonLifecycleExitCode = 10 | 11;

export abstract class DaemonLifecycleError extends Error {
  abstract readonly exitCode: DaemonLifecycleExitCode;
}

/**
 * exit 10 — a live daemon already owns this application home. Retryable:
 * the caller can wait and connect instead (Q009). `incumbentPid` is known
 * only when a well-formed, boot-matching `serving` record was actually
 * parsed; `undefined` in the residual-skew case (design C1 step 3's "absent
 * claim file, but the socket answers `serving`" row), where no record was
 * ever read.
 */
export class AlreadyRunning extends DaemonLifecycleError {
  override readonly exitCode = 10;
  readonly incumbentPid: number | undefined;

  constructor(incumbentPid: number | undefined) {
    super(
      incumbentPid === undefined
        ? "a daemon is already serving this application home"
        : `a daemon is already serving this application home (incumbent pid ${incumbentPid})`,
    );
    this.name = "AlreadyRunning";
    this.incumbentPid = incumbentPid;
  }
}

/**
 * exit 10 — another instance is mid-acquire: either a well-formed,
 * boot-matching `claiming` record with a live pid (the ordinary contended
 * case — the winner has not finished starting), or an unterminated record
 * (a torn write in progress) whose socket probe did not read `serving`.
 * Concede unconditionally; never take over, never signal, never remove
 * either file.
 */
export class ClaimInProgress extends DaemonLifecycleError {
  override readonly exitCode = 10;

  constructor(path: string) {
    super(`another instance is still starting up (claim in progress at ${path})`);
    this.name = "ClaimInProgress";
  }
}

/** exit 10 — this process won the claim and any reclaim, but lost the kernel-atomic `bind()` race (`EADDRINUSE`). */
export class BindRaced extends DaemonLifecycleError {
  override readonly exitCode = 10;

  constructor(path: string) {
    super(`lost the socket bind race at ${path} (EADDRINUSE)`);
    this.name = "BindRaced";
  }
}

/**
 * exit 11 — the claim file names a live, boot-matching pid, but the socket
 * at the same application home does not answer as a Heniek daemon
 * (`no-listener`/`absent`). IR-2's "alive but not a Heniek daemon" clause.
 * Nothing is signalled, nothing is removed.
 */
export class PidFileNamesLiveProcess extends DaemonLifecycleError {
  override readonly exitCode = 11;

  constructor(path: string) {
    super(
      `${path} names a live process that is not answering as a Heniek daemon — refusing to touch it`,
    );
    this.name = "PidFileNamesLiveProcess";
  }
}

/**
 * exit 11 — something is listening on the socket path but does not speak
 * the Heniek daemon protocol (`hostile`). The socket is left untouched, on
 * every path that can reach this error (won-claim, reclaim, and the
 * contended `serving`-record row alike).
 */
export class ForeignSocketOccupied extends DaemonLifecycleError {
  override readonly exitCode = 11;

  constructor(path: string) {
    super(`${path} is occupied by a process that does not speak the Heniek daemon protocol`);
    this.name = "ForeignSocketOccupied";
  }
}

/**
 * exit 11 — `runtimeDirectory` or its parent is a symlink, not a real
 * directory, owned by a different uid, or group/world-accessible (design C1
 * step 1). Nothing is created.
 */
export class InsecureRuntimeDirectory extends DaemonLifecycleError {
  override readonly exitCode = 11;

  constructor(path: string, reason: string) {
    super(`runtime directory is not private: ${path} (${reason})`);
    this.name = "InsecureRuntimeDirectory";
  }
}

/** exit 11 — the claim file itself is a symlink, not a regular file, or owned by a different uid. */
export class InsecureClaimFile extends DaemonLifecycleError {
  override readonly exitCode = 11;

  constructor(path: string, reason: string) {
    super(`claim file is not trustworthy: ${path} (${reason})`);
    this.name = "InsecureClaimFile";
  }
}

/**
 * exit 11 — a non-socket regular file, directory, or FIFO occupies
 * `daemonSocketFile` (plan-review round 1, finding m1), discovered while
 * re-verifying a candidate reclaim target before unlinking it.
 */
export class InsecureSocketPath extends DaemonLifecycleError {
  override readonly exitCode = 11;

  constructor(path: string, reason: string) {
    super(`socket path is not trustworthy: ${path} (${reason})`);
    this.name = "InsecureSocketPath";
  }
}

/** exit 11 — the bounded takeover retry (design C1 step 7) was exhausted without resolving the claim. */
export class ClaimContended extends DaemonLifecycleError {
  override readonly exitCode = 11;

  constructor(path: string) {
    super(`could not resolve the claim at ${path} within the bounded retry — contended`);
    this.name = "ClaimContended";
  }
}

/**
 * Raised by `ClaimGuard.assertStillHeld()` when the record at the claim path
 * no longer matches the identity this process holds — it was unlinked, or
 * something replaced it. Not itself exit-coded — this fires *after*
 * acquisition, during the served lifetime, and the caller (the future
 * runtime composition root) decides how to react to `onLost` (design C1
 * step 9, OR-19).
 */
export class ClaimLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimLostError";
  }
}
