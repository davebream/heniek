import type {
  CodebaseOnboardApplyResult,
  CodebaseOnboardingProposal,
  RepositoryWorkspacePolicy,
} from "@heniek/contracts";
import { CodebaseError } from "../errors.js";
import { loadRegistrations } from "../registration.js";
import type { ClockPort, CodebaseFileSystem, HashPort } from "../types.js";
import { digestProposal } from "./digest.js";
import { requireProposalFile, storeRepositoryPolicy } from "./policy.js";
import { assertProposalValid } from "./validate.js";

export interface ApplyCodebaseOnboardingDeps {
  readonly fs: CodebaseFileSystem;
  readonly hash: HashPort;
  readonly clock: ClockPort;
  readonly codebasesDirectory: string;
}

export interface ApplyCodebaseOnboardingInput {
  readonly proposalId: string;
  readonly expectedSha256: string;
}

export async function applyCodebaseOnboarding(
  deps: ApplyCodebaseOnboardingDeps,
  input: ApplyCodebaseOnboardingInput,
): Promise<CodebaseOnboardApplyResult> {
  const found = await requireProposalFile(deps, input.proposalId);
  const proposal = JSON.parse(await deps.fs.readText(found.path)) as CodebaseOnboardingProposal;
  if (proposal.proposalId !== input.proposalId) {
    throw new CodebaseError(
      "PROPOSAL_INVALID",
      "Stored proposal id does not match the requested proposal id.",
    );
  }

  const actualDigest = digestProposal(deps.hash, proposal);
  if (actualDigest !== proposal.digest) {
    throw new CodebaseError(
      "DIGEST_MISMATCH",
      "Stored onboarding proposal digest does not match its canonical body.",
    );
  }
  if (input.expectedSha256 !== proposal.digest) {
    throw new CodebaseError(
      "DIGEST_MISMATCH",
      "Expected proposal digest does not match the stored proposal.",
    );
  }

  const registrations = await loadRegistrations(deps);
  const registration = registrations.find((entry) => entry.codebaseId === proposal.codebaseId);
  if (registration === undefined) {
    throw new CodebaseError(
      "CODEBASE_NOT_FOUND",
      `Codebase ${proposal.codebaseId} is not registered.`,
    );
  }
  if (registration.topologySha256 !== proposal.topologySha256) {
    throw new CodebaseError(
      "TOPOLOGY_CHANGED",
      "Repository topology changed after the proposal was created; propose again.",
      true,
    );
  }
  if (registration.configurationSha256 !== proposal.configurationBasisSha256) {
    throw new CodebaseError(
      "CONFIGURATION_CHANGED",
      "Codebase configuration changed after the proposal was created; propose again.",
      true,
    );
  }

  const registeredIds = new Set(
    registration.repositories.flatMap((repository) =>
      repository.repositoryId === null ? [] : [repository.repositoryId],
    ),
  );
  assertProposalValid(proposal, registeredIds);

  const appliedAt = deps.clock.nowIso();
  const policies: RepositoryWorkspacePolicy[] = proposal.repositories.map((repository) => ({
    schemaVersion: 1,
    codebaseId: proposal.codebaseId,
    repositoryId: repository.repositoryId,
    topologySha256: proposal.topologySha256,
    configurationBasisSha256: proposal.configurationBasisSha256,
    files: { copy: [...repository.files.copy] },
    scripts: {
      setup: repository.scripts.setup,
      verify: repository.scripts.verify.map((check) => ({ ...check })),
    },
    proposalId: proposal.proposalId,
    proposalDigest: proposal.digest,
    appliedAt,
  }));

  for (const policy of policies) {
    await storeRepositoryPolicy(deps, policy);
  }

  return {
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.digest,
    codebaseId: proposal.codebaseId,
    policies,
    appliedAt,
  };
}
