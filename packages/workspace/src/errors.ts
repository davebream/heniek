export type WorkspaceErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_PATH"
  | "INVALID_BRANCH"
  | "INVALID_BASE"
  | "REMOTE_NOT_FOUND"
  | "REMOTE_BRANCH_NOT_FOUND"
  | "REMOTE_MOVED_DURING_FETCH"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_CONFLICT"
  | "CHECKOUT_DIRTY"
  | "CHECKOUT_CHANGED"
  | "REBASE_CONFLICT"
  | "LEASE_CONTENDED"
  | "LEASE_NOT_CURRENT"
  | "LEASE_OWNER_ALIVE"
  | "LEASE_OWNER_UNKNOWN"
  | "SETUP_FAILED"
  | "INSTRUCTION_CHANGED"
  | "TASK_REVISION_INVALID"
  | "UNDECLARED_WRITE"
  | "RECOVERY_REQUIRED";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly retryable: boolean;

  constructor(code: WorkspaceErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.retryable = retryable;
  }
}
