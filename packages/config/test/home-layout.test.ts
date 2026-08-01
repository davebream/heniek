import { describe, expect, it } from "vitest";
import {
  APPLICATION_HOME_DIRECTORY_ENTRIES,
  APPLICATION_HOME_LAYOUT,
  type ApplicationHomeEntry,
} from "../src/home/layout.js";

/**
 * Spec §7's canonical tree, plus design §2.3's `secretsDirectory` addition,
 * expressed as `{ entry: [root, relative] }`. Kept as one flat table so a
 * missing or misplaced entry shows up as a single failing row rather than a
 * diffuse assertion failure.
 */
const EXPECTED_LAYOUT: Record<ApplicationHomeEntry, readonly [string, string]> = {
  configDirectory: ["config", "."],
  accountsDirectory: ["config", "accounts"],
  workersDirectory: ["config", "workers"],
  rolesDirectory: ["config", "roles"],
  profilesDirectory: ["config", "profiles"],
  pipelinesDirectory: ["config", "pipelines"],
  defaultsFile: ["config", "defaults.yaml"],

  codebasesDirectory: ["data", "codebases"],
  workspacesDirectory: ["data", "workspaces"],
  artifactsDirectory: ["data", "artifacts"],
  exportsDirectory: ["data", "exports"],
  backupsDirectory: ["data", "backups"],
  runtimesDirectory: ["data", "runtimes"],
  stateDatabaseFile: ["data", "state.sqlite"],
  secretsDirectory: ["data", "secrets"],

  logsDirectory: ["state", "logs"],

  runtimeDirectory: ["runtime", "."],
  daemonSocketFile: ["runtime", "daemon.sock"],
  daemonPidFile: ["runtime", "daemon.pid"],
};

const FILE_ENTRIES: readonly ApplicationHomeEntry[] = [
  "defaultsFile",
  "stateDatabaseFile",
  "daemonSocketFile",
  "daemonPidFile",
];

describe("APPLICATION_HOME_LAYOUT", () => {
  it("has exactly the entries spec §7 (plus secretsDirectory) draws, no more, no fewer", () => {
    expect(Object.keys(APPLICATION_HOME_LAYOUT).sort()).toEqual(
      Object.keys(EXPECTED_LAYOUT).sort(),
    );
  });

  it.each(Object.entries(EXPECTED_LAYOUT))(
    "maps %s to the documented root and relative path",
    (entry, [root, relative]) => {
      expect(APPLICATION_HOME_LAYOUT[entry as ApplicationHomeEntry]).toEqual({ root, relative });
    },
  );

  it("lists every directory-shaped entry (and no file-shaped entry) in APPLICATION_HOME_DIRECTORY_ENTRIES", () => {
    const directorySet = new Set(APPLICATION_HOME_DIRECTORY_ENTRIES);
    for (const entry of Object.keys(EXPECTED_LAYOUT) as ApplicationHomeEntry[]) {
      if (FILE_ENTRIES.includes(entry)) {
        expect(directorySet.has(entry)).toBe(false);
      } else {
        expect(directorySet.has(entry)).toBe(true);
      }
    }
  });

  it("secretsDirectory sits under the data root, outside config/artifacts/exports/backups", () => {
    expect(APPLICATION_HOME_LAYOUT.secretsDirectory).toEqual({ root: "data", relative: "secrets" });
  });
});
