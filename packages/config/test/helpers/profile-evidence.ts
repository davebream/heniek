import type { JsonObject } from "../../src/json.js";
import {
  type ProfileCapabilityRow,
  type ProfileInvocationOverrides,
  resolveProfile,
} from "../../src/profiles/index.js";

export const EVIDENCE_PROFILE_IDS = [
  "claude-external",
  "claude-native",
  "codex",
  "cursor",
] as const;

const values: JsonObject = {
  accounts: {
    "claude-main": { engine: "claude", billing: "subscription" },
    "codex-main": { engine: "codex", billing: "subscription" },
    "cursor-main": { engine: "cursor", billing: "subscription" },
  },
  workers: {
    "opus-external": {
      engine: "claude",
      executor: "external",
      account: "claude-main",
      model: "opus",
      effort: "xhigh",
    },
    "opus-native": {
      engine: "claude",
      executor: "native",
      model: "opus",
      effort: "high",
    },
    "sol-external": {
      engine: "codex",
      executor: "external",
      account: "codex-main",
      model: "gpt-5.6-sol",
      effort: "ultra",
    },
    "grok-external": {
      engine: "cursor",
      executor: "external",
      account: "cursor-main",
      model: "grok-4.5",
      effort: "high",
    },
  },
  roles: {
    designer: { instructions: "roles/designer.md", artifact_contract: "design.v1" },
  },
  profiles: {
    "claude-external": {
      worker: "opus-external",
      role: "designer",
      questions: "parent-mediated",
      overridable: ["model", "effort", "account"],
    },
    "claude-native": {
      worker: "opus-native",
      role: "designer",
      questions: "parent-mediated",
    },
    codex: { worker: "sol-external", role: "designer", questions: "direct" },
    cursor: { worker: "grok-external", role: "designer", questions: "direct" },
  },
};

const capabilities: readonly ProfileCapabilityRow[] = [
  {
    engine: "claude",
    accountId: "claude-main",
    model: "opus",
    efforts: ["high", "xhigh"],
    executionModes: ["external"],
  },
  {
    engine: "claude",
    model: "opus",
    efforts: ["high"],
    executionModes: ["native"],
  },
  {
    engine: "codex",
    accountId: "codex-main",
    model: "gpt-5.6-sol",
    efforts: ["ultra"],
    executionModes: ["external"],
  },
  {
    engine: "cursor",
    accountId: "cursor-main",
    model: "grok-4.5",
    efforts: ["high"],
    executionModes: ["external"],
  },
];

export function resolveEvidenceProfile(
  profileId: string,
  invocationOverrides?: ProfileInvocationOverrides,
) {
  return resolveProfile({
    profileId,
    documents: [
      {
        layer: "global-defaults",
        sourcePath: "/config/profiles/defaults.yaml",
        values,
      },
    ],
    capabilities,
    ...(invocationOverrides !== undefined ? { invocationOverrides } : {}),
  });
}
