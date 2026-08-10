import type { CapabilityCatalogueV1, DoctorReportV2 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  adaptDoctorReportV2ToV1,
  appendCapabilityDoctorChecks,
  doctorHealthFromChecks,
} from "../src/capability/doctor.js";

type Catalogue = Static<typeof CapabilityCatalogueV1>;
type Entry = Catalogue["entries"][number];
type DoctorReport = Static<typeof DoctorReportV2>;

function entry(engine: Entry["engine"], overrides: Partial<Entry> = {}): Entry {
  const observedAt = "2026-08-07T10:00:00.000Z";
  const unknown = { support: "unknown" as const, evidence: [], reasons: [] };
  return {
    engine,
    accountId: null,
    engineVersion: "1",
    claudexorVersion: "3.1.2",
    observedAt,
    expiresAt: "2026-08-07T10:02:00.000Z",
    freshness: "fresh",
    discovery: "complete",
    configured: true,
    installation: "installed",
    authentication: "authenticated",
    compatibility: "compatible",
    capacity: "unknown",
    ready: true,
    models: [],
    features: {
      questions: unknown,
      resume: unknown,
      usage: unknown,
      structuredOutput: unknown,
      cancellation: unknown,
      tools: [],
    },
    provenance: [],
    reasons: [],
    ...overrides,
  };
}

function healthyBase(): DoctorReport {
  return {
    schemaVersion: 2,
    health: "healthy",
    checks: ["runtime", "auth-route", "compatibility", "cleanup"].map((category) => ({
      category: category as "runtime",
      readState: "ok" as const,
      verdict: "pass" as const,
      code: `BASE_${category}`,
      message: "ok",
    })),
  };
}

describe("capability doctor checks", () => {
  it("appends stable all-engine checks and does not block readiness on unknown capacity", () => {
    const report = appendCapabilityDoctorChecks(healthyBase(), {
      schemaVersion: 1,
      generatedAt: "2026-08-07T10:00:00.000Z",
      entries: [entry("claude"), entry("codex"), entry("cursor")],
    });
    expect(report.health).toBe("healthy");
    expect(report.checks.filter((check) => check.code.includes("_READINESS_READY"))).toHaveLength(
      3,
    );
    expect(report.checks).toHaveLength(16);
  });

  it("fails readiness for a known active rate limit", () => {
    const report = appendCapabilityDoctorChecks(healthyBase(), {
      schemaVersion: 1,
      generatedAt: "2026-08-07T10:00:00.000Z",
      entries: [
        entry("claude"),
        entry("codex", { capacity: "rate-limited", ready: false }),
        entry("cursor"),
      ],
    });
    expect(report.health).toBe("failed");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        code: "ENGINE_CODEX_READINESS_RATE_LIMITED",
        readState: "ok",
        verdict: "fail",
      }),
    );
  });

  it("maps catalogue unknown facets to not-read and aggregate unknown", () => {
    const report = appendCapabilityDoctorChecks(healthyBase(), {
      schemaVersion: 1,
      generatedAt: "2026-08-07T10:00:00.000Z",
      entries: [entry("claude", { authentication: "unknown" })],
    });
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        code: "ENGINE_CLAUDE_AUTH_UNKNOWN",
        readState: "not-read",
      }),
    );
    expect(report.health).toBe("unknown");
  });
});

describe("doctor health precedence and v1 adaptation", () => {
  it("follows fail > unknown > degraded > healthy", () => {
    expect(
      doctorHealthFromChecks([
        {
          category: "runtime",
          readState: "ok",
          verdict: "fail",
          code: "A",
          message: "a",
        },
        {
          category: "auth-route",
          readState: "not-read",
          code: "B",
          message: "b",
        },
      ]),
    ).toBe("failed");
    expect(
      doctorHealthFromChecks([
        {
          category: "runtime",
          readState: "not-read",
          code: "A",
          message: "a",
        },
        {
          category: "auth-route",
          readState: "ok",
          verdict: "warn",
          code: "B",
          message: "b",
        },
      ]),
    ).toBe("unknown");
    expect(
      doctorHealthFromChecks([
        {
          category: "runtime",
          readState: "ok",
          verdict: "warn",
          code: "A",
          message: "a",
        },
        {
          category: "auth-route",
          readState: "ok",
          verdict: "pass",
          code: "B",
          message: "b",
        },
      ]),
    ).toBe("degraded");
    expect(
      doctorHealthFromChecks([
        {
          category: "runtime",
          readState: "ok",
          verdict: "pass",
          code: "A",
          message: "a",
        },
      ]),
    ).toBe("healthy");
  });

  it("maps unread and read-failed checks to warn for legacy v1 callers", () => {
    const adapted = adaptDoctorReportV2ToV1({
      schemaVersion: 2,
      health: "unknown",
      checks: [
        {
          category: "runtime",
          readState: "not-read",
          code: "RUNTIME_PROBE_UNAVAILABLE",
          message: "missing",
        },
        {
          category: "auth-route",
          readState: "failed",
          code: "AUTH_READ_FAILED",
          message: "partial",
        },
        {
          category: "compatibility",
          readState: "ok",
          verdict: "pass",
          code: "COMPAT_OK",
          message: "ok",
        },
        {
          category: "cleanup",
          readState: "ok",
          verdict: "pass",
          code: "CLEAN_OK",
          message: "ok",
        },
      ],
    });
    expect(adapted.schemaVersion).toBe(1);
    expect(adapted.health).toBe("degraded");
    expect(adapted.checks.filter((check) => check.status === "warn")).toHaveLength(2);
    expect(adapted.checks.some((check) => check.status === "fail")).toBe(false);
  });
});
