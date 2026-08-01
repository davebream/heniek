import { describe, expect, it } from "vitest";
import { createInMemorySecretStore } from "../src/memory-store.js";
import { describeSecretStoreContract } from "./contract.js";

describe("createInMemorySecretStore", () => {
  it("defaults to id memory", () => {
    const store = createInMemorySecretStore();
    expect(store.id).toBe("memory");
  });

  it("accepts a custom id", () => {
    const store = createInMemorySecretStore({ id: "test-double" });
    expect(store.id).toBe("test-double");
  });
});

// The rest of the port contract (name validation, read/remove/list/overwrite
// semantics, the `SensitiveValue` round-trip) is shared with the file
// adapter — see `describeSecretStoreContract` in `test/contract.ts` for why
// duplicating it per adapter is what let the two drift in the first place.
describeSecretStoreContract("createInMemorySecretStore", () => createInMemorySecretStore());
