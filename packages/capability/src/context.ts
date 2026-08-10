import type { CapabilityDelta, CapabilityLanding } from "@heniek/capability";

/**
 * Deterministic, provider-neutral stage-visible context derived from a
 * capability delta. Adapters may append this to prompts; Claudexor DTOs stay
 * inside the adapter.
 */
export function formatCapabilityDeltaContext(delta: CapabilityDelta): string {
  const lines = delta.differences.map((difference) => {
    switch (difference.axis) {
      case "preferredFeatures":
      case "preferredTools":
      case "requiredFeatures":
      case "requiredTools":
        return `${difference.axis}: requested=[${difference.requested.join(",")}] resolved=[${difference.resolved.join(",")}]`;
      default:
        return `${difference.axis}: requested=${String(difference.requested)} resolved=${String(difference.resolved)}`;
    }
  });
  return [
    "Capability landing: degraded",
    `requestedProfileId=${delta.requestedProfileId}`,
    `resolvedProfileId=${delta.resolvedProfileId}`,
    ...lines,
  ].join("\n");
}

export function formatCapabilityLandingContext(landing: CapabilityLanding): string | undefined {
  if (landing.status !== "degraded") return undefined;
  return formatCapabilityDeltaContext(landing.delta);
}
