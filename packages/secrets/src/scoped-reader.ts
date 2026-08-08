import type { SensitiveValue } from "./sensitive-value.js";
import type { SecretStore } from "./store.js";

export class SecretAccessDeniedError extends Error {
  constructor() {
    super("secret identifier is outside the execution permission envelope");
    this.name = "SecretAccessDeniedError";
  }
}

/** Read-only, attempt-scoped view that checks the identifier before touching the backing store. */
export interface ScopedSecretReader {
  read(name: string): Promise<SensitiveValue | undefined>;
}

export function createScopedSecretReader(
  store: Pick<SecretStore, "read">,
  allowedIdentifiers: readonly string[],
): ScopedSecretReader {
  const allowed = new Set(allowedIdentifiers);
  return Object.freeze({
    async read(name: string): Promise<SensitiveValue | undefined> {
      if (!allowed.has(name)) throw new SecretAccessDeniedError();
      return store.read(name);
    },
  });
}
