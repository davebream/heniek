import type {
  CodebaseOnboardingProposal,
  CodebaseOnboardProposeResult,
  RegisteredCodebase,
  VerifyCheckV1,
} from "@heniek/contracts";
import { CodebaseError } from "../errors.js";
import { loadRegistrations } from "../registration.js";
import type {
  ClockPort,
  CodebaseFileSystem,
  HashPort,
  IdPort,
  RegisteredCodebase as LocalRegisteredCodebase,
} from "../types.js";
import { digestProposal } from "./digest.js";
import { proposalDirectory, proposalPath } from "./policy.js";
import { assertProposalValid } from "./validate.js";

export const DEFAULT_ONBOARDING_PROFILE = "task-owner";

export interface RepositoryOnboardingDraft {
  readonly files: { readonly copy: readonly string[] };
  readonly scripts: {
    readonly setup: string | null;
    readonly verify: readonly VerifyCheckV1[];
  };
  readonly rationale: string;
  readonly evidence: readonly CodebaseOnboardingProposal["repositories"][number]["evidence"][number][];
}

export interface AnalyzeRepositoryInput {
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly profileId: string;
}

export interface AnalyzeRepositoryContext {
  readonly repairAttempt: 0 | 1;
  readonly previousFailure?: string;
}

/** Narrow analyzer port — tests inject fakes; production wraps ExecutionBackend. */
export type AnalyzeRepository = (
  input: AnalyzeRepositoryInput,
  context: AnalyzeRepositoryContext,
) => Promise<RepositoryOnboardingDraft>;

export interface OnboardingWorktree {
  readonly path: string;
  dispose(): Promise<void>;
  isMutated(): Promise<boolean>;
}

export interface OnboardingWorktreeFactory {
  open(repositoryPath: string, repositoryId: string): Promise<OnboardingWorktree>;
}

export interface ProposeCodebaseOnboardingDeps {
  readonly fs: CodebaseFileSystem;
  readonly hash: HashPort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly codebasesDirectory: string;
  readonly analyzeRepository: AnalyzeRepository;
  readonly worktrees?: OnboardingWorktreeFactory;
}

export interface ProposeCodebaseOnboardingInput {
  readonly codebaseId: string;
  readonly profileId?: string | null;
}

function passthroughWorktrees(): OnboardingWorktreeFactory {
  return {
    async open(repositoryPath) {
      return {
        path: repositoryPath,
        async dispose() {},
        async isMutated() {
          return false;
        },
      };
    },
  };
}

function validationMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Proposal validation failed.";
}

function isValidationFailure(error: unknown): boolean {
  return (
    error instanceof CodebaseError &&
    (error.code === "PROPOSAL_INVALID" ||
      error.code === "SHELL_WRAPPER_REJECTED" ||
      error.code === "CREDENTIAL_SHAPED_VALUE" ||
      error.code === "INVALID_PATH" ||
      error.code === "UNKNOWN_REPOSITORY")
  );
}

async function analyzeAll(
  deps: ProposeCodebaseOnboardingDeps,
  registration: RegisteredCodebase | LocalRegisteredCodebase,
  profileId: string,
  context: AnalyzeRepositoryContext,
): Promise<CodebaseOnboardingProposal["repositories"]> {
  const worktrees = deps.worktrees ?? passthroughWorktrees();
  const repositories: CodebaseOnboardingProposal["repositories"] = [];
  for (const repository of registration.repositories) {
    if (repository.repositoryId === null) {
      throw new CodebaseError(
        "PROPOSAL_INVALID",
        "Registered repository is missing a repository id.",
      );
    }
    const worktree = await worktrees.open(repository.path, repository.repositoryId);
    try {
      const draft = await deps.analyzeRepository(
        {
          repositoryId: repository.repositoryId,
          repositoryPath: repository.path,
          worktreePath: worktree.path,
          profileId,
        },
        context,
      );
      if (await worktree.isMutated()) {
        throw new CodebaseError(
          "REPOSITORY_MUTATED",
          `Onboarding analysis mutated repository ${repository.repositoryId}.`,
        );
      }
      repositories.push({
        repositoryId: repository.repositoryId,
        files: { copy: [...draft.files.copy] },
        scripts: {
          setup: draft.scripts.setup,
          verify: draft.scripts.verify.map((check) => ({ ...check })),
        },
        rationale: draft.rationale,
        evidence: draft.evidence.map((entry) => ({ ...entry })),
      });
    } finally {
      await worktree.dispose();
    }
  }
  return repositories;
}

function buildProposal(
  deps: ProposeCodebaseOnboardingDeps,
  registration: RegisteredCodebase | LocalRegisteredCodebase,
  profileId: string,
  repositories: CodebaseOnboardingProposal["repositories"],
  repairAttempt: 0 | 1,
): CodebaseOnboardingProposal {
  const proposalId = deps.ids.next("proposal");
  const withoutDigest: Omit<CodebaseOnboardingProposal, "digest"> = {
    schemaVersion: 1,
    proposalId,
    codebaseId: registration.codebaseId,
    profileId,
    topologySha256: registration.topologySha256,
    configurationBasisSha256: registration.configurationSha256,
    repositories,
    createdAt: deps.clock.nowIso(),
    repairAttempt,
  };
  return {
    ...withoutDigest,
    digest: digestProposal(deps.hash, withoutDigest),
  };
}

export async function proposeCodebaseOnboarding(
  deps: ProposeCodebaseOnboardingDeps,
  input: ProposeCodebaseOnboardingInput,
): Promise<CodebaseOnboardProposeResult> {
  const profileId =
    input.profileId === undefined || input.profileId === null || input.profileId === ""
      ? DEFAULT_ONBOARDING_PROFILE
      : input.profileId;
  const registrations = await loadRegistrations(deps);
  const registration = registrations.find((entry) => entry.codebaseId === input.codebaseId);
  if (registration === undefined) {
    throw new CodebaseError(
      "CODEBASE_NOT_FOUND",
      `Codebase ${input.codebaseId} is not registered.`,
    );
  }
  const registeredIds = new Set(
    registration.repositories.map((repository) => {
      if (repository.repositoryId === null) {
        throw new CodebaseError(
          "PROPOSAL_INVALID",
          "Registered repository is missing a repository id.",
        );
      }
      return repository.repositoryId;
    }),
  );

  let repairAttempt: 0 | 1 = 0;
  let repaired = false;
  let previousFailure: string | undefined;
  let proposal: CodebaseOnboardingProposal | undefined;

  while (repairAttempt <= 1) {
    try {
      const repositories = await analyzeAll(deps, registration, profileId, {
        repairAttempt,
        ...(previousFailure === undefined ? {} : { previousFailure }),
      });
      const candidate = buildProposal(deps, registration, profileId, repositories, repairAttempt);
      assertProposalValid(candidate, registeredIds);
      proposal = candidate;
      break;
    } catch (error) {
      if (error instanceof CodebaseError && error.code === "REPOSITORY_MUTATED") throw error;
      if (!isValidationFailure(error)) throw error;
      if (repairAttempt === 1) {
        throw new CodebaseError(
          "ONBOARDING_BLOCKED",
          `Onboarding proposal remained invalid after one repair: ${validationMessage(error)}`,
        );
      }
      previousFailure = validationMessage(error);
      repairAttempt = 1;
      repaired = true;
    }
  }

  if (proposal === undefined) {
    throw new CodebaseError("ONBOARDING_BLOCKED", "Onboarding proposal could not be produced.");
  }

  const directory = proposalDirectory(deps.codebasesDirectory, registration.codebaseId);
  const path = proposalPath(deps.codebasesDirectory, registration.codebaseId, proposal.proposalId);
  await deps.fs.mkdir(directory);
  await deps.fs.writeTextAtomic(path, `${JSON.stringify(proposal, null, 2)}\n`);

  return {
    schemaVersion: 1,
    proposal,
    repaired,
  };
}
