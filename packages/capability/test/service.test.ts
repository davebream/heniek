import { describe, expect, it } from "vitest";
import {
  type CapabilityEntry,
  createCapabilityService,
  validateCapabilitySelection,
} from "../src/index.js";

function entry(overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  const observedAt = "2026-08-07T10:00:00.000Z";
  const supported = {
    support: "supported" as const,
    evidence: [{ source: "harness-inventory" as const, observedAt }],
    reasons: [],
  };
  return {
    engine: "claude",
    accountId: null,
    engineVersion: "1.0.0",
    claudexorVersion: "3.1.2",
    observedAt,
    expiresAt: "2026-08-07T10:02:00.000Z",
    freshness: "fresh",
    discovery: "complete",
    configured: true,
    installation: "installed",
    authentication: "authenticated",
    compatibility: "compatible",
    capacity: "available",
    ready: true,
    models: [
      { id: "sonnet", provenance: "manifest", efforts: ["high"], executionModes: ["native"] },
    ],
    features: {
      questions: supported,
      resume: supported,
      usage: supported,
      structuredOutput: supported,
      cancellation: supported,
      tools: [{ name: "web", state: supported }],
    },
    provenance: [{ source: "harness-inventory", observedAt }],
    reasons: [],
    ...overrides,
  };
}

describe("capability service", () => {
  it("reuses fresh snapshots and refreshes expired snapshots", async () => {
    const rows = new Map<string, CapabilityEntry>();
    for (const engine of ["claude", "codex", "cursor"] as const)
      rows.set(`${engine}:`, entry({ engine, configured: engine === "claude", accountId: null }));
    let calls = 0;
    let now = new Date("2026-08-07T10:01:00.000Z");
    const service = createCapabilityService({
      accounts: [],
      clock: { now: () => now },
      store: {
        readLatest: (engine, accountId) => rows.get(`${engine}:${accountId ?? ""}`),
        write: (value) => rows.set(`${value.engine}:${value.accountId ?? ""}`, value),
      },
      source: {
        discover: async () => {
          calls += 1;
          return [...rows.values()].map((value) => ({
            ...value,
            observedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 120_000).toISOString(),
          }));
        },
      },
    });
    expect((await service.catalogue()).entries).toHaveLength(3);
    expect(calls).toBe(0);
    now = new Date("2026-08-07T10:03:00.000Z");
    await service.catalogue();
    expect(calls).toBe(1);
  });

  it("retains expired evidence as explicitly stale after refresh failure", async () => {
    const rows = new Map<string, CapabilityEntry>();
    for (const engine of ["claude", "codex", "cursor"] as const)
      rows.set(`${engine}:`, entry({ engine, accountId: null }));
    const service = createCapabilityService({
      accounts: [],
      clock: { now: () => new Date("2026-08-07T10:03:00.000Z") },
      store: {
        readLatest: (engine, accountId) => rows.get(`${engine}:${accountId ?? ""}`),
        write: () => undefined,
      },
      source: {
        discover: async () => {
          throw new Error("offline");
        },
      },
    });
    const result = await service.catalogue();
    expect(
      result.entries.every(
        (value) => value.freshness === "stale" && value.discovery === "failed" && !value.ready,
      ),
    ).toBe(true);
  });

  it("invalidates fresh rows when an engine version changes", async () => {
    const rows = new Map<string, CapabilityEntry>();
    for (const engine of ["claude", "codex", "cursor"] as const)
      rows.set(`${engine}:`, entry({ engine, accountId: null }));
    let refreshes = 0;
    const service = createCapabilityService({
      accounts: [],
      clock: { now: () => new Date("2026-08-07T10:01:00.000Z") },
      store: {
        readLatest: (engine, accountId) => rows.get(`${engine}:${accountId ?? ""}`),
        write: (value) => rows.set(`${value.engine}:${value.accountId ?? ""}`, value),
      },
      source: {
        inspectVersions: async () =>
          [...rows.values()].map((value) => ({
            engine: value.engine,
            accountId: value.accountId,
            engineVersion: value.engine === "codex" ? "2.0.0" : value.engineVersion,
            claudexorVersion: value.claudexorVersion,
          })),
        discover: async () => {
          refreshes += 1;
          return [...rows.values()].map((value) => ({
            ...value,
            engineVersion: value.engine === "codex" ? "2.0.0" : value.engineVersion,
          }));
        },
      },
    });
    const result = await service.catalogue();
    expect(refreshes).toBe(1);
    expect(result.entries.find((value) => value.engine === "codex")?.engineVersion).toBe("2.0.0");
  });

  it("does not fall back to a snapshot from a different engine version", async () => {
    const rows = new Map<string, CapabilityEntry>();
    for (const engine of ["claude", "codex", "cursor"] as const)
      rows.set(`${engine}:`, entry({ engine, accountId: null }));
    const service = createCapabilityService({
      accounts: [],
      clock: { now: () => new Date("2026-08-07T10:01:00.000Z") },
      store: {
        readLatest: (engine, accountId) => rows.get(`${engine}:${accountId ?? ""}`),
        write: () => undefined,
      },
      source: {
        inspectVersions: async () =>
          [...rows.values()].map((value) => ({
            engine: value.engine,
            accountId: value.accountId,
            engineVersion: value.engine === "codex" ? "2.0.0" : value.engineVersion,
            claudexorVersion: value.claudexorVersion,
          })),
        discover: async () => {
          throw new Error("offline");
        },
      },
    });
    await expect(service.catalogue()).rejects.toThrow(/no complete cached catalogue/i);
  });
});

describe("selection validation", () => {
  const requirement = {
    engine: "claude" as const,
    model: "sonnet",
    effort: "high",
    executionMode: "native" as const,
    features: ["questions", "resume", "usage"] as const,
    tools: ["web"],
  };

  it("allows stale authoring evidence with a warning but fails execution closed", () => {
    const catalogue = {
      schemaVersion: 1 as const,
      generatedAt: entry().observedAt,
      entries: [
        entry({ freshness: "stale" }),
        entry({ engine: "codex" }),
        entry({ engine: "cursor" }),
      ],
    };
    expect(validateCapabilitySelection(catalogue, requirement, "authoring")).toMatchObject({
      ok: true,
      warnings: [expect.stringContaining("stale")],
    });
    expect(validateCapabilitySelection(catalogue, requirement, "execution")).toMatchObject({
      ok: false,
      error: { issues: [{ capability: "freshness", state: "stale" }] },
    });
  });

  it.each([
    ["configuration", { configured: false }],
    ["installation", { installation: "not-installed" as const }],
    ["authentication", { authentication: "unauthenticated" as const }],
    ["compatibility", { compatibility: "incompatible" as const }],
    ["capacity", { capacity: "rate-limited" as const }],
  ])("reports %s independently", (capability, override) => {
    const catalogue = {
      schemaVersion: 1 as const,
      generatedAt: entry().observedAt,
      entries: [entry(override), entry({ engine: "codex" }), entry({ engine: "cursor" })],
    };
    expect(validateCapabilitySelection(catalogue, requirement, "execution")).toMatchObject({
      ok: false,
      error: { issues: [expect.objectContaining({ capability })] },
    });
  });

  it("names every model, effort, mode, feature and tool mismatch", () => {
    const unsupported = {
      support: "unsupported" as const,
      evidence: [],
      reasons: ["advertised-unsupported"],
    };
    const bad = entry({
      models: [{ id: "sonnet", provenance: "api", efforts: ["low"], executionModes: ["external"] }],
      features: { ...entry().features, questions: unsupported, tools: [] },
    });
    const result = validateCapabilitySelection(
      {
        schemaVersion: 1,
        generatedAt: bad.observedAt,
        entries: [bad, entry({ engine: "codex" }), entry({ engine: "cursor" })],
      },
      requirement,
      "execution",
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok)
      expect(result.error.issues.map((value) => value.capability)).toEqual([
        "effort:high",
        "execution-mode:native",
        "questions",
        "tool:web",
      ]);
  });
});
