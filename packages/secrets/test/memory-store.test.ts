import { describe, expect, it } from "vitest";
import { createInMemorySecretStore } from "../src/memory-store.js";
import { SensitiveValue } from "../src/sensitive-value.js";
import { SecretStoreEntryNameError } from "../src/store.js";

describe("createInMemorySecretStore", () => {
  it("defaults to id memory", () => {
    const store = createInMemorySecretStore();
    expect(store.id).toBe("memory");
  });

  it("accepts a custom id", () => {
    const store = createInMemorySecretStore({ id: "test-double" });
    expect(store.id).toBe("test-double");
  });

  it("round-trips a written value", async () => {
    const store = createInMemorySecretStore();
    await store.write("github-token", SensitiveValue.from("raw-value"));
    const value = await store.read("github-token");
    expect(value?.expose()).toBe("raw-value");
  });

  it("returns undefined for a missing entry", async () => {
    const store = createInMemorySecretStore();
    expect(await store.read("missing")).toBeUndefined();
  });

  it("overwrites an existing entry on repeated writes", async () => {
    const store = createInMemorySecretStore();
    await store.write("name", SensitiveValue.from("first"));
    await store.write("name", SensitiveValue.from("second"));
    const value = await store.read("name");
    expect(value?.expose()).toBe("second");
  });

  it("removes an existing entry and returns true", async () => {
    const store = createInMemorySecretStore();
    await store.write("name", SensitiveValue.from("value"));
    expect(await store.remove("name")).toBe(true);
    expect(await store.read("name")).toBeUndefined();
  });

  it("returns false when removing an absent entry", async () => {
    const store = createInMemorySecretStore();
    expect(await store.remove("never-existed")).toBe(false);
  });

  it("lists entry names sorted, never values", async () => {
    const store = createInMemorySecretStore();
    await store.write("zeta", SensitiveValue.from("z-value"));
    await store.write("alpha", SensitiveValue.from("a-value"));
    const names = await store.list();
    expect(names).toEqual(["alpha", "zeta"]);
  });

  it("enforces the same entry-name validation as the file adapter", async () => {
    const store = createInMemorySecretStore();
    await expect(store.write("..", SensitiveValue.from("value"))).rejects.toThrow(
      SecretStoreEntryNameError,
    );
    await expect(store.read("with space")).rejects.toThrow(SecretStoreEntryNameError);
    await expect(store.remove("a/b")).rejects.toThrow(SecretStoreEntryNameError);
  });
});
