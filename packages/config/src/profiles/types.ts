import type {
  ProfileEngine,
  ProfileExecutionMode,
  ProfileQuestionMode,
  ResolvedProfileChainV1,
  ResolvedProfileV1,
  ResolvedProfileV2,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import type { Diagnostic } from "../diagnostics.js";
import type { ConfigurationLayerDocument } from "../layers/index.js";

export type Engine = Static<typeof ProfileEngine>;
export type ExecutionMode = Static<typeof ProfileExecutionMode>;
export type QuestionMode = Static<typeof ProfileQuestionMode>;
export type ResolvedProfile = Static<typeof ResolvedProfileV1>;
export type ResolvedProfileV2Snapshot = Static<typeof ResolvedProfileV2>;
export type ResolvedProfileChain = Static<typeof ResolvedProfileChainV1>;

export const PROFILE_OVERRIDE_FIELDS = [
  "engine",
  "account",
  "billing",
  "model",
  "effort",
  "executor",
  "focus",
  "max_duration",
  "workspace_strategy",
] as const;

export type ProfileOverrideField = (typeof PROFILE_OVERRIDE_FIELDS)[number];

/** Typed form of §8.2's most-specific invocation layer. */
export interface ProfileInvocationOverrides {
  readonly engine?: Engine;
  readonly account?: string;
  readonly billing?: "subscription";
  readonly model?: string;
  readonly effort?: string;
  readonly executor?: ExecutionMode;
  readonly focus?: string;
  readonly max_duration?: string;
  readonly workspace_strategy?: string;
}

/**
 * Q014's deliberately small validation input. Q015 will populate these rows
 * from durable discovery; Q014 never guesses from engine or model names.
 */
export interface ProfileCapabilityRow {
  readonly engine: Engine;
  readonly accountId?: string;
  readonly model: string;
  readonly efforts: readonly string[];
  readonly executionModes: readonly ExecutionMode[];
}

export interface ResolveProfileInput {
  readonly profileId: string;
  /** The first six §8.2 layers. Invocation documents are rejected here. */
  readonly documents: readonly ConfigurationLayerDocument[];
  readonly invocationOverrides?: ProfileInvocationOverrides;
  readonly capabilities: readonly ProfileCapabilityRow[];
}

export type ProfileResolutionResult =
  | {
      readonly ok: true;
      readonly profile: ResolvedProfile;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
    };

export type ProfileChainResolutionResult =
  | {
      readonly ok: true;
      readonly chain: ResolvedProfileChain;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
    };
