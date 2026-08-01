import type { SensitiveValue } from "./sensitive-value.js";
import type { SecretStore } from "./store.js";
import { assertValidEntryName } from "./store.js";

export interface InMemorySecretStoreOptions {
  readonly id?: string;
}

/**
 * An in-memory `SecretStore` test double. It enforces the identical entry
 * name validation the file adapter does (`assertValidEntryName`), so a test
 * written against this double cannot pass against a laxer contract than
 * production — the port's constraints are part of the port, not an
 * implementation detail of one adapter.
 *
 * It deliberately does **not** attempt to model the file adapter's
 * permission contract (directory/entry modes, symlink/ownership checks,
 * atomic-write cleanup) — this double holds no on-disk representation at
 * all, so it has no permission surface to restrict in the first place;
 * simulating one would just be theatre. Parity between the two adapters is
 * instead proven by running the shared `describeSecretStoreContract` suite
 * (`test/contract.ts`) against both — the part of the contract that *is*
 * common to every `SecretStore`, name validation and port behaviour
 * included, not the file adapter's storage-specific hardening.
 */
export function createInMemorySecretStore(options: InMemorySecretStoreOptions = {}): SecretStore {
  const id = options.id ?? "memory";
  const entries = new Map<string, SensitiveValue>();

  return {
    id,
    async read(name) {
      assertValidEntryName(name);
      return entries.get(name);
    },
    async write(name, value) {
      assertValidEntryName(name);
      entries.set(name, value);
    },
    async remove(name) {
      assertValidEntryName(name);
      return entries.delete(name);
    },
    async list() {
      return [...entries.keys()].sort();
    },
  };
}
