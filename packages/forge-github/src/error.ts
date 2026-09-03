import { GitHubApiError } from "@heniek/github-client";

export type GitHubForgeErrorKind =
  | "authentication"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "stale_ref"
  | "conflict"
  | "malformed_response"
  | "transport";

export class GitHubForgeError extends Error {
  readonly requestId: string | null;
  readonly retryAfterMilliseconds: number | null;
  readonly retryable: boolean;

  constructor(
    readonly kind: GitHubForgeErrorKind,
    message: string,
    options: {
      readonly requestId?: string | null;
      readonly retryAfterMilliseconds?: number | null;
      readonly retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "GitHubForgeError";
    this.requestId = options.requestId ?? null;
    this.retryAfterMilliseconds = options.retryAfterMilliseconds ?? null;
    this.retryable = options.retryable ?? (kind === "rate_limit" || kind === "transport");
  }
}

export function forgeError(error: unknown, operation: string): GitHubForgeError {
  if (error instanceof GitHubForgeError) return error;
  if (error instanceof GitHubApiError) {
    const kind =
      error.kind === "api"
        ? "conflict"
        : error.kind === "authentication"
          ? "authentication"
          : error.kind === "permission"
            ? "permission"
            : error.kind === "not_found"
              ? "not_found"
              : error.kind === "rate_limit"
                ? "rate_limit"
                : "malformed_response";
    return new GitHubForgeError(kind, `GitHub ${operation} failed`, {
      requestId: error.requestId,
      retryAfterMilliseconds: error.retryAfterMilliseconds,
      retryable: kind === "rate_limit",
    });
  }
  return new GitHubForgeError("transport", `GitHub ${operation} transport failed`, {
    retryable: true,
  });
}

export function isGitHubForgeError(value: unknown): value is GitHubForgeError {
  return value instanceof GitHubForgeError;
}
