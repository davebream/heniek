/**
 * Context-pressure thresholds for smart continuation (§15.3 / ADR 0018).
 *
 * Defaults remain 0.65 soft / 0.80 hard. Pipeline overrides are authoritative
 * when present. Unavailable or contradictory telemetry forbids fusion and
 * forces a fresh boundary; estimated confidence uses the conservative ratio.
 */

export const DEFAULT_HANDOFF_SOFT_THRESHOLD = 0.65;
export const DEFAULT_HANDOFF_HARD_THRESHOLD = 0.8;

export type PressureConfidence = "exact" | "estimated" | "unavailable";
export type PressureState = "measured" | "exhausted" | "unavailable";

export type PressureAction = "continue" | "soft_boundary" | "hard_checkpoint" | "forbid_fusion";

export interface PressureObservationInput {
  readonly state: PressureState;
  readonly ratio?: number;
  readonly confidence: PressureConfidence;
  readonly softThreshold?: number;
  readonly hardThreshold?: number;
  readonly telemetryCursor?: string;
}

export interface PressureEvaluation {
  readonly action: PressureAction;
  readonly softThreshold: number;
  readonly hardThreshold: number;
  readonly ratio?: number;
  readonly confidence: PressureConfidence;
  readonly state: PressureState;
  readonly telemetryCursor?: string;
  readonly splitReason?:
    | "pressure_unavailable"
    | "pressure_contradictory"
    | "pressure_soft_threshold"
    | "pressure_hard_threshold"
    | "capacity_exhausted";
}

function resolveThresholds(input: PressureObservationInput): {
  readonly soft: number;
  readonly hard: number;
} {
  const soft = input.softThreshold ?? DEFAULT_HANDOFF_SOFT_THRESHOLD;
  const hard = input.hardThreshold ?? DEFAULT_HANDOFF_HARD_THRESHOLD;
  return { soft, hard };
}

/**
 * Evaluate context pressure against soft/hard thresholds.
 *
 * - unavailable → forbid fusion (fresh boundary)
 * - exhausted → hard checkpoint
 * - measured/estimated at ≥ hard → hard checkpoint
 * - measured/estimated at ≥ soft → soft boundary (finish turn, no further same-session turn)
 * - below soft → continue
 *
 * Estimated confidence still uses the reported ratio (ADR 0018 conservative
 * normalized ratio). Missing ratio with measured/estimated state is treated
 * as unavailable.
 */
export function evaluateContextPressure(input: PressureObservationInput): PressureEvaluation {
  const { soft, hard } = resolveThresholds(input);
  const base = {
    softThreshold: soft,
    hardThreshold: hard,
    confidence: input.confidence,
    state: input.state,
    ...(input.telemetryCursor === undefined ? {} : { telemetryCursor: input.telemetryCursor }),
    ...(input.ratio === undefined ? {} : { ratio: input.ratio }),
  };

  if (input.state === "unavailable" || input.confidence === "unavailable") {
    return {
      ...base,
      action: "forbid_fusion",
      splitReason: "pressure_unavailable",
    };
  }

  if (input.state === "exhausted") {
    return {
      ...base,
      action: "hard_checkpoint",
      splitReason: "capacity_exhausted",
    };
  }

  if (input.ratio === undefined || !Number.isFinite(input.ratio)) {
    return {
      ...base,
      action: "forbid_fusion",
      splitReason: "pressure_unavailable",
    };
  }

  // Contradictory signals arrive as estimated with the higher ratio already
  // selected by the telemetry reducer; treat estimated at/above hard as hard.
  if (input.ratio >= hard) {
    return {
      ...base,
      action: "hard_checkpoint",
      splitReason:
        input.confidence === "estimated" && input.ratio >= hard
          ? "pressure_hard_threshold"
          : "pressure_hard_threshold",
    };
  }

  if (input.ratio >= soft) {
    return {
      ...base,
      action: "soft_boundary",
      splitReason: "pressure_soft_threshold",
    };
  }

  return {
    ...base,
    action: "continue",
  };
}

/** True when pressure permits same-session fusion with a successor stage. */
export function pressureAllowsFusion(evaluation: PressureEvaluation): boolean {
  return evaluation.action === "continue";
}
