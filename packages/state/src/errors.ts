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

/** D2 — a migration statement failed; names the migration version and the failing statement's index. */
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
