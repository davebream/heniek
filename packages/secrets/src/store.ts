import type { SensitiveValue } from "./sensitive-value.js";

/**
 * Storage port for named credential entries (§27.4). `read`/`write`/`remove`
 * operate on `SensitiveValue`s, never raw strings, so a caller cannot
 * accidentally hold a bare credential string longer than necessary. `list`
 * returns entry *names* only — a store must never be able to leak values
 * through enumeration.
 */
export interface SecretStore {
  readonly id: string;
  read(name: string): Promise<SensitiveValue | undefined>;
  write(name: string, value: SensitiveValue): Promise<void>;
  remove(name: string): Promise<boolean>;
  list(): Promise<readonly string[]>;
}

/**
 * Entry names double as filenames in the file-backed adapter, so the rule is
 * filesystem-safety-first: alphanumeric, `.`, `_`, `-` only, must start with
 * an alphanumeric character, capped at 128 characters. That first-character
 * rule already rules out a bare `.` or `..` (neither starts with an
 * alphanumeric), which is what rules out path traversal and hidden files —
 * `assertValidEntryName` below still checks for them explicitly so the
 * intent is visible at the call site and not just an accident of the regex.
 */
export const SECRET_ENTRY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Thrown by `assertValidEntryName` when a proposed entry name is not filesystem-safe. */
export class SecretStoreEntryNameError extends Error {
  constructor(readonly entryName: string) {
    super(
      `Secret entry name "${entryName}" is invalid: names must match ` +
        `${SECRET_ENTRY_NAME_PATTERN.source} and must not be "." or "..".`,
    );
    this.name = "SecretStoreEntryNameError";
  }
}

/**
 * Thrown when a secret store's backing storage cannot be made private
 * (directory or entry file readable/writable by group or other). The
 * message names the filesystem path and the reason — never a credential
 * value, since none is available at this layer to leak.
 */
export class InsecureSecretStoreError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Secret store path is not private: ${path} (${reason})`);
    this.name = "InsecureSecretStoreError";
  }
}

/** Validates `name` against `SECRET_ENTRY_NAME_PATTERN`, throwing `SecretStoreEntryNameError` on failure. */
export function assertValidEntryName(name: string): void {
  if (name === "." || name === "..") {
    throw new SecretStoreEntryNameError(name);
  }
  if (!SECRET_ENTRY_NAME_PATTERN.test(name)) {
    throw new SecretStoreEntryNameError(name);
  }
}
