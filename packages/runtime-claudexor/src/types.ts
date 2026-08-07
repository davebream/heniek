import type {
  RuntimeCompatibilityReportV1,
  RuntimeIdentityV1,
  RuntimeInventoryV1,
  RuntimeMutationResultV1,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";

export type RuntimeIdentity = Static<typeof RuntimeIdentityV1>;
export type RuntimeInventory = Static<typeof RuntimeInventoryV1>;
export type RuntimeCompatibilityReport = Static<typeof RuntimeCompatibilityReportV1>;
export type RuntimeMutationResult = Static<typeof RuntimeMutationResultV1>;

export interface RuntimeProbeResult {
  readonly version: string;
  readonly buildSha: string;
}

export interface RuntimeIdentityProbe {
  inspect(entryPath: string): Promise<RuntimeProbeResult>;
}

export interface RuntimeCompatibilityGate {
  run(runtime: RuntimeIdentity): Promise<RuntimeCompatibilityReport>;
}
