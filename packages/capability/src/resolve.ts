import type { ConfigurationLayerDocument } from "@heniek/config";
import {
  type ProfileInvocationOverrides,
  type ProfileResolutionResult,
  resolveProfile,
} from "@heniek/config";
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
}

export type CatalogueProfileResolutionResult =
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

async function resolveWithCatalogue(
  service: CapabilityService,
  input: CatalogueProfileResolutionInput,
  phase: "authoring" | "execution",
): Promise<CatalogueProfileResolutionResult> {
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
  return { ok: true, resolution, warnings: selection.warnings };
}

export function resolveProfileForAuthoring(
  service: CapabilityService,
  input: CatalogueProfileResolutionInput,
): Promise<CatalogueProfileResolutionResult> {
  return resolveWithCatalogue(service, input, "authoring");
}

export function resolveProfileForExecution(
  service: CapabilityService,
  input: CatalogueProfileResolutionInput,
): Promise<CatalogueProfileResolutionResult> {
  return resolveWithCatalogue(service, input, "execution");
}
