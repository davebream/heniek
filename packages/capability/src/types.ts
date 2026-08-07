import type {
  CapabilityCatalogueEntryV1,
  CapabilityCatalogueV1,
  CapabilitySelectionErrorV1,
  ProfileEngine,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";

export type CapabilityCatalogue = Static<typeof CapabilityCatalogueV1>;
export type CapabilityEntry = Static<typeof CapabilityCatalogueEntryV1>;
export type CapabilitySelectionError = Static<typeof CapabilitySelectionErrorV1>;
export type CapabilityEngine = Static<typeof ProfileEngine>;

export interface ConfiguredCapabilityAccount {
  readonly engine: CapabilityEngine;
  /** Matched byte-for-byte against Claudexor's credential profile id. */
  readonly accountId: string;
}

export interface CapabilityClock {
  now(): Date;
}

export interface CapabilityDiscoverySource {
  discover(accounts: readonly ConfiguredCapabilityAccount[]): Promise<CapabilityEntry[]>;
  inspectVersions?(
    accounts: readonly ConfiguredCapabilityAccount[],
  ): Promise<readonly CapabilityVersionIdentity[]>;
}

export interface CapabilityVersionIdentity {
  readonly engine: CapabilityEngine;
  readonly accountId: string | null;
  readonly engineVersion: string | null;
  readonly claudexorVersion: string;
}

export interface CapabilitySnapshotStore {
  readLatest(engine: CapabilityEngine, accountId: string | null): CapabilityEntry | undefined;
  write(entry: CapabilityEntry): void;
}

export interface CapabilityRequirement {
  readonly engine: CapabilityEngine;
  readonly accountId?: string;
  readonly model: string;
  readonly effort: string;
  readonly executionMode: "native" | "external";
  readonly features?: readonly (
    | "questions"
    | "resume"
    | "usage"
    | "structuredOutput"
    | "cancellation"
  )[];
  readonly tools?: readonly string[];
}
