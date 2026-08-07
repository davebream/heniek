import { describe, expect, it } from "vitest";
import { SensitiveValue } from "../src/sensitive-value.js";
import { type SecretStore, SecretStoreEntryNameError } from "../src/store.js";

/**
 * The port contract every `SecretStore` adapter must satisfy, extracted so
 * it can be run once against each adapter (`createFileSecretStore`,
 * `createInMemorySecretStore`) rather than duplicated per adapter test file.
 * A duplicated pair of test files can drift — each edited when its own
 * adapter changes, never compared against the other — so a divergence in
 * "identical contract" behaviour between adapters would go unnoticed. This
 * suite is the single source of truth for the parts of the contract that
 * are common to every adapter: name validation and its exact error type,
 * read/remove/list/overwrite semantics, and the `SensitiveValue` round-trip.
 *
 * Adapter-specific behaviour — filesystem permissions, atomic-write
 * cleanup, symlink/ownership checks — has no shared meaning across adapters
 * (the in-memory double has no permission surface at all, see
 * `memory-store.ts`) and stays in that adapter's own test file.
 *
 * `factory` is called fresh for each `it()` so adapters are never shared
 * (and therefore never leak state) across cases.
 */
export function describeSecretStoreContract(name: string, factory: () => SecretStore): void {
  describe(`${name} — shared SecretStore contract`, () => {
    it("rejects an invalid entry name on write/read/remove with SecretStoreEntryNameError", async () => {
      const store = factory();
      await expect(store.write("..", SensitiveValue.from("value"))).rejects.toThrow(
        SecretStoreEntryNameError,
      );
      await expect(store.read("with space")).rejects.toThrow(SecretStoreEntryNameError);
      await expect(store.remove("a/b")).rejects.toThrow(SecretStoreEntryNameError);
    });

    it("returns undefined when reading an absent entry", async () => {
      const store = factory();
      expect(await store.read("missing")).toBeUndefined();
    });

    it("returns false removing an absent entry, true removing a present one", async () => {
      const store = factory();
      expect(await store.remove("never-existed")).toBe(false);

      await store.write("name", SensitiveValue.from("value"));
      expect(await store.remove("name")).toBe(true);
      expect(await store.remove("name")).toBe(false);
      expect(await store.read("name")).toBeUndefined();
    });

    it("lists entry names sorted, and only names — never values", async () => {
      const store = factory();
      await store.write("zeta", SensitiveValue.from("z-value"));
      await store.write("alpha", SensitiveValue.from("a-value"));

      const names = await store.list();
      expect(names).toEqual(["alpha", "zeta"]);
      for (const entryName of names) {
        expect(typeof entryName).toBe("string");
      }
    });

    it("overwrites an existing entry on repeated writes", async () => {
      const store = factory();
      await store.write("name", SensitiveValue.from("first"));
      await store.write("name", SensitiveValue.from("second"));
      const value = await store.read("name");
      expect(value?.expose()).toBe("second");
    });

    it("round-trips a written value through SensitiveValue", async () => {
      const store = factory();
      const written = SensitiveValue.from("raw-value");
      await store.write("github-token", written);

      const read = await store.read("github-token");
      expect(read).toBeInstanceOf(SensitiveValue);
      expect(read?.expose()).toBe("raw-value");
      expect(read?.equals(written)).toBe(true);
    });
  });
}
