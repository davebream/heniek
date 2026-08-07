import type { ExecutionTelemetryV1 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";

export const TELEMETRY_METRIC_NAMES = [
  "inputUnits",
  "outputUnits",
  "cachedInputUnits",
  "cacheReadUnits",
  "cacheWriteUnits",
  "totalUnits",
  "costUsd",
  "wallDurationMs",
  "apiDurationMs",
  "contextUsedUnits",
  "contextWindowUnits",
  "contextUtilization",
] as const;

export type TelemetryMetricName = (typeof TELEMETRY_METRIC_NAMES)[number];
export type TelemetryConfidence = "exact" | "estimated";
export type TelemetryAggregation = "delta" | "cumulative" | "gauge";
export type TelemetryUnavailableReason =
  | "not_reported"
  | "unsupported"
  | "invalid"
  | "contradictory"
  | "overflow"
  | "counter_reset";

export interface TelemetryNumberObservation {
  readonly value: unknown;
  readonly confidence: TelemetryConfidence;
  readonly aggregation: TelemetryAggregation;
}

export interface TelemetryObservation {
  readonly evidenceRef?: string;
  readonly providerSessionId?: unknown;
  readonly metrics?: Partial<Record<TelemetryMetricName, TelemetryNumberObservation>>;
  readonly unavailable?: Partial<Record<TelemetryMetricName, TelemetryUnavailableReason>>;
  readonly capacityExhausted?: boolean;
}

export interface TelemetryReducerOptions {
  readonly engine: "claude" | "codex" | "cursor";
  readonly executionMode: "external" | "native";
  readonly evidenceRef: string;
}

type TelemetrySnapshot = Static<typeof ExecutionTelemetryV1>;
type NumberMetric = TelemetrySnapshot["usage"]["inputUnits"];

interface AvailableState {
  readonly availability: "available";
  readonly value: number;
  readonly confidence: TelemetryConfidence;
  readonly lastCumulative?: number;
}

interface UnavailableState {
  readonly availability: "unavailable";
  readonly reason: TelemetryUnavailableReason;
}

type MetricState = AvailableState | UnavailableState;

const INTEGER_METRICS = new Set<TelemetryMetricName>([
  "inputUnits",
  "outputUnits",
  "cachedInputUnits",
  "cacheReadUnits",
  "cacheWriteUnits",
  "totalUnits",
  "wallDurationMs",
  "apiDurationMs",
  "contextUsedUnits",
  "contextWindowUnits",
]);

const unavailable = (reason: TelemetryUnavailableReason): UnavailableState => ({
  availability: "unavailable",
  reason,
});

function validValue(name: TelemetryMetricName, value: unknown): number | UnavailableState {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return unavailable("invalid");
  }
  if (name === "contextUtilization" && value > 1) return unavailable("invalid");
  if (
    INTEGER_METRICS.has(name) &&
    (!Number.isSafeInteger(value) || value > Number.MAX_SAFE_INTEGER)
  ) {
    return unavailable("overflow");
  }
  return value;
}

function safeAdd(left: number, right: number, integer: boolean): number | UnavailableState {
  const value = left + right;
  if (!Number.isFinite(value)) return unavailable("overflow");
  if (integer && !Number.isSafeInteger(value)) return unavailable("overflow");
  return value;
}

function weakerConfidence(
  left: TelemetryConfidence,
  right: TelemetryConfidence,
): TelemetryConfidence {
  return left === "estimated" || right === "estimated" ? "estimated" : "exact";
}

function availableMetric(value: number, confidence: TelemetryConfidence): NumberMetric {
  return { availability: "available", value, confidence };
}

export interface TelemetryReducer {
  observe(observation: TelemetryObservation): void;
  snapshot(): TelemetrySnapshot;
}

/**
 * Fold provider-neutral observations without inventing precision. Provider DTO
 * extraction belongs to each execution adapter; this reducer only understands
 * declared counter semantics and normalized evidence.
 */
export function createTelemetryReducer(options: TelemetryReducerOptions): TelemetryReducer {
  const metrics = new Map<TelemetryMetricName, MetricState>();
  const evidenceRefs = new Set<string>([options.evidenceRef]);
  const sessionIds = new Set<string>();
  let capacityExhausted = false;

  function observeMetric(name: TelemetryMetricName, observation: TelemetryNumberObservation): void {
    const checked = validValue(name, observation.value);
    if (typeof checked !== "number") {
      metrics.set(name, checked);
      return;
    }

    const previous = metrics.get(name);
    if (observation.aggregation === "gauge" || previous?.availability !== "available") {
      metrics.set(name, {
        availability: "available",
        value: checked,
        confidence: observation.confidence,
        ...(observation.aggregation === "cumulative" ? { lastCumulative: checked } : {}),
      });
      return;
    }

    if (observation.aggregation === "delta") {
      const sum = safeAdd(previous.value, checked, INTEGER_METRICS.has(name));
      metrics.set(
        name,
        typeof sum === "number"
          ? {
              availability: "available",
              value: sum,
              confidence: weakerConfidence(previous.confidence, observation.confidence),
            }
          : sum,
      );
      return;
    }

    const last = previous.lastCumulative ?? previous.value;
    const reset = checked < last;
    const increment = reset ? checked : checked - last;
    const sum = safeAdd(previous.value, increment, INTEGER_METRICS.has(name));
    metrics.set(
      name,
      typeof sum === "number"
        ? {
            availability: "available",
            value: sum,
            confidence: reset
              ? "estimated"
              : weakerConfidence(previous.confidence, observation.confidence),
            lastCumulative: checked,
          }
        : sum,
    );
  }

  function metric(name: TelemetryMetricName): NumberMetric {
    const state = metrics.get(name);
    if (state === undefined) return unavailable("not_reported");
    if (state.availability === "unavailable") return state;
    return availableMetric(state.value, state.confidence);
  }

  function contextUtilization(): {
    readonly metric: NumberMetric;
    readonly basis?: "reported_ratio" | "usage_ratio";
  } {
    const reported = metric("contextUtilization");
    const used = metric("contextUsedUnits");
    const window = metric("contextWindowUnits");
    const computed: NumberMetric | undefined =
      used.availability === "available" && window.availability === "available" && window.value > 0
        ? used.value / window.value <= 1
          ? availableMetric(
              used.value / window.value,
              weakerConfidence(used.confidence, window.confidence),
            )
          : unavailable("invalid")
        : undefined;

    if (reported.availability === "available" && computed?.availability === "available") {
      if (Math.abs(reported.value - computed.value) > 1e-9) {
        return {
          metric: availableMetric(Math.max(reported.value, computed.value), "estimated"),
          basis: reported.value >= computed.value ? "reported_ratio" : "usage_ratio",
        };
      }
      return { metric: reported, basis: "reported_ratio" };
    }
    if (reported.availability === "available") {
      return { metric: reported, basis: "reported_ratio" };
    }
    if (computed !== undefined) return { metric: computed, basis: "usage_ratio" };
    if (reported.reason !== "not_reported") return { metric: reported };
    if (window.availability === "available" && window.value === 0) {
      return { metric: unavailable("invalid") };
    }
    return { metric: unavailable("not_reported") };
  }

  return {
    observe(observation) {
      if (observation.evidenceRef !== undefined && evidenceRefs.size < 32) {
        evidenceRefs.add(observation.evidenceRef);
      }
      if (typeof observation.providerSessionId === "string" && observation.providerSessionId) {
        sessionIds.add(observation.providerSessionId);
      }
      if (observation.capacityExhausted === true) capacityExhausted = true;
      for (const [name, reason] of Object.entries(observation.unavailable ?? {})) {
        if (reason !== undefined) metrics.set(name as TelemetryMetricName, unavailable(reason));
      }
      for (const [name, value] of Object.entries(observation.metrics ?? {})) {
        if (value !== undefined) observeMetric(name as TelemetryMetricName, value);
      }
    },

    snapshot() {
      const utilization = contextUtilization();
      const providerSessionId =
        sessionIds.size === 0
          ? unavailable("not_reported")
          : sessionIds.size === 1
            ? {
                availability: "available" as const,
                value: [...sessionIds][0] as string,
                confidence: "exact" as const,
              }
            : unavailable("contradictory");
      const pressure = capacityExhausted
        ? ({ state: "exhausted", confidence: "exact", basis: "capacity_signal" } as const)
        : utilization.metric.availability === "available" && utilization.basis !== undefined
          ? ({
              state: "measured",
              utilization: utilization.metric,
              basis: utilization.basis,
            } as const)
          : ({
              state: "unavailable",
              reason:
                utilization.metric.availability === "unavailable"
                  ? utilization.metric.reason
                  : "not_reported",
            } as const);

      return {
        schemaVersion: 1,
        engine: options.engine,
        executionMode: options.executionMode,
        evidenceRefs: [...evidenceRefs],
        session: { providerSessionId },
        usage: {
          inputUnits: metric("inputUnits"),
          outputUnits: metric("outputUnits"),
          cachedInputUnits: metric("cachedInputUnits"),
          cacheReadUnits: metric("cacheReadUnits"),
          cacheWriteUnits: metric("cacheWriteUnits"),
          totalUnits: metric("totalUnits"),
          costUsd: metric("costUsd"),
        },
        timing: {
          wallDurationMs: metric("wallDurationMs"),
          apiDurationMs: metric("apiDurationMs"),
        },
        context: {
          usedUnits: metric("contextUsedUnits"),
          windowUnits: metric("contextWindowUnits"),
          utilization: utilization.metric,
          pressure,
        },
      };
    },
  };
}
