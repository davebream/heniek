import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SMOKE_AUTH_ROUTES = ["subscription", "api_key", "none"] as const;
export type SmokeAuthRoute = (typeof SMOKE_AUTH_ROUTES)[number];

export type SmokeConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly authRoute: SmokeAuthRoute;
      readonly moduleSpecifier?: string;
    };

const ENABLE_VAR = "HENIEK_CONFORMANCE_SMOKE";
const AUTH_ROUTE_VAR = "HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE";
const MODULE_VAR = "HENIEK_CONFORMANCE_SMOKE_MODULE";

function isSmokeAuthRoute(value: string | undefined): value is SmokeAuthRoute {
  return value !== undefined && (SMOKE_AUTH_ROUTES as readonly string[]).includes(value);
}

/**
 * `packages/conformance/src/smoke/env.ts` -> repo root is four directories up
 * (`smoke` -> `src` -> `conformance` -> `packages` -> repo root). Computed
 * from this module's own location rather than `process.cwd()`, so the
 * result does not depend on the working directory a caller happens to run
 * from.
 */
export function resolveRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

// A bare package specifier: an optional `@scope/` prefix, a package name
// segment, and an optional `/subpath` — the same shape Node's own resolver
// accepts for a `node_modules` lookup. Deliberately excludes `.`, `/`, and
// `:` as leading characters, which is what keeps this pattern from ever
// matching a relative path, an absolute path, or a URL.
const BARE_SPECIFIER_PATTERN =
  /^(@[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*|[a-zA-Z0-9][\w.-]*)(\/[\w./-]*)?$/;

// Matches any URL-scheme-prefixed string (`file:`, `data:`, `http:`,
// `https:`, etc.) so those are rejected outright rather than accidentally
// treated as a relative path by `node:path` (which has no concept of URL
// schemes and would otherwise happily "resolve" `file:///etc/passwd` as a
// path segment relative to the repo root).
const DISALLOWED_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isBarePackageSpecifier(specifier: string): boolean {
  return BARE_SPECIFIER_PATTERN.test(specifier);
}

/** True when `specifier`, resolved against `repoRoot`, stays inside `repoRoot`. */
function resolvesInsideRepo(specifier: string, repoRoot: string): boolean {
  const target = isAbsolute(specifier) ? resolve(specifier) : resolve(repoRoot, specifier);
  const rel = relative(repoRoot, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Validates `HENIEK_CONFORMANCE_SMOKE_MODULE` before it is ever handed to a
 * dynamic `import()` — unvalidated, this environment variable would let
 * arbitrary code execute merely by setting it. Exactly two forms are
 * accepted:
 *  - a bare package specifier (`name` or `@scope/name`, optionally with a
 *    `/subpath`);
 *  - a path (relative or absolute) that resolves inside `repoRoot`.
 * Anything else — a `file:`/`data:`/`http:`/`https:` URL, a `../` escape
 * out of the repository, or an absolute path outside it — is rejected. The
 * thrown error names the variable and the two allowed forms; it never
 * echoes the observed value, so a malformed or malicious value is never
 * reflected back into logs or error output.
 */
export function validateSmokeModuleSpecifier(specifier: string, repoRoot: string): string {
  if (DISALLOWED_SCHEME_PATTERN.test(specifier)) {
    throw new Error(smokeModuleValidationError());
  }
  if (isBarePackageSpecifier(specifier) || resolvesInsideRepo(specifier, repoRoot)) {
    return specifier;
  }
  throw new Error(smokeModuleValidationError());
}

function smokeModuleValidationError(): string {
  return (
    `${MODULE_VAR} must be either a bare package specifier ("name" or ` +
    '"@scope/name", optionally with a subpath) or a path that resolves ' +
    "inside the repository root. Refusing to import an arbitrary value."
  );
}

/**
 * Reads the opt-in smoke adapter's configuration from environment variables
 * (C2, X1). Disabled is the CI default. When enabled, the auth route must be
 * one of `SMOKE_AUTH_ROUTES` — a missing or unrecognised value throws,
 * naming only the variable and the allowed values, **never** the observed
 * value (no environment value is ever interpolated into an error message).
 * When `HENIEK_CONFORMANCE_SMOKE_MODULE` is set, it is validated by
 * `validateSmokeModuleSpecifier` before being returned — it is later handed
 * to a dynamic `import()` by `src/smoke/harness.ts`, so an unvalidated value
 * would be arbitrary-code-execution driven by an environment variable.
 */
export function readSmokeConfig(env: NodeJS.ProcessEnv = process.env): SmokeConfig {
  if (env[ENABLE_VAR] !== "1") {
    return { enabled: false };
  }

  const authRoute = env[AUTH_ROUTE_VAR];
  if (!isSmokeAuthRoute(authRoute)) {
    throw new Error(
      `${AUTH_ROUTE_VAR} must be set to one of: ${SMOKE_AUTH_ROUTES.join(", ")} when ${ENABLE_VAR}=1.`,
    );
  }

  const moduleSpecifier = env[MODULE_VAR];
  if (moduleSpecifier !== undefined) {
    validateSmokeModuleSpecifier(moduleSpecifier, resolveRepoRoot());
    return { enabled: true, authRoute, moduleSpecifier };
  }
  return { enabled: true, authRoute };
}
