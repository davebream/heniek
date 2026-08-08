import { describe, expect, it, vi } from "vitest";
import { createScopedSecretReader, SecretAccessDeniedError } from "../src/scoped-reader.js";
import { SensitiveValue } from "../src/sensitive-value.js";

describe("scoped secret reader", () => {
  it("reads an allowed identifier from the backing store", async () => {
    const value = SensitiveValue.from("never-persist-this-value");
    const read = vi.fn(async () => value);
    const scoped = createScopedSecretReader({ read }, ["allowed-id"]);

    expect(await scoped.read("allowed-id")).toBe(value);
    expect(read).toHaveBeenCalledExactlyOnceWith("allowed-id");
  });

  it("rejects a disallowed identifier before touching the backing store", async () => {
    const read = vi.fn(async () => undefined);
    const scoped = createScopedSecretReader({ read }, ["allowed-id"]);

    await expect(scoped.read("denied-id")).rejects.toBeInstanceOf(SecretAccessDeniedError);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not include the rejected identifier in its error", async () => {
    const scoped = createScopedSecretReader({ read: vi.fn(async () => undefined) }, []);
    await expect(scoped.read("sensitive-name")).rejects.not.toThrow(/sensitive-name/);
  });
});
