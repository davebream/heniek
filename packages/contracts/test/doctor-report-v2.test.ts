import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { DoctorReportV2, ExecutionBackendDiagnosticV1 } from "../src/index.js";

const completedPass = {
  category: "runtime" as const,
  readState: "ok" as const,
  verdict: "pass" as const,
  code: "RUNTIME_OK",
  message: "Runtime is available.",
};

const completedFail = {
  category: "auth-route" as const,
  readState: "ok" as const,
  verdict: "fail" as const,
  code: "AUTH_NEGATIVE",
  message: "Subscription was refused.",
};

const notRead = {
  category: "compatibility" as const,
  readState: "not-read" as const,
  code: "COMPATIBILITY_UNAVAILABLE",
  message: "Compatibility probe did not start.",
};

const readFailed = {
  category: "cleanup" as const,
  readState: "failed" as const,
  code: "CLEANUP_READ_FAILED",
  message: "Cleanup probe returned a partial envelope.",
};

describe("ExecutionBackendDiagnosticV1", () => {
  it("accepts completed verdicts and incomplete reads", () => {
    expect(Value.Check(ExecutionBackendDiagnosticV1, completedPass)).toBe(true);
    expect(Value.Check(ExecutionBackendDiagnosticV1, completedFail)).toBe(true);
    expect(Value.Check(ExecutionBackendDiagnosticV1, notRead)).toBe(true);
    expect(Value.Check(ExecutionBackendDiagnosticV1, readFailed)).toBe(true);
  });

  it("rejects a verdict on not-read or failed", () => {
    expect(
      Value.Check(ExecutionBackendDiagnosticV1, {
        ...notRead,
        verdict: "fail",
      }),
    ).toBe(false);
    expect(
      Value.Check(ExecutionBackendDiagnosticV1, {
        ...readFailed,
        verdict: "warn",
      }),
    ).toBe(false);
  });

  it("rejects a missing verdict on ok", () => {
    expect(
      Value.Check(ExecutionBackendDiagnosticV1, {
        category: "runtime",
        readState: "ok",
        code: "RUNTIME_OK",
        message: "Runtime is available.",
      }),
    ).toBe(false);
  });
});

describe("DoctorReportV2", () => {
  it("accepts the unknown health state with split-axis checks", () => {
    expect(
      Value.Check(DoctorReportV2, {
        schemaVersion: 2,
        health: "unknown",
        checks: [completedPass, completedFail, notRead, readFailed],
      }),
    ).toBe(true);
  });

  it("rejects illegal check combinations inside the report", () => {
    expect(
      Value.Check(DoctorReportV2, {
        schemaVersion: 2,
        health: "failed",
        checks: [
          completedPass,
          completedFail,
          notRead,
          { ...notRead, category: "cleanup", verdict: "fail" },
        ],
      }),
    ).toBe(false);
  });
});
