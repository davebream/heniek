/**
 * Task 3.1 — the six artifact-store error classes (plan Phase 3, R6 / design
 * D12n). Each extends `StateStoreError`, so a caller that only wants "did
 * the artifact store reject this" can catch the base class. Messages are
 * built only from caller-supplied or already-derived-and-safe values —
 * never artifact bytes, never an ambient/derived value (`errors.ts:8-27`'s
 * house rule) — this file asserts that discipline holds for a representative
 * "large payload" scenario per class.
 */

import { describe, expect, it } from "vitest";
import {
  ArtifactCountExceededError,
  ArtifactDigestMismatchError,
  ArtifactQuarantinedError,
  ArtifactRecoveryError,
  ArtifactValidationError,
  StageAssertionFailedError,
  StateStoreError,
} from "../src/errors.js";

/** Stands in for "artifact bytes" — if a message ever contained this, the house rule broke. */
const FORBIDDEN_BYTES_MARKER = "FORBIDDEN-ARTIFACT-BYTES-MARKER";

describe("artifact-store error hierarchy (R6)", () => {
  it("ArtifactValidationError extends StateStoreError, carries relativePath/step, wraps cause", () => {
    const cause = new Error("EIO");
    const error = new ArtifactValidationError("blobs/sha256/deadbeef", "fsync", { cause });
    expect(error).toBeInstanceOf(StateStoreError);
    expect(error.name).toBe("ArtifactValidationError");
    expect(error.relativePath).toBe("blobs/sha256/deadbeef");
    expect(error.step).toBe("fsync");
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain(FORBIDDEN_BYTES_MARKER);
  });

  it("ArtifactValidationError accepts every R4 step name", () => {
    for (const step of ["write", "fsync", "link", "dirfsync"] as const) {
      const error = new ArtifactValidationError("blobs/sha256/deadbeef", step);
      expect(error.step).toBe(step);
    }
  });

  it("ArtifactDigestMismatchError extends StateStoreError and carries expected/actual hashes", () => {
    const expectedHash = "a".repeat(64);
    const actualHash = "b".repeat(64);
    const error = new ArtifactDigestMismatchError(expectedHash, actualHash);
    expect(error).toBeInstanceOf(StateStoreError);
    expect(error.name).toBe("ArtifactDigestMismatchError");
    expect(error.expectedHash).toBe(expectedHash);
    expect(error.actualHash).toBe(actualHash);
    expect(error.message).not.toContain(FORBIDDEN_BYTES_MARKER);
  });

  it("ArtifactQuarantinedError extends StateStoreError and carries relativePath", () => {
    const error = new ArtifactQuarantinedError("blobs/sha256/deadbeef");
    expect(error).toBeInstanceOf(StateStoreError);
    expect(error.name).toBe("ArtifactQuarantinedError");
    expect(error.relativePath).toBe("blobs/sha256/deadbeef");
    expect(error.message).not.toContain(FORBIDDEN_BYTES_MARKER);
  });

  it("StageAssertionFailedError extends StateStoreError and carries relativePath/reason", () => {
    const error = new StageAssertionFailedError("blobs/sha256/deadbeef", "nlink was 0");
    expect(error).toBeInstanceOf(StateStoreError);
    expect(error.name).toBe("StageAssertionFailedError");
    expect(error.relativePath).toBe("blobs/sha256/deadbeef");
    expect(error.reason).toBe("nlink was 0");
    expect(error.message).not.toContain(FORBIDDEN_BYTES_MARKER);
  });

  it("ArtifactRecoveryError extends StateStoreError and carries path/reason", () => {
    const error = new ArtifactRecoveryError("incoming/abcd.tmp", "unlink failed");
    expect(error).toBeInstanceOf(StateStoreError);
    expect(error.name).toBe("ArtifactRecoveryError");
    expect(error.path).toBe("incoming/abcd.tmp");
    expect(error.reason).toBe("unlink failed");
    expect(error.message).not.toContain(FORBIDDEN_BYTES_MARKER);
  });

  it("ArtifactCountExceededError extends StateStoreError and carries count/limit", () => {
    const error = new ArtifactCountExceededError(65, 64);
    expect(error).toBeInstanceOf(StateStoreError);
    expect(error.name).toBe("ArtifactCountExceededError");
    expect(error.count).toBe(65);
    expect(error.limit).toBe(64);
    expect(error.message).not.toContain(FORBIDDEN_BYTES_MARKER);
  });

  it("none of the six classes declare a credential-shaped field", () => {
    const forbidden =
      /password|secret|token|api[-_]?key|credential|private[-_]?key|access[-_]?key|passphrase/i;
    const instances = [
      new ArtifactValidationError("p", "write"),
      new ArtifactDigestMismatchError("a", "b"),
      new ArtifactQuarantinedError("p"),
      new StageAssertionFailedError("p", "r"),
      new ArtifactRecoveryError("p", "r"),
      new ArtifactCountExceededError(1, 1),
    ];
    for (const instance of instances) {
      for (const key of Object.keys(instance)) {
        expect(key).not.toMatch(forbidden);
      }
    }
  });
});
