import type {
  BackendExecutionHandleV1,
  ExecutionBackendV3,
  ExecutionRequestV3,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import type { CapabilityLanding } from "./landing.js";
import { type CatalogueProfileResolutionInput, resolveProfileForExecution } from "./resolve.js";
import type { CapabilityService } from "./service.js";

type ProfileExecutionRequestInput = Omit<
  Static<typeof ExecutionRequestV3>,
  "schemaVersion" | "profile"
>;

export interface ProfileExecutionStartInput extends CatalogueProfileResolutionInput {
  /** Provider-neutral stage inputs; the profile is resolved, never supplied raw. */
  readonly execution: ProfileExecutionRequestInput;
}

export type ProfileExecutionStartResult =
  | {
      readonly ok: true;
      readonly handle: Static<typeof BackendExecutionHandleV1>;
      readonly landing: Extract<CapabilityLanding, { readonly status: "satisfied" }>;
    }
  | Exclude<Awaited<ReturnType<typeof resolveProfileForExecution>>, { readonly ok: true }>;

/**
 * Resolves a named profile against fresh catalogue evidence before invoking a
 * V3 backend. The required lifecycle features are non-negotiable for this
 * path; caller-supplied requirements can only add to them.
 */
export async function startProfileExecution(
  service: CapabilityService,
  backend: ExecutionBackendV3,
  input: ProfileExecutionStartInput,
): Promise<ProfileExecutionStartResult> {
  const requiredFeatures = [
    "questions",
    "resume",
    "cancellation",
    ...(input.requiredFeatures ?? []),
  ] as const;
  const resolution = await resolveProfileForExecution(service, {
    profileId: input.profileId,
    documents: input.documents,
    ...(input.invocationOverrides === undefined
      ? {}
      : { invocationOverrides: input.invocationOverrides }),
    requiredFeatures: [...new Set(requiredFeatures)],
    ...(input.requiredTools === undefined ? {} : { requiredTools: input.requiredTools }),
  });
  if (!resolution.ok) return resolution;
  return {
    ok: true,
    handle: await backend.start({
      schemaVersion: 3,
      ...input.execution,
      profile: resolution.resolution.profile,
    }),
    landing: resolution.landing,
  };
}
