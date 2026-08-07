import { describe, expect, it } from "vitest";
import {
  assertValidEntryName,
  SECRET_ENTRY_NAME_PATTERN,
  SecretStoreEntryNameError,
} from "../src/store.js";

describe("assertValidEntryName", () => {
  it.each([
    "github",
    "github-token",
    "github_token",
    "github.token",
    "a",
    "A1",
    "9-name",
    "a".repeat(128),
  ])("accepts valid entry name %s", (name) => {
    expect(() => assertValidEntryName(name)).not.toThrow();
    expect(SECRET_ENTRY_NAME_PATTERN.test(name)).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(() => assertValidEntryName("")).toThrow(SecretStoreEntryNameError);
  });

  it("rejects a single dot", () => {
    expect(() => assertValidEntryName(".")).toThrow(SecretStoreEntryNameError);
  });

  it("rejects a double dot (path traversal)", () => {
    expect(() => assertValidEntryName("..")).toThrow(SecretStoreEntryNameError);
  });

  it("rejects a name starting with a dot", () => {
    expect(() => assertValidEntryName(".hidden")).toThrow(SecretStoreEntryNameError);
  });

  it("rejects a name containing a path separator", () => {
    expect(() => assertValidEntryName("a/b")).toThrow(SecretStoreEntryNameError);
    expect(() => assertValidEntryName("../escape")).toThrow(SecretStoreEntryNameError);
  });

  it("rejects a name containing whitespace", () => {
    expect(() => assertValidEntryName("with space")).toThrow(SecretStoreEntryNameError);
  });

  it("rejects a name longer than 128 characters", () => {
    expect(() => assertValidEntryName("a".repeat(129))).toThrow(SecretStoreEntryNameError);
  });

  it("carries the offending name on the thrown error", () => {
    expect.assertions(2);
    try {
      assertValidEntryName("bad name");
    } catch (error) {
      expect(error).toBeInstanceOf(SecretStoreEntryNameError);
      expect((error as SecretStoreEntryNameError).entryName).toBe("bad name");
    }
  });
});
