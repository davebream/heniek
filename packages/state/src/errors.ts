/**
 * The `@heniek/state` error hierarchy (design D2, D7, D8, D11, D13).
 *
 * Every class below `extends StateStoreError`, so a caller that only wants
 * "did the state store reject this" can catch the base class, while a
 * caller that needs to distinguish *why* can catch the specific subclass.
 *
 * The actual house rule, matching `packages/config` and `packages/secrets`:
 * a message may echo a value the *caller supplied explicitly* to a public
 * function of this package (its own input, already known to it), but never
 * an *ambient or derived* value the package resolved on the caller's
 * behalf (an environment variable, a directory it computed, payload bytes
 * — D7's `no-credential-fields` discipline). This is why `open.ts:111`
 * interpolates `path` — the exact string `openStateDatabase`'s caller
 * passed in — into a plain `StateStoreError`, matching the identical
 * precedent at `packages/secrets/src/file-store.ts:64`
 * (`SecretStoreConfigurationError` echoing the caller-supplied
 * `options.directory`). `InsecureStateDatabaseError` follows the same rule,
 * not an exception to it — it names `path`, again because the caller
 * supplied it explicitly to `openStateDatabase`, exactly mirroring
 * `InsecureSecretStoreError`'s identical carve-out in
 * `packages/secrets/src/store.ts`. Do not "fix" `open.ts:111` into
 * inconsistency with this rule — it is already consistent.
 *
 * No property name declared here may match
 * `/password|secret|token|api[-_]?key|credential|private[-_]?key|access[-_]?key|passphrase/i`.
 */

/** Base class for every error this package throws. */
export class StateStoreError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "StateStoreError";
  }
}

/** D2.3 — the database's `PRAGMA user_version` is newer than this build's migrations know about. */
export class SchemaVersionError extends StateStoreError {
  readonly databaseVersion: number;
  readonly codeVersion: number;

  constructor(databaseVersion: number, codeVersion: number) {
    super(
      `state database schema version ${databaseVersion} is newer than this build's ` +
        `highest known migration version ${codeVersion} — refusing to open a database ` +
        "written by a newer build",
    );
    this.name = "SchemaVersionError";
    this.databaseVersion = databaseVersion;
    this.codeVersion = codeVersion;
  }
}

/**
 * D2 — a migration statement failed; names the migration version and the
 * failing statement's index. `statementIndex` is `-1` when the failure
 * happened before any statement ran (e.g. `assertAppendOnly`'s own callers,
 * or `BEGIN IMMEDIATE` itself throwing) and the migrator's own
 * `VERSION_BUMP_FAILED` sentinel (`-2`) when every statement in
 * `migration.statements` succeeded but the version-bump step (`PRAGMA
 * user_version = …` / `COMMIT`) failed — neither is a real statement index,
 * which is always in `[0, migration.statements.length)`.
 */
export class MigrationError extends StateStoreError {
  readonly version: number;
  readonly statementIndex: number;

  constructor(
    version: number,
    statementIndex: number,
    reason: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`migration ${version} failed at statement index ${statementIndex}: ${reason}`, options);
    this.name = "MigrationError";
    this.version = version;
    this.statementIndex = statementIndex;
  }
}

/** D8/D10 — a projection write's causal guard was violated (zero rows changed, stale revision, …). */
export class CausalityViolationError extends StateStoreError {
  constructor(message: string) {
    super(message);
    this.name = "CausalityViolationError";
  }
}

/**
 * D7 — an event payload exceeded the configured byte cap. Carries only the
 * event type and the measured byte length — never the payload itself.
 * Constructor argument order is `(eventType, byteLength)`, matching every
 * call site (plan Task 4.3 step 4: `new PayloadTooLargeError(input.type, bytes)`).
 */
export class PayloadTooLargeError extends StateStoreError {
  readonly eventType: string;
  readonly byteLength: number;

  constructor(eventType: string, byteLength: number) {
    super(`event payload for type "${eventType}" is ${byteLength} bytes, exceeding the cap`);
    this.name = "PayloadTooLargeError";
    this.eventType = eventType;
    this.byteLength = byteLength;
  }
}

/**
 * D13 — a symlink, ownership, or permission refusal on `state.sqlite`, one
 * of its `-wal`/`-shm` sidecars, or a directory in its path. `path` is
 * named deliberately: it is the value the caller passed to
 * `openStateDatabase`, already known to the caller, not attacker-influenced
 * ambient input — see this file's header comment.
 */
export class InsecureStateDatabaseError extends StateStoreError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`state database path is not private: ${path} (${reason})`);
    this.name = "InsecureStateDatabaseError";
    this.path = path;
  }
}

/**
 * A database file exists but is not one this package can safely operate on
 * (foreign `application_id`, or, from Phase 3 onward, a row shape a
 * table's `STRICT` constraint did not catch). Never echoes row contents.
 */
export class StateDatabaseCorruptionError extends StateStoreError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "StateDatabaseCorruptionError";
  }
}

/** D11 — the reducer encountered an event type it does not recognise, or an illegal state transition. */
export class ReducerError extends StateStoreError {
  readonly eventId: string;
  readonly eventType: string;

  constructor(eventId: string, eventType: string, reason: string) {
    super(`reducer error for event ${eventId} (type "${eventType}"): ${reason}`);
    this.name = "ReducerError";
    this.eventId = eventId;
    this.eventType = eventType;
  }
}

/**
 * Design D12n/R6 (Task 3.1) — the six artifact-store error classes. Every
 * message below names only `relativePath`/`path` (a value the artifact
 * store itself derived from the content hash or the caller's chosen name —
 * never a value an attacker or ambient environment controls) or an
 * already-safe derived integer/reason string; never artifact bytes, per
 * this file's header house rule.
 */

/**
 * The generic publication-step failure (plan Task 3.1, R4/R6). Wraps the
 * underlying `ArtifactFileSystem` error via `options.cause` — unwrapped,
 * matching `commit.ts`'s discipline for raw SQLite errors (design D9/D13n).
 * `step` is one of R4's four named durability boundaries.
 */
export class ArtifactValidationError extends StateStoreError {
  readonly relativePath: string;
  readonly step: "write" | "fsync" | "link" | "dirfsync";

  constructor(
    relativePath: string,
    step: "write" | "fsync" | "link" | "dirfsync",
    options?: { readonly cause?: unknown },
  ) {
    super(`artifact publication failed at step "${step}" for ${relativePath}`, options);
    this.name = "ArtifactValidationError";
    this.relativePath = relativePath;
    this.step = step;
  }
}

/**
 * Raised when a caller-supplied `contentHash` disagrees with the computed
 * one (design D8), or when the quarantine-and-retry digest re-check
 * (R4 step 6) itself disagrees. Carries only the two hex digests, never the
 * bytes that produced either.
 */
export class ArtifactDigestMismatchError extends StateStoreError {
  readonly expectedHash: string;
  readonly actualHash: string;

  constructor(expectedHash: string, actualHash: string) {
    super(`artifact content hash mismatch: expected ${expectedHash}, computed ${actualHash}`);
    this.name = "ArtifactDigestMismatchError";
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/**
 * Raised only if R4 step 6's quarantine-and-retry sequence fails to vacate
 * the address (e.g. the retried `link` still returns `EEXIST`). The normal
 * quarantine path (retry succeeds) raises nothing — quarantine, not
 * poisoning, is silent success from the caller's perspective.
 */
export class ArtifactQuarantinedError extends StateStoreError {
  readonly relativePath: string;

  constructor(relativePath: string) {
    super(`artifact address is quarantined and could not be vacated: ${relativePath}`);
    this.name = "ArtifactQuarantinedError";
    this.relativePath = relativePath;
  }
}

/**
 * The S2 (under-lock) or S3 (pre-lock) stage-completion assertion failure
 * (design D4, plan Task 4.2/4.3). `reason` is a short, already-safe
 * description (e.g. "nlink was 0") — never a derived byte count or path
 * component beyond `relativePath` itself.
 *
 * `options.cause` (Phase 4 fix cycle, J1) — optional, mirroring
 * `ArtifactValidationError`'s `{ cause }` pattern: `complete-stage.ts`'s S2
 * assertion calls the `ArtifactFileSystem` port directly (`fstat`/`lstat`),
 * and those raw `node:fs` `ErrnoException`s must not escape this package's
 * typed error boundary. Every existing call site that predates this option
 * (S2's semantic checks, S3's bijection check in `command/commit.ts`) simply
 * omits it — a message built purely from already-known values, no wrapped
 * cause.
 */
export class StageAssertionFailedError extends StateStoreError {
  readonly relativePath: string;
  readonly reason: string;

  constructor(relativePath: string, reason: string, options?: { readonly cause?: unknown }) {
    super(`stage artifact assertion failed for ${relativePath}: ${reason}`, options);
    this.name = "StageAssertionFailedError";
    this.relativePath = relativePath;
    this.reason = reason;
  }
}

/**
 * A recovery-sweep failure (design D5/D5a, plan Task 5.1) — unable to
 * classify or remove an `incoming/` entry. `options.cause`, mirroring
 * `StageAssertionFailedError`'s J1 pattern: `artifact/recover.ts` calls the
 * `ArtifactFileSystem` port directly (`lstat`/`unlink`/`readdir`), and a raw
 * `node:fs` `ErrnoException` from any of those must not escape this
 * package's typed error boundary either.
 */
export class ArtifactRecoveryError extends StateStoreError {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string, options?: { readonly cause?: unknown }) {
    super(`artifact recovery failed for ${path}: ${reason}`, options);
    this.name = "ArtifactRecoveryError";
    this.path = path;
    this.reason = reason;
  }
}

/** I6's per-`completeStage` artifact-count cap refusal (plan Task 4.2). */
export class ArtifactCountExceededError extends StateStoreError {
  readonly count: number;
  readonly limit: number;

  constructor(count: number, limit: number) {
    super(`artifact count ${count} exceeds the per-completeStage limit of ${limit}`);
    this.name = "ArtifactCountExceededError";
    this.count = count;
    this.limit = limit;
  }
}
