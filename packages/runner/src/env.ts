/**
 * Allowlisted command environment construction.
 *
 * Never pass through `process.env` wholesale. Ambient values are copied only
 * for a fixed base set; stage-declared `env` overlays them. Credential-shaped
 * keys are never taken from the ambient environment.
 */

const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "USER",
  "LOGNAME",
] as const;

const DARWIN_EXTRA_KEYS = ["__CF_USER_TEXT_ENCODING"] as const;

/**
 * Matches credential-shaped keys well enough to refuse copying them from the
 * ambient environment. Deliberately local: `@heniek/runner` must not depend on
 * `@heniek/secrets` for this boundary.
 */
const CREDENTIAL_KEY_PATTERN =
  /(^|[._-])(password|passphrase|secret|api[_-]?key|apikey|token|bearer|credentials?)([._-]|$)/i;

export function looksLikeCredentialEnvKey(key: string): boolean {
  return CREDENTIAL_KEY_PATTERN.test(key);
}

export interface BuildCommandEnvInput {
  /** Explicit env declared on the command stage (already config-gated). */
  readonly declared?: Readonly<Record<string, string>>;
  /** Ambient source — defaults to `process.env`. Injected in tests. */
  readonly ambient?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

/** Builds the env object passed to `spawn(..., { env, shell: false })`. */
export function buildCommandEnv(input: BuildCommandEnvInput = {}): Record<string, string> {
  const ambient = input.ambient ?? process.env;
  const platform = input.platform ?? process.platform;
  const env: Record<string, string> = {};

  const keys: readonly string[] =
    platform === "darwin" ? [...BASE_ENV_KEYS, ...DARWIN_EXTRA_KEYS] : [...BASE_ENV_KEYS];

  for (const key of keys) {
    if (looksLikeCredentialEnvKey(key)) continue;
    const value = ambient[key];
    if (typeof value === "string") env[key] = value;
  }

  if (input.declared !== undefined) {
    for (const [key, value] of Object.entries(input.declared)) {
      env[key] = value;
    }
  }

  return env;
}
