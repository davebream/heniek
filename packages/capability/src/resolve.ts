import type { ConfigurationLayerDocument } from "@heniek/config";
import {
  type ProfileInvocationOverrides,
  type ProfileResolutionResult,
  resolveProfile,
} from "@heniek/config";
import type { CapabilityFeature, CapabilityLanding } from "./landing.js";
import {
  type CapabilityService,
  profileCapabilityRows,
  validateCapabilitySelection,
} from "./service.js";
import type { CapabilityRequirement, CapabilitySelectionError } from "./types.js";

export interface CatalogueProfileResolutionInput {
  readonly profileId: string;
  readonly documents: readonly ConfigurationLayerDocument[];
  readonly invocationOverrides?: ProfileInvocationOverrides;
  readonly requiredFeatures?: CapabilityRequirement["features"];
  readonly requiredTools?: readonly string[];
  readonly preferredFeatures?: readonly CapabilityFeature[];
  readonly preferredTools?: readonly string[];
}

/** Authoring retains free-text warnings for stale catalogue evidence. */
export type CatalogueAuthoringResolutionResult =
  | {
      readonly ok: true;
      readonly resolution: Extract<ProfileResolutionResult, { readonly ok: true }>;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly resolution?: Extract<ProfileResolutionResult, { readonly ok: false }>;
      readonly selectionError?: CapabilitySelectionError;
    };

/**
 * Execution resolution carries an explicit landing. Authoring-only stale
 * warnings never appear here.
 */
export type CatalogueExecutionResolutionResult =
  | {
      readonly ok: true;
      readonly resolution: Extract<ProfileResolutionResult, { readonly ok: true }>;
      readonly landing: Extract<CapabilityLanding, { readonly status: "satisfied" }>;
    }
  | {
      readonly ok: false;
      readonly resolution?: Extract<ProfileResolutionResult, { readonly ok: false }>;
      readonly selectionError?: CapabilitySelectionError;
    };

/** @deprecated Prefer the authoring/execution-specific result types. */
export type CatalogueProfileResolutionResult = CatalogueAuthoringResolutionResult;

async function resolveWithCatalogue(
  service: CapabilityService,
  input: CatalogueProfileResolutionInput,
  phase: "authoring" | "execution",
): Promise<CatalogueAuthoringResolutionResult | CatalogueExecutionResolutionResult> {
  const catalogue = await service.catalogue();
  const resolution = resolveProfile({
    profileId: input.profileId,
    documents: input.documents,
    ...(input.invocationOverrides === undefined
      ? {}
      : { invocationOverrides: input.invocationOverrides }),
    capabilities: profileCapabilityRows(catalogue),
  });
  if (!resolution.ok) return { ok: false, resolution };
  const profile = resolution.profile;
  const selection = validateCapabilitySelection(
    catalogue,
    {
      engine: profile.engine,
      ...(profile.accountId === undefined ? {} : { accountId: profile.accountId }),
      model: profile.model,
      effort: profile.effort,
      executionMode: profile.executionMode,
      ...(input.requiredFeatures === undefined ? {} : { features: input.requiredFeatures }),
      ...(input.requiredTools === undefined ? {} : { tools: input.requiredTools }),
    },
    phase,
  );
  if (!selection.ok) return { ok: false, selectionError: selection.error };
  if (phase === "authoring") {
    return { ok: true, resolution, warnings: selection.warnings };
  }
  return {
    ok: true,
    resolution,
    landing: { schemaVersion: 1, status: "satisfied" },
  };
}

export function resolveProfileForAuthoring(
  service: CapabilityService,
  input: CatalogueProfileResolutionInput,
): Promise<CatalogueAuthoringResolutionResult> {
  return resolveWithCatalogue(
    service,
    input,
    "authoring",
  ) as Promise<CatalogueAuthoringResolutionResult>;
}

export function resolveProfileForExecution(
  service: CapabilityService,
  input: CatalogueProfileResolutionInput,
): Promise<CatalogueExecutionResolutionResult> {
  return resolveWithCatalogue(
    service,
    input,
    "execution",
  ) as Promise<CatalogueExecutionResolutionResult>;
}
