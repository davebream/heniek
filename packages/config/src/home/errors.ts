/**
 * Machine-readable error codes for application-home resolution failures
 * (design §2.2). A closed union rather than a bare string, so callers that
 * branch on `code` get exhaustiveness checking.
 */
export type ApplicationHomeResolutionErrorCode =
  | "home.override-not-absolute"
  | "home.override-invalid"
  | "home.user-directory-invalid";

/**
 * Thrown by `resolveApplicationHome`/`readApplicationHomeSource` when the
 * inputs cannot be resolved deterministically (an invalid `HENIEK_HOME`
 * override, or an unusable `homeDirectory`). The message names the offending
 * variable and the violated rule, never the observed value — a `HENIEK_HOME`
 * or `XDG_*` value could itself be sensitive (an operator's home directory
 * layout, a path revealing local infrastructure), so it must never appear in
 * an error that could be logged or surfaced (house rule; see
 * `packages/conformance/src/smoke/env.ts`).
 */
export class ApplicationHomeResolutionError extends Error {
  constructor(
    readonly code: ApplicationHomeResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApplicationHomeResolutionError";
  }
}
