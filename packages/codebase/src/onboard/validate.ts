import { basename } from "node:path";
import type { CodebaseOnboardingProposal, VerifyCheckV1 } from "@heniek/contracts";
import { isDisallowedConfigurationEntry } from "@heniek/secrets";
import { CodebaseError } from "../errors.js";

const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

const SHELL_WRAPPERS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "csh",
  "tcsh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

const SHELL_FLAG_PATTERNS = new Set(["-c", "/c", "-Command", "-EncodedCommand"]);

export function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.includes("\0") && SAFE_RELATIVE_PATH.test(path);
}

export function isShellWrapperArgv(argv: readonly string[]): boolean {
  if (argv.length === 0) return true;
  const executable = basename(argv[0] ?? "")
    .toLowerCase()
    .replace(/\.exe$/u, "");
  if (SHELL_WRAPPERS.has(executable) || SHELL_WRAPPERS.has(basename(argv[0] ?? "").toLowerCase())) {
    return true;
  }
  return argv.some((argument) => SHELL_FLAG_PATTERNS.has(argument));
}

function rejectCredentialShaped(key: string, value: unknown, context: string): void {
  if (typeof value === "string" && isDisallowedConfigurationEntry(key, value)) {
    throw new CodebaseError(
      "CREDENTIAL_SHAPED_VALUE",
      `${context} contains a credential-shaped value.`,
    );
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      rejectCredentialShaped(`${key}[${index}]`, entry, context);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [nestedKey, nested] of Object.entries(value)) {
      rejectCredentialShaped(nestedKey, nested, context);
    }
  }
}

export function assertSafeRelativePath(path: string, label: string): void {
  if (!isSafeRelativePath(path)) {
    throw new CodebaseError(
      "INVALID_PATH",
      `${label} must be a relative in-repository path without traversal.`,
    );
  }
}

export function assertVerifyCheckSafe(check: VerifyCheckV1, label: string): void {
  if (!Array.isArray(check.argv) || check.argv.length === 0) {
    throw new CodebaseError("PROPOSAL_INVALID", `${label} is missing argv.`);
  }
  if (isShellWrapperArgv(check.argv)) {
    throw new CodebaseError(
      "SHELL_WRAPPER_REJECTED",
      `${label} uses a shell wrapper or shell -c pattern.`,
    );
  }
  for (const argument of check.argv) {
    rejectCredentialShaped("argv", argument, label);
  }
  if (check.cwd !== undefined) assertSafeRelativePath(check.cwd, `${label} cwd`);
  if (check.env !== undefined) {
    for (const [key, value] of Object.entries(check.env)) {
      rejectCredentialShaped(key, value, `${label} env`);
    }
  }
}

export function assertRepositoryProposalFields(
  repository: CodebaseOnboardingProposal["repositories"][number],
  registeredRepositoryIds: ReadonlySet<string>,
): void {
  if (!registeredRepositoryIds.has(repository.repositoryId)) {
    throw new CodebaseError(
      "UNKNOWN_REPOSITORY",
      `Proposal references unknown repository ${repository.repositoryId}.`,
    );
  }
  for (const path of repository.files.copy) {
    assertSafeRelativePath(path, `Copied file for ${repository.repositoryId}`);
  }
  if (repository.scripts.verify.length === 0) {
    throw new CodebaseError(
      "PROPOSAL_INVALID",
      `Repository ${repository.repositoryId} must declare at least one verify check.`,
    );
  }
  for (const [index, check] of repository.scripts.verify.entries()) {
    assertVerifyCheckSafe(check, `Verify check ${index} for ${repository.repositoryId}`);
  }
  if (repository.evidence.length === 0) {
    throw new CodebaseError(
      "PROPOSAL_INVALID",
      `Repository ${repository.repositoryId} must include evidence.`,
    );
  }
  for (const entry of repository.evidence) {
    assertSafeRelativePath(entry.path, `Evidence path for ${repository.repositoryId}`);
  }
  rejectCredentialShaped("setup", repository.scripts.setup, `Setup for ${repository.repositoryId}`);
  rejectCredentialShaped(
    "rationale",
    repository.rationale,
    `Rationale for ${repository.repositoryId}`,
  );
  rejectCredentialShaped(
    "evidence",
    repository.evidence,
    `Evidence for ${repository.repositoryId}`,
  );
  rejectCredentialShaped("files", repository.files, `Files for ${repository.repositoryId}`);
}

export function assertProposalValid(
  proposal: Pick<
    CodebaseOnboardingProposal,
    "repositories" | "topologySha256" | "configurationBasisSha256" | "codebaseId" | "profileId"
  >,
  registeredRepositoryIds: ReadonlySet<string>,
): void {
  if (proposal.repositories.length === 0) {
    throw new CodebaseError("PROPOSAL_INVALID", "Proposal must include at least one repository.");
  }
  const seen = new Set<string>();
  for (const repository of proposal.repositories) {
    if (seen.has(repository.repositoryId)) {
      throw new CodebaseError(
        "PROPOSAL_INVALID",
        `Proposal repeats repository ${repository.repositoryId}.`,
      );
    }
    seen.add(repository.repositoryId);
    assertRepositoryProposalFields(repository, registeredRepositoryIds);
  }
  if (seen.size !== registeredRepositoryIds.size) {
    throw new CodebaseError(
      "PROPOSAL_INVALID",
      "Proposal must cover every registered repository exactly once.",
    );
  }
}
