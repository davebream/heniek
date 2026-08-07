import { describe, expect, it } from "vitest";
import { createTelemetryReducer } from "../src/index.js";

function reducer() {
  return createTelemetryReducer({
    engine: "codex",
    executionMode: "external",
    evidenceRef: "fixture:codex-telemetry",
  });
}

describe("telemetry reducer", () => {
  it("represents every missing value explicitly", () => {
    const snapshot = reducer().snapshot();
    expect(snapshot.usage.inputUnits).toEqual({
      availability: "unavailable",
      reason: "not_reported",
    });
    expect(snapshot.session.providerSessionId).toEqual({
      availability: "unavailable",
      reason: "not_reported",
    });
    expect(snapshot.context.pressure).toEqual({
      state: "unavailable",
      reason: "not_reported",
    });
  });

  it("adds deltas and cumulative epochs without producing a negative reset delta", () => {
    const telemetry = reducer();
    telemetry.observe({
      metrics: {
        inputUnits: { value: 100, confidence: "exact", aggregation: "cumulative" },
        outputUnits: { value: 10, confidence: "exact", aggregation: "delta" },
      },
    });
    telemetry.observe({
      metrics: {
        inputUnits: { value: 150, confidence: "exact", aggregation: "cumulative" },
        outputUnits: { value: 5, confidence: "exact", aggregation: "delta" },
      },
    });
    telemetry.observe({
      metrics: {
        inputUnits: { value: 20, confidence: "exact", aggregation: "cumulative" },
      },
    });

    expect(telemetry.snapshot().usage).toMatchObject({
      inputUnits: { availability: "available", value: 170, confidence: "estimated" },
      outputUnits: { availability: "available", value: 15, confidence: "exact" },
    });
  });

  it("marks malformed and overflowing counters unavailable", () => {
    const telemetry = reducer();
    telemetry.observe({
      metrics: {
        inputUnits: { value: -1, confidence: "exact", aggregation: "delta" },
        contextUtilization: { value: 1.1, confidence: "exact", aggregation: "gauge" },
        outputUnits: {
          value: Number.MAX_SAFE_INTEGER + 1,
          confidence: "exact",
          aggregation: "delta",
        },
        totalUnits: {
          value: Number.MAX_SAFE_INTEGER,
          confidence: "exact",
          aggregation: "delta",
        },
      },
    });
    telemetry.observe({
      metrics: {
        totalUnits: { value: 1, confidence: "exact", aggregation: "delta" },
      },
    });
    expect(telemetry.snapshot().usage).toMatchObject({
      inputUnits: { availability: "unavailable", reason: "invalid" },
      outputUnits: { availability: "unavailable", reason: "overflow" },
      totalUnits: { availability: "unavailable", reason: "overflow" },
    });
    expect(telemetry.snapshot().context.utilization).toEqual({
      availability: "unavailable",
      reason: "invalid",
    });
  });

  it("keeps post-compaction pressure independent from cumulative billing counters", () => {
    const telemetry = reducer();
    telemetry.observe({
      metrics: {
        inputUnits: { value: 100_000, confidence: "exact", aggregation: "cumulative" },
        contextUsedUnits: { value: 90_000, confidence: "exact", aggregation: "gauge" },
        contextWindowUnits: { value: 100_000, confidence: "exact", aggregation: "gauge" },
      },
    });
    telemetry.observe({
      metrics: {
        inputUnits: { value: 10, confidence: "exact", aggregation: "cumulative" },
        contextUsedUnits: { value: 5_000, confidence: "exact", aggregation: "gauge" },
      },
    });

    expect(telemetry.snapshot()).toMatchObject({
      usage: {
        inputUnits: { availability: "available", value: 100_010, confidence: "estimated" },
      },
      context: {
        pressure: {
          state: "measured",
          utilization: { availability: "available", value: 0.05, confidence: "exact" },
          basis: "usage_ratio",
        },
      },
    });
  });

  it("uses the higher contradictory pressure signal and downgrades confidence", () => {
    const telemetry = reducer();
    telemetry.observe({
      metrics: {
        contextUsedUnits: { value: 80, confidence: "exact", aggregation: "gauge" },
        contextWindowUnits: { value: 100, confidence: "exact", aggregation: "gauge" },
        contextUtilization: { value: 0.65, confidence: "exact", aggregation: "gauge" },
      },
    });
    expect(telemetry.snapshot().context).toMatchObject({
      utilization: { availability: "available", value: 0.8, confidence: "estimated" },
      pressure: {
        state: "measured",
        utilization: { availability: "available", value: 0.8, confidence: "estimated" },
        basis: "usage_ratio",
      },
    });
  });

  it("lets a typed exhaustion signal override measured utilization", () => {
    const telemetry = reducer();
    telemetry.observe({
      providerSessionId: "session-fixture",
      capacityExhausted: true,
      metrics: {
        contextUtilization: { value: 0.5, confidence: "exact", aggregation: "gauge" },
      },
    });
    expect(telemetry.snapshot()).toMatchObject({
      session: {
        providerSessionId: {
          availability: "available",
          value: "session-fixture",
          confidence: "exact",
        },
      },
      context: {
        pressure: { state: "exhausted", confidence: "exact", basis: "capacity_signal" },
      },
    });
  });

  it("does not choose between contradictory provider session identifiers", () => {
    const telemetry = reducer();
    telemetry.observe({ providerSessionId: "session-a" });
    telemetry.observe({ providerSessionId: "session-b" });
    expect(telemetry.snapshot().session.providerSessionId).toEqual({
      availability: "unavailable",
      reason: "contradictory",
    });
  });
});
