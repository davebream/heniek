import type {
  RepositoryWorkspacePolicy,
  VerifyCheckV1,
  WorkspaceConfigurationV1,
  WorkspaceConfigurationV2,
} from "@heniek/contracts";
import { parse, stringify } from "yaml";
import { CodebaseError } from "../errors.js";
import type { CodebaseFileSystem, HashPort } from "../types.js";
import { canonicalJson } from "./digest.js";

export const DEFAULT_POLICY_LEASE = {
  ttlMilliseconds: 300_000,
  renewEveryMilliseconds: 60_000,
} as const;

export interface PolicyStoreDeps {
  readonly fs: CodebaseFileSystem;
  readonly hash: HashPort;
  readonly codebasesDirectory: string;
}

export function policyDirectory(codebasesDirectory: string, codebaseId: string): string {
  return `${codebasesDirectory}/${codebaseId}/policies`;
}

export function policyPath(
  codebasesDirectory: string,
  codebaseId: string,
  repositoryId: string,
): string {
  return `${policyDirectory(codebasesDirectory, codebaseId)}/${repositoryId}.yaml`;
}

export function proposalDirectory(codebasesDirectory: string, codebaseId: string): string {
  return `${codebasesDirectory}/${codebaseId}/onboarding/proposals`;
}

export function proposalPath(
  codebasesDirectory: string,
  codebaseId: string,
  proposalId: string,
): string {
  return `${proposalDirectory(codebasesDirectory, codebaseId)}/${proposalId}.json`;
}

export async function storeRepositoryPolicy(
  deps: PolicyStoreDeps,
  policy: RepositoryWorkspacePolicy,
): Promise<void> {
  const directory = policyDirectory(deps.codebasesDirectory, policy.codebaseId);
  const path = policyPath(deps.codebasesDirectory, policy.codebaseId, policy.repositoryId);
  await deps.fs.mkdir(directory);
  await deps.fs.writeTextAtomic(path, stringify(policy, { sortMapEntries: true }));
}

export async function loadRepositoryPolicy(
  deps: Pick<PolicyStoreDeps, "fs" | "codebasesDirectory">,
  codebaseId: string,
  repositoryId: string,
): Promise<RepositoryWorkspacePolicy | undefined> {
  const path = policyPath(deps.codebasesDirectory, codebaseId, repositoryId);
  if (!(await deps.fs.exists(path))) return undefined;
  return parse(await deps.fs.readText(path)) as RepositoryWorkspacePolicy;
}

export async function loadCodebasePolicies(
  deps: Pick<PolicyStoreDeps, "fs" | "codebasesDirectory">,
  codebaseId: string,
): Promise<RepositoryWorkspacePolicy[]> {
  const directory = policyDirectory(deps.codebasesDirectory, codebaseId);
  if (!(await deps.fs.exists(directory))) return [];
  const policies: RepositoryWorkspacePolicy[] = [];
  for (const entry of (await deps.fs.list(directory))
    .filter((candidate) => !candidate.directory && candidate.name.endsWith(".yaml"))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    policies.push(parse(await deps.fs.readText(entry.path)) as RepositoryWorkspacePolicy);
  }
  return policies;
}

export function resolveVerifyChecksFromPolicy(policy: RepositoryWorkspacePolicy): VerifyCheckV1[] {
  return policy.scripts.verify.map((check) => ({ ...check }));
}

export interface PolicyWorkspaceBase {
  readonly remote: string;
  readonly branch: string;
}

export interface PolicyWorkspaceOptions {
  readonly base: PolicyWorkspaceBase;
  readonly synchronization?: WorkspaceConfigurationV2["synchronization"];
  readonly lease?: WorkspaceConfigurationV2["lease"];
}

/** V2 configuration used for provisioning and verify resolution. */
export function policyToWorkspaceConfigurationV2(
  policy: RepositoryWorkspacePolicy,
  options: PolicyWorkspaceOptions,
): WorkspaceConfigurationV2 {
  return {
    schemaVersion: 2,
    strategy: "managed-worktree",
    base: options.base,
    synchronization: options.synchronization ?? { strategy: "notify" },
    files: { copy: [...policy.files.copy] },
    scripts: {
      setup: policy.scripts.setup,
      verify: resolveVerifyChecksFromPolicy(policy),
    },
    lease: options.lease ?? { ...DEFAULT_POLICY_LEASE },
  };
}

/** V1-compatible setup-only configuration for callers that still require V1. */
export function policyToWorkspaceConfigurationV1(
  policy: RepositoryWorkspacePolicy,
  options: PolicyWorkspaceOptions,
): WorkspaceConfigurationV1 {
  return {
    schemaVersion: 1,
    strategy: "managed-worktree",
    base: options.base,
    synchronization: options.synchronization ?? { strategy: "notify" },
    files: { copy: [...policy.files.copy] },
    scripts: { setup: policy.scripts.setup },
    lease: options.lease ?? { ...DEFAULT_POLICY_LEASE },
  };
}

export function workspaceConfigurationDigest(
  hash: HashPort,
  configuration: WorkspaceConfigurationV1 | WorkspaceConfigurationV2,
): string {
  return hash.sha256(canonicalJson(configuration));
}

export async function findProposalFile(
  deps: Pick<PolicyStoreDeps, "fs" | "codebasesDirectory">,
  proposalId: string,
): Promise<{ codebaseId: string; path: string } | undefined> {
  if (!(await deps.fs.exists(deps.codebasesDirectory))) return undefined;
  for (const entry of (await deps.fs.list(deps.codebasesDirectory))
    .filter((candidate) => candidate.directory)
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const path = proposalPath(deps.codebasesDirectory, entry.name, proposalId);
    if (await deps.fs.exists(path)) return { codebaseId: entry.name, path };
  }
  return undefined;
}

export async function requireProposalFile(
  deps: Pick<PolicyStoreDeps, "fs" | "codebasesDirectory">,
  proposalId: string,
): Promise<{ codebaseId: string; path: string }> {
  const found = await findProposalFile(deps, proposalId);
  if (found === undefined) {
    throw new CodebaseError(
      "PROPOSAL_NOT_FOUND",
      `Onboarding proposal ${proposalId} was not found.`,
    );
  }
  return found;
}
