export type CodebaseErrorCode =
  | "NO_REPOSITORIES"
  | "AMBIGUOUS_REGISTRATION"
  | "TOPOLOGY_CHANGED"
  | "CONFIGURATION_CHANGED"
  | "REGISTRATION_NOT_CONFIRMED"
  | "REGISTRATION_FILE_CONFLICT"
  | "INVALID_INSTRUCTION_LOCATION"
  | "RUN_INSTRUCTIONS_MISSING"
  | "RUN_INSTRUCTIONS_BLOCKED"
  | "CODEBASE_NOT_FOUND"
  | "PROPOSAL_NOT_FOUND"
  | "PROPOSAL_INVALID"
  | "DIGEST_MISMATCH"
  | "REPOSITORY_MUTATED"
  | "SHELL_WRAPPER_REJECTED"
  | "CREDENTIAL_SHAPED_VALUE"
  | "INVALID_PATH"
  | "UNKNOWN_REPOSITORY"
  | "ONBOARDING_BLOCKED";

export class CodebaseError extends Error {
  readonly code: CodebaseErrorCode;
  readonly retryable: boolean;

  constructor(code: CodebaseErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "CodebaseError";
    this.code = code;
    this.retryable = retryable;
  }
}
