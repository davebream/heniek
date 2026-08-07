import type { CapabilityCatalogueV1, DoctorReportV1 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { appendCapabilityDoctorChecks } from "../src/capability/doctor.js";

type Catalogue = Static<typeof CapabilityCatalogueV1>;
type Entry = Catalogue["entries"][number];

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

describe("capability doctor checks", () => {
  it("appends stable all-engine checks and does not block readiness on unknown capacity", () => {
    const base: Static<typeof DoctorReportV1> = {
      schemaVersion: 1,
      health: "healthy",
      checks: ["runtime", "auth-route", "compatibility", "cleanup"].map((category) => ({
        category: category as "runtime",
        status: "pass",
        code: `BASE_${category}`,
        message: "ok",
      })),
    };
    const report = appendCapabilityDoctorChecks(base, {
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
    const base: Static<typeof DoctorReportV1> = {
      schemaVersion: 1,
      health: "healthy",
      checks: ["runtime", "auth-route", "compatibility", "cleanup"].map((category) => ({
        category: category as "runtime",
        status: "pass",
        code: `BASE_${category}`,
        message: "ok",
      })),
    };
    const report = appendCapabilityDoctorChecks(base, {
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
      expect.objectContaining({ code: "ENGINE_CODEX_READINESS_RATE_LIMITED", status: "fail" }),
    );
  });
});
