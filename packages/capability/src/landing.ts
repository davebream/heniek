import type {
  CapabilityDeltaV1,
  CapabilityDifferenceV1,
  CapabilityFeatureName,
  CapabilityLandingV1,
  CapabilityPinAxis,
  CapabilityResolutionBlockerV1,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import type { CapabilityCatalogue, CapabilityEntry } from "./types.js";

export type CapabilityFeature = Static<typeof CapabilityFeatureName>;
export type CapabilityPin = Static<typeof CapabilityPinAxis>;
export type CapabilityDifference = Static<typeof CapabilityDifferenceV1>;
export type CapabilityDelta = Static<typeof CapabilityDeltaV1>;
export type CapabilityLanding = Static<typeof CapabilityLandingV1>;
export type CapabilityResolutionBlocker = Static<typeof CapabilityResolutionBlockerV1>;

/** Capability-shaped invocation override fields treated as pins. */
export const CAPABILITY_PIN_OVERRIDE_FIELDS = [
  "engine",
  "account",
  "billing",
  "model",
  "effort",
  "executor",
] as const;

export type CapabilityPinOverrideField = (typeof CAPABILITY_PIN_OVERRIDE_FIELDS)[number];

export interface CapabilityRequestSnapshot {
  readonly profileId: string;
  readonly engine: "claude" | "codex" | "cursor";
  readonly accountId: string | null;
  readonly billing: "subscription" | null;
  readonly model: string;
  readonly effort: string;
  readonly executionMode: "native" | "external";
  readonly preferredFeatures: readonly CapabilityFeature[];
  readonly preferredTools: readonly string[];
  readonly requiredFeatures: readonly CapabilityFeature[];
  readonly requiredTools: readonly string[];
}

export interface CapabilityCandidateSnapshot {
  readonly profileId: string;
  readonly engine: "claude" | "codex" | "cursor";
  readonly accountId: string | null;
  readonly billing: "subscription" | null;
  readonly model: string;
  readonly effort: string;
  readonly executionMode: "native" | "external";
}

export type CapabilityCandidateEvaluation =
  | {
      readonly ok: true;
      readonly landing: Extract<CapabilityLanding, { readonly status: "satisfied" | "degraded" }>;
      readonly delta: CapabilityDelta | undefined;
    }
  | {
      readonly ok: false;
      readonly pinViolations: readonly CapabilityPin[];
      readonly differences: readonly CapabilityDifference[];
    };

const AXIS_ORDER = [
  "engine",
  "account",
  "billing",
  "model",
  "effort",
  "executionMode",
  "preferredFeatures",
  "preferredTools",
  "requiredFeatures",
  "requiredTools",
] as const;

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sortFeatures(values: readonly CapabilityFeature[]): CapabilityFeature[] {
  return sortStrings(values) as CapabilityFeature[];
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function pinAxisForOverride(field: CapabilityPinOverrideField): CapabilityPin {
  return field === "executor" ? "executionMode" : field;
}

/**
 * Derive pinned axes from applied capability-shaped overrides plus hard
 * required feature/tool lists. No general pin syntax is introduced.
 */
export function pinnedAxesFrom(input: {
  readonly appliedOverrideFields?: readonly CapabilityPinOverrideField[];
  readonly requiredFeatures?: readonly CapabilityFeature[];
  readonly requiredTools?: readonly string[];
}): readonly CapabilityPin[] {
  const pins = new Set<CapabilityPin>();
  for (const field of input.appliedOverrideFields ?? []) pins.add(pinAxisForOverride(field));
  if ((input.requiredFeatures?.length ?? 0) > 0) pins.add("requiredFeatures");
  if ((input.requiredTools?.length ?? 0) > 0) pins.add("requiredTools");
  return [...pins].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function requestSnapshotFromProfile(
  profile: {
    readonly profileId: string;
    readonly engine: CapabilityCandidateSnapshot["engine"];
    readonly accountId?: string;
    readonly billing?: "subscription";
    readonly model: string;
    readonly effort: string;
    readonly executionMode: CapabilityCandidateSnapshot["executionMode"];
  },
  options: {
    readonly preferredFeatures?: readonly CapabilityFeature[];
    readonly preferredTools?: readonly string[];
    readonly requiredFeatures?: readonly CapabilityFeature[];
    readonly requiredTools?: readonly string[];
  } = {},
): CapabilityRequestSnapshot {
  return {
    profileId: profile.profileId,
    engine: profile.engine,
    accountId: profile.accountId ?? null,
    billing: profile.billing ?? null,
    model: profile.model,
    effort: profile.effort,
    executionMode: profile.executionMode,
    preferredFeatures: sortFeatures(options.preferredFeatures ?? []),
    preferredTools: sortStrings(options.preferredTools ?? []),
    requiredFeatures: sortFeatures(options.requiredFeatures ?? []),
    requiredTools: sortStrings(options.requiredTools ?? []),
  };
}

export function candidateSnapshotFromProfile(profile: {
  readonly profileId: string;
  readonly engine: CapabilityCandidateSnapshot["engine"];
  readonly accountId?: string;
  readonly billing?: "subscription";
  readonly model: string;
  readonly effort: string;
  readonly executionMode: CapabilityCandidateSnapshot["executionMode"];
}): CapabilityCandidateSnapshot {
  return {
    profileId: profile.profileId,
    engine: profile.engine,
    accountId: profile.accountId ?? null,
    billing: profile.billing ?? null,
    model: profile.model,
    effort: profile.effort,
    executionMode: profile.executionMode,
  };
}

function supportedFeatures(
  entry: CapabilityEntry | undefined,
  requested: readonly CapabilityFeature[],
): CapabilityFeature[] {
  if (entry === undefined) return [];
  return sortFeatures(requested.filter((name) => entry.features[name].support === "supported"));
}

function supportedTools(
  entry: CapabilityEntry | undefined,
  requested: readonly string[],
): string[] {
  if (entry === undefined) return [];
  return sortStrings(
    requested.filter(
      (name) =>
        entry.features.tools.find((tool) => tool.name === name)?.state.support === "supported",
    ),
  );
}

function findEntry(
  catalogue: CapabilityCatalogue | undefined,
  candidate: CapabilityCandidateSnapshot,
): CapabilityEntry | undefined {
  if (catalogue === undefined) return undefined;
  const accountId = candidate.executionMode === "native" ? null : candidate.accountId;
  return catalogue.entries.find(
    (entry) => entry.engine === candidate.engine && entry.accountId === accountId,
  );
}

function orderDifferences(differences: readonly CapabilityDifference[]): CapabilityDifference[] {
  return [...differences].sort(
    (left, right) => AXIS_ORDER.indexOf(left.axis) - AXIS_ORDER.indexOf(right.axis),
  );
}

/**
 * Compare a requested primary profile (plus preferences/requirements) against
 * one concrete candidate. Pin or hard-requirement violations reject the
 * candidate; permitted differences become a deterministic delta with no
 * aggregate severity.
 */
export function evaluateCapabilityCandidate(input: {
  readonly requested: CapabilityRequestSnapshot;
  readonly candidate: CapabilityCandidateSnapshot;
  readonly pinnedAxes: readonly CapabilityPin[];
  readonly catalogue?: CapabilityCatalogue;
}): CapabilityCandidateEvaluation {
  const pins = new Set(input.pinnedAxes);
  const entry = findEntry(input.catalogue, input.candidate);
  const differences: CapabilityDifference[] = [];
  const pinViolations: CapabilityPin[] = [];

  const pushScalar = <A extends CapabilityDifference["axis"]>(
    axis: A,
    requested: Extract<CapabilityDifference, { axis: A }>["requested"],
    resolved: Extract<CapabilityDifference, { axis: A }>["resolved"],
  ) => {
    if (Object.is(requested, resolved)) return;
    differences.push({ axis, requested, resolved } as CapabilityDifference);
    if (pins.has(axis as CapabilityPin)) pinViolations.push(axis as CapabilityPin);
  };

  pushScalar("engine", input.requested.engine, input.candidate.engine);
  pushScalar("account", input.requested.accountId, input.candidate.accountId);
  pushScalar("billing", input.requested.billing, input.candidate.billing);
  pushScalar("model", input.requested.model, input.candidate.model);
  pushScalar("effort", input.requested.effort, input.candidate.effort);
  pushScalar("executionMode", input.requested.executionMode, input.candidate.executionMode);

  const resolvedPreferredFeatures = supportedFeatures(entry, input.requested.preferredFeatures);
  if (!sameStringList(input.requested.preferredFeatures, resolvedPreferredFeatures)) {
    differences.push({
      axis: "preferredFeatures",
      requested: [...input.requested.preferredFeatures],
      resolved: resolvedPreferredFeatures,
    });
  }

  const resolvedPreferredTools = supportedTools(entry, input.requested.preferredTools);
  if (!sameStringList(input.requested.preferredTools, resolvedPreferredTools)) {
    differences.push({
      axis: "preferredTools",
      requested: [...input.requested.preferredTools],
      resolved: resolvedPreferredTools,
    });
  }

  if (pins.has("requiredFeatures") || input.requested.requiredFeatures.length > 0) {
    const resolvedRequired = supportedFeatures(entry, input.requested.requiredFeatures);
    if (!sameStringList(input.requested.requiredFeatures, resolvedRequired)) {
      differences.push({
        axis: "requiredFeatures",
        requested: [...input.requested.requiredFeatures],
        resolved: resolvedRequired,
      });
      pinViolations.push("requiredFeatures");
    }
  }

  if (pins.has("requiredTools") || input.requested.requiredTools.length > 0) {
    const resolvedRequired = supportedTools(entry, input.requested.requiredTools);
    if (!sameStringList(input.requested.requiredTools, resolvedRequired)) {
      differences.push({
        axis: "requiredTools",
        requested: [...input.requested.requiredTools],
        resolved: resolvedRequired,
      });
      pinViolations.push("requiredTools");
    }
  }

  const ordered = orderDifferences(differences);
  if (pinViolations.length > 0) {
    return {
      ok: false,
      pinViolations: [...new Set(pinViolations)].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
      differences: ordered,
    };
  }

  const delta: CapabilityDelta = {
    schemaVersion: 1,
    requestedProfileId: input.requested.profileId,
    resolvedProfileId: input.candidate.profileId,
    differences: ordered,
  };

  if (ordered.length === 0) {
    return {
      ok: true,
      landing: { schemaVersion: 1, status: "satisfied" },
      delta: undefined,
    };
  }

  return {
    ok: true,
    landing: { schemaVersion: 1, status: "degraded", delta },
    delta,
  };
}

export function buildPinnedCapabilityBlocker(input: {
  readonly pinnedAxes: readonly CapabilityPin[];
  readonly rejections: readonly {
    readonly profileId: string;
    readonly differences: readonly CapabilityDifference[];
  }[];
}): CapabilityResolutionBlocker {
  return {
    schemaVersion: 1,
    reason: "pinned_capability_unavailable",
    pinnedAxes: [...input.pinnedAxes],
    candidates: input.rejections.map((rejection) => ({
      profileId: rejection.profileId,
      differences: orderDifferences(rejection.differences),
    })),
  };
}

export function landingFromDelta(delta: CapabilityDelta | undefined): CapabilityLanding {
  if (delta === undefined || delta.differences.length === 0) {
    return { schemaVersion: 1, status: "satisfied" };
  }
  return { schemaVersion: 1, status: "degraded", delta };
}

export function blockedLanding(blocker: CapabilityResolutionBlocker): CapabilityLanding {
  return { schemaVersion: 1, status: "blocked", blocker };
}
