import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionTelemetryV1 } from "@heniek/contracts";
import {
  createTelemetryReducer,
  type TelemetryObservation,
  type TelemetryReducerOptions,
} from "@heniek/telemetry";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

interface Fixture {
  readonly id: string;
  readonly engine: TelemetryReducerOptions["engine"];
  readonly executionMode: TelemetryReducerOptions["executionMode"];
  readonly evidenceKind: "recorded" | "documented";
  readonly sourceVersion: string;
  readonly evidenceRef: string;
  readonly rawFieldPaths: readonly string[];
  readonly observations: readonly TelemetryObservation[];
  readonly expected: {
    readonly inputUnits: unknown;
    readonly contextPressure: unknown;
  };
}

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/telemetry-matrix.json",
);

describe("sanitized cross-engine telemetry fixture matrix", () => {
  it("maps all four v1 engines to valid, provider-neutral snapshots", async () => {
    const matrix = JSON.parse(await readFile(fixturePath, "utf8")) as {
      schemaVersion: string;
      fixtures: Fixture[];
    };
    expect(matrix.schemaVersion).toBe("heniek.telemetry-fixture-matrix.v1");
    expect(matrix.fixtures.map((fixture) => fixture.id)).toEqual([
      "external-claude-result",
      "codex-token-count",
      "cursor-result",
      "native-claude-statusline",
    ]);

    const validate = new Ajv({ allErrors: true, strict: true }).compile(ExecutionTelemetryV1);
    for (const fixture of matrix.fixtures) {
      expect(fixture.evidenceKind).toMatch(/^(recorded|documented)$/);
      expect(fixture.sourceVersion).not.toHaveLength(0);
      expect(fixture.rawFieldPaths.length).toBeGreaterThan(0);
      for (const observation of fixture.observations) {
        if (observation.providerSessionId !== undefined) {
          expect(observation.providerSessionId).toMatch(/^session-fixture/);
        }
      }
      const reducer = createTelemetryReducer(fixture);
      for (const observation of fixture.observations) reducer.observe(observation);
      const snapshot = reducer.snapshot();
      expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
      expect(snapshot.usage.inputUnits).toEqual(fixture.expected.inputUnits);
      expect(snapshot.context.pressure).toEqual(fixture.expected.contextPressure);
      expect(JSON.stringify(snapshot)).not.toMatch(/transcript|api[_-]?key|oauth|provider_secret/i);
      expect(JSON.stringify(snapshot)).not.toMatch(
        /input_tokens|output_tokens|cache_read|cache_write|duration_ms|used_percentage|thread_id/i,
      );
    }
  });
});
