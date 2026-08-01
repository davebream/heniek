/**
 * The canonical application-home layout (spec §7), plus `secretsDirectory`
 * (design §2.3) — the one addition to §7's drawing, kept out of `config/`
 * (YAML), `artifacts/`, `exports/`, and `backups/` so credential material
 * can never end up in a place a config snapshot or export bundle would
 * sweep it up.
 */

export type ApplicationHomeRootCategory = "config" | "data" | "state" | "runtime";

export type ApplicationHomeEntry =
  | "configDirectory"
  | "accountsDirectory"
  | "workersDirectory"
  | "rolesDirectory"
  | "profilesDirectory"
  | "pipelinesDirectory"
  | "defaultsFile"
  | "codebasesDirectory"
  | "workspacesDirectory"
  | "artifactsDirectory"
  | "exportsDirectory"
  | "backupsDirectory"
  | "runtimesDirectory"
  | "stateDatabaseFile"
  | "secretsDirectory"
  | "logsDirectory"
  | "runtimeDirectory"
  | "daemonSocketFile"
  | "daemonPidFile";

interface ApplicationHomeLayoutEntry {
  readonly root: ApplicationHomeRootCategory;
  /** Path relative to the entry's root; `"."` denotes the root itself. */
  readonly relative: string;
}

/**
 * The single source of truth mapping each `ApplicationHomeEntry` to the root
 * category it lives under and its path relative to that root (design §2.3's
 * table, itself spec §7's canonical tree with `secretsDirectory` added).
 * `resolve.ts` builds `ApplicationHome.paths` by walking this table against
 * the resolved root paths — adding a new entry here is therefore the only
 * change needed to extend the layout.
 */
export const APPLICATION_HOME_LAYOUT: Readonly<
  Record<ApplicationHomeEntry, ApplicationHomeLayoutEntry>
> = {
  configDirectory: { root: "config", relative: "." },
  accountsDirectory: { root: "config", relative: "accounts" },
  workersDirectory: { root: "config", relative: "workers" },
  rolesDirectory: { root: "config", relative: "roles" },
  profilesDirectory: { root: "config", relative: "profiles" },
  pipelinesDirectory: { root: "config", relative: "pipelines" },
  defaultsFile: { root: "config", relative: "defaults.yaml" },

  codebasesDirectory: { root: "data", relative: "codebases" },
  workspacesDirectory: { root: "data", relative: "workspaces" },
  artifactsDirectory: { root: "data", relative: "artifacts" },
  exportsDirectory: { root: "data", relative: "exports" },
  backupsDirectory: { root: "data", relative: "backups" },
  runtimesDirectory: { root: "data", relative: "runtimes" },
  // `stateDatabaseFile` sits on the *data* root, not the *state* root,
  // despite the name (D4). This is deliberate, pinned by
  // `home-layout.test.ts`, and follows the XDG Base Directory split: per the
  // freedesktop spec, `XDG_STATE_HOME` is for "state data" in the narrower
  // sense of logs, history, and other data a user does not consider
  // important enough to be part of their canonical application data and
  // that can be pruned without real loss (which is exactly `logsDirectory`
  // below) — whereas `XDG_DATA_HOME` is for the application's actual,
  // canonical persisted data. `state.sqlite` is this application's
  // canonical operational database (spec §8.1's "Canonical operational
  // state"), so it belongs on the data root even though its filename says
  // "state".
  stateDatabaseFile: { root: "data", relative: "state.sqlite" },
  secretsDirectory: { root: "data", relative: "secrets" },

  // `logsDirectory` sits on the *state* root, not the data root (D4,
  // continued from the note above): logs are exactly the prunable,
  // non-canonical "state data" `XDG_STATE_HOME` exists for — losing them
  // does not lose any canonical application data, unlike `stateDatabaseFile`.
  logsDirectory: { root: "state", relative: "logs" },

  runtimeDirectory: { root: "runtime", relative: "." },
  daemonSocketFile: { root: "runtime", relative: "daemon.sock" },
  daemonPidFile: { root: "runtime", relative: "daemon.pid" },
};

/**
 * Entries whose relative path is `"."` (i.e. the entry *is* its root) name a
 * directory, not a file — `ensure.ts` uses this to decide which entries are
 * directories worth `mkdir`ing versus files that only need their parent
 * directory to exist.
 */
export const APPLICATION_HOME_DIRECTORY_ENTRIES: readonly ApplicationHomeEntry[] = [
  "configDirectory",
  "accountsDirectory",
  "workersDirectory",
  "rolesDirectory",
  "profilesDirectory",
  "pipelinesDirectory",
  "codebasesDirectory",
  "workspacesDirectory",
  "artifactsDirectory",
  "exportsDirectory",
  "backupsDirectory",
  "runtimesDirectory",
  "secretsDirectory",
  "logsDirectory",
  "runtimeDirectory",
];
