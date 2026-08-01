import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APPLICATION_HOME_DIRECTORY_ENTRIES,
  APPLICATION_HOME_LAYOUT,
  type ApplicationHomeEntry,
} from "../src/home/layout.js";

// C4: extracted from the literal spec source rather than hand-copied, so a
// shared divergence between this test's expectations and §7 itself (not
// just a typo in one or the other) is still caught. Anchors on the fenced
// ```text block under "## 7. Global application home" specifically, not the
// whole document, so an unrelated tree-shaped code block elsewhere in the
// spec cannot be mistaken for it.
const SPEC_PATH = fileURLToPath(
  new URL("../../../docs/product/product-spec-v0.2.md", import.meta.url),
);
const SPEC_TEXT = readFileSync(SPEC_PATH, "utf8");
const SECTION_7_START = SPEC_TEXT.indexOf("## 7. Global application home");
const SECTION_7_END = SPEC_TEXT.indexOf("## 8. Configuration model", SECTION_7_START);
if (SECTION_7_START === -1 || SECTION_7_END === -1) {
  throw new Error(
    "Could not locate spec §7's canonical-layout section for C4's literal-tree check.",
  );
}
const SECTION_7_TEXT = SPEC_TEXT.slice(SECTION_7_START, SECTION_7_END);
const CANONICAL_TREE_MATCH = /```text\n([\s\S]*?)\n```/.exec(SECTION_7_TEXT);
if (CANONICAL_TREE_MATCH === null) {
  throw new Error(
    "Could not locate spec §7's fenced canonical-layout tree for C4's literal-tree check.",
  );
}
const CANONICAL_TREE_TEXT = CANONICAL_TREE_MATCH[1] ?? "";

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

  // C4: re-anchors directory names and the four named leaf files against the
  // literal §7 ASCII tree extracted from the spec above, rather than only
  // against `EXPECTED_LAYOUT` (a table hand-copied from the same spec, which
  // would not catch a divergence shared by both).
  describe("re-anchored against the literal §7 tree (C4)", () => {
    const directoryNames = [
      "config/",
      "accounts/",
      "workers/",
      "roles/",
      "profiles/",
      "pipelines/",
      "codebases/",
      "workspaces/",
      "artifacts/",
      "logs/",
      "exports/",
      "backups/",
      "runtimes/",
      "runtime/",
    ];
    it.each(directoryNames)("the spec's literal tree names directory %s", (name) => {
      expect(CANONICAL_TREE_TEXT).toContain(name);
    });

    const namedLeaves = ["defaults.yaml", "state.sqlite", "daemon.sock", "daemon.pid"];
    it.each(namedLeaves)("the spec's literal tree names leaf file %s", (name) => {
      expect(CANONICAL_TREE_TEXT).toContain(name);
    });

    it("every APPLICATION_HOME_LAYOUT relative directory segment (excluding '.') appears in the literal tree", () => {
      for (const entry of Object.keys(APPLICATION_HOME_LAYOUT) as ApplicationHomeEntry[]) {
        const { relative } = APPLICATION_HOME_LAYOUT[entry];
        if (relative === "." || entry === "secretsDirectory") {
          // "." denotes the root itself, not a named segment; `secretsDirectory`
          // is design §2.3's deliberate *addition* to §7's drawing and is
          // documented as absent from the literal spec tree.
          continue;
        }
        expect(CANONICAL_TREE_TEXT).toContain(relative);
      }
    });
  });

  // D4: pins the deliberate XDG split documented on `stateDatabaseFile`/
  // `logsDirectory` in layout.ts — the database sits on the *data* root
  // (canonical application data) while logs sit on the *state* root
  // (prunable, non-canonical state data), despite the filenames suggesting
  // the reverse.
  it("D4: stateDatabaseFile sits on the data root, not the state root, despite its name", () => {
    expect(APPLICATION_HOME_LAYOUT.stateDatabaseFile.root).toBe("data");
  });

  it("D4: logsDirectory sits on the state root, not the data root", () => {
    expect(APPLICATION_HOME_LAYOUT.logsDirectory.root).toBe("state");
  });
});
