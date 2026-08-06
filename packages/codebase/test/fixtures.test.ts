import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("checked-in Codebase evidence fixtures", () => {
  it("pins a self-hashed registered Codebase with blocked topology readiness", async () => {
    const value = JSON.parse(
      await readFile(resolve(fixtures, "registered-codebase.json"), "utf8"),
    ) as Record<string, unknown>;
    const configurationSha256 = value.configurationSha256;
    const { configurationSha256: _configurationSha256, ...body } = value;
    expect(configurationSha256).toBe(sha256(canonical(body)));
    expect(value).toMatchObject({
      schemaVersion: 1,
      readiness: "blocked",
      diagnostics: [
        expect.objectContaining({ code: "REMOTE_MISSING", severity: "blocker" }),
        expect.objectContaining({ code: "DEFAULT_BRANCH_UNKNOWN", severity: "blocker" }),
      ],
    });
  });

  it("pins a self-hashed conflict report whose anchors resolve to known sources", async () => {
    const value = JSON.parse(
      await readFile(resolve(fixtures, "instruction-conflict-report.json"), "utf8"),
    ) as Record<string, unknown>;
    const sources = value.sources as Array<{ sourceId: string }>;
    const diagnostics = value.diagnostics as Array<{
      classification: string;
      anchors: Array<{ sourceId: string; startLine: number; endLine: number }>;
    }>;
    expect(value.snapshotSha256).toBe(sha256({ sources, diagnostics }));
    expect(diagnostics).toEqual([
      expect.objectContaining({
        classification: "incompatible",
        anchors: [
          expect.objectContaining({ startLine: 1, endLine: 1 }),
          expect.objectContaining({ startLine: 1, endLine: 1 }),
        ],
      }),
    ]);
    const sourceIds = new Set(sources.map((source) => source.sourceId));
    expect(
      diagnostics
        .flatMap((diagnostic) => diagnostic.anchors)
        .every((anchor) => sourceIds.has(anchor.sourceId)),
    ).toBe(true);
  });
});
