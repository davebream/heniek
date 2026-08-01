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
 *
 * The path-echoing rule (D5, reconciled with `@heniek/secrets`'s
 * `store.ts`, which documents the identical rule): the no-echo discipline
 * applies specifically to *unvalidated environment input at resolution
 * time* — `HENIEK_HOME`/`XDG_*` as read from `process.env`, before this
 * module has done anything to them — because that input is
 * attacker-influenced and may itself be sensitive. It does NOT extend to a
 * home that has already been *resolved*: once `resolveApplicationHome`
 * succeeds, `home.paths`/`home.roots` are ordinary operational data, and
 * downstream errors (e.g. `ApplicationHomeEnsureError` below, or
 * `@heniek/secrets`'s `InsecureSecretStoreError` operating on a resolved
 * `secretsDirectory`) MAY name a resolved path — an unactionable "your
 * secret store is misconfigured" error, with no path to investigate, is
 * worse than the low risk of a resolved path appearing in a log.
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

/**
 * Thrown by `ensureApplicationHomeDirectories` when an underlying filesystem
 * call (`mkdir`/`lstat`/`chmod`) itself fails (M3) — e.g. `EACCES: permission
 * denied, mkdir '/opt/secret-home/config'`. The raw `fs` error's message
 * embeds the full resolved path, which is exactly what the house rule on
 * `ApplicationHomeResolutionError` above forbids surfacing (a `HENIEK_HOME`/
 * `XDG_*`-derived path can itself be sensitive). This error names the
 * *layout entry* (`secretsDirectory`, `roots.data`, …) and the *root
 * origin* instead, and preserves the original failure as `cause` for a
 * caller that legitimately needs it (structured logging with its own
 * redaction policy, a debugger) without it ever reaching a message string.
 */
export class ApplicationHomeEnsureError extends Error {
  constructor(
    readonly entry: string,
    readonly origin: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApplicationHomeEnsureError";
  }
}
