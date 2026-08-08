import { join } from "node:path";

/**
 * A runtime candidate is untrusted until promotion completes. Its process
 * therefore starts from an empty environment, rather than copying the
 * caller's environment and trying to redact known credential names.
 */
const FIXED_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const NEUTRAL_NAMES = [
  "LANG",
  "LC_ALL",
  "TZ",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;
const CONTROLLED_NAMES = new Set([
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PATH",
]);
const SUBSCRIPTION_CARRIER_NAMES = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

export interface RuntimeChildEnvironmentOptions {
  readonly home: string;
  /**
   * Deliberately supplied promotion-route values. This is never populated
   * from process.env: callers must choose the exact values they expose.
   */
  readonly explicit?: NodeJS.ProcessEnv | undefined;
}

/**
 * Build the environment for an untrusted candidate or promotion runner.
 *
 * Neutral platform settings are allowlisted from the ambient process. Every
 * credential, provider routing switch, config-home override, and unknown
 * variable is absent. Only named subscription carriers can be supplied
 * explicitly. Process-home and XDG locations are always isolated and cannot
 * be overridden.
 */
export function buildRuntimeChildEnvironment(
  options: RuntimeChildEnvironmentOptions,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: FIXED_PATH };
  for (const name of NEUTRAL_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(options.explicit ?? {})) {
    if (value === undefined || CONTROLLED_NAMES.has(name)) continue;
    if (SUBSCRIPTION_CARRIER_NAMES.has(name)) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    HOME: options.home,
    XDG_CONFIG_HOME: join(options.home, ".config"),
    XDG_CACHE_HOME: join(options.home, ".cache"),
    XDG_DATA_HOME: join(options.home, ".local", "share"),
    TMPDIR: join(options.home, "tmp"),
    TMP: join(options.home, "tmp"),
    TEMP: join(options.home, "tmp"),
  };
}
