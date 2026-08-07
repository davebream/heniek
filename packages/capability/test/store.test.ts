import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDatabase, runMigrations } from "@heniek/state";
import { describe, expect, it } from "vitest";
import { type CapabilityEntry, createStateCapabilitySnapshotStore } from "../src/index.js";

function snapshot(engineVersion: string, observedAt: string): CapabilityEntry {
  const unknown = { support: "unknown" as const, evidence: [], reasons: ["not-advertised"] };
  return {
    engine: "codex",
    accountId: "work",
    engineVersion,
    claudexorVersion: "3.1.2",
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 120_000).toISOString(),
    freshness: "fresh",
    discovery: "partial",
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
    provenance: [{ source: "harness-inventory", observedAt }],
    reasons: [],
  };
}

describe("SQLite capability snapshot store", () => {
  it("survives restart and keeps engine-version snapshots distinct", () => {
    const directory = mkdtempSync(join(tmpdir(), "heniek-capability-"));
    chmodSync(directory, 0o700);
    const path = join(directory, "state.sqlite");
    const options = {
      path,
      clock: { nowIso: () => "2026-08-07T10:00:00.000Z" },
      ids: { next: (prefix: string) => `${prefix}-1` },
    };
    const first = openStateDatabase(options);
    runMigrations(first);
    const store = createStateCapabilitySnapshotStore(first);
    store.write(snapshot("1.0.0", "2026-08-07T10:00:00.000Z"));
    store.write(snapshot("2.0.0", "2026-08-07T10:01:00.000Z"));
    first.close();

    const reopened = openStateDatabase(options);
    runMigrations(reopened);
    expect(
      createStateCapabilitySnapshotStore(reopened).readLatest("codex", "work")?.engineVersion,
    ).toBe("2.0.0");
    reopened.close();
  });
});
