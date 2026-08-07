export type CodebaseErrorCode =
  | "NO_REPOSITORIES"
  | "AMBIGUOUS_REGISTRATION"
  | "TOPOLOGY_CHANGED"
  | "REGISTRATION_NOT_CONFIRMED"
  | "REGISTRATION_FILE_CONFLICT"
  | "INVALID_INSTRUCTION_LOCATION"
  | "RUN_INSTRUCTIONS_MISSING"
  | "RUN_INSTRUCTIONS_BLOCKED";

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
