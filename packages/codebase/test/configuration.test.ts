import type { ConfigurationLayerDocument, JsonObject } from "@heniek/config";
import type { RegisteredCodebase, RepositoryId } from "@heniek/contracts";
import { describe, expect, it } from "vitest";
import type { BaseResolutionCommandResult, BaseResolutionGitPort } from "../src/index.js";
import { loadAndResolveCodebaseConfiguration, resolveCodebaseConfiguration } from "../src/index.js";

const SHA = "a".repeat(40);
const NOW = "2026-08-10T12:00:00.000Z";
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

function repository(
  repositoryId: string,
  name: string,
  fetchUrl = `ssh://git@example.test/acme/${name}`,
): RegisteredCodebase["repositories"][number] {
  return {
    repositoryId: repositoryId as RepositoryId,
    name,
    path: `/workspace/${name}`,
    gitCommonDirectory: `/workspace/${name}/.git`,
    remotes: [{ name: "origin", fetchUrl, pushUrl: fetchUrl, defaultBranch: "main" }],
    defaultRemote: "origin",
    defaultBranch: "main",
  };
}

function registration(repositories = [repository("repo-managed", "api")]): RegisteredCodebase {
  return {
    schemaVersion: 1,
    codebaseId: "cb-1" as RegisteredCodebase["codebaseId"],
    name: "platform",
    rootPath: "/workspace",
    sourceRepositoryPath: null,
    topologySha256: "1".repeat(64),
    repositories,
    instructionSnapshot: {
      schemaVersion: 1,
      snapshotSha256: "2".repeat(64),
      capturedAt: NOW,
      readiness: "ready",
      sources: [],
      diagnostics: [],
    },
    diagnostics: [],
    readiness: "ready",
    registeredAt: NOW,
    configurationSha256: "3".repeat(64),
  };
}

function document(
  layer: ConfigurationLayerDocument["layer"],
  values: JsonObject,
  sourcePath = `/config/${layer}.yaml`,
): ConfigurationLayerDocument {
  return { layer, sourcePath, values };
}

function managed(path = "/workspace/api", requestedRef = "auto"): JsonObject {
  return {
    expectedPath: path,
    provisioning: {
      strategy: "managed-worktree",
      remote: "origin",
      requestedRef,
      synchronization: "notify",
    },
    setup: "pnpm install",
  };
}

class GitFixture implements BaseResolutionGitPort {
  readonly calls: { path: string; args: readonly string[] }[] = [];
  readonly advertised: string[];
  readonly unauthorized: boolean;
  readonly remoteUrl: string;

  constructor(options: { advertised?: string[]; unauthorized?: boolean; remoteUrl?: string } = {}) {
    this.advertised = [...(options.advertised ?? [SHA])];
    this.unauthorized = options.unauthorized ?? false;
    this.remoteUrl = options.remoteUrl ?? "git@example.test:acme/api.git";
  }

  async run(path: string, args: readonly string[]): Promise<BaseResolutionCommandResult> {
    this.calls.push({ path, args });
    if (this.unauthorized && args[0] === "remote") return { kind: "unauthorized", stdout: "" };
    if (args[0] === "remote") return { kind: "ok", stdout: this.remoteUrl };
    if (args.includes("--symref")) {
      return { kind: "ok", stdout: `ref: refs/heads/main\tHEAD\n${SHA}\tHEAD` };
    }
    if (args[0] === "fetch") return { kind: "ok", stdout: "" };
    if (args[0] === "rev-parse") return { kind: "ok", stdout: SHA };
    if (args[0] === "ls-remote") {
      const sha = this.advertised.shift() ?? SHA;
      return { kind: "ok", stdout: `${sha}\t${args.at(-1)}` };
    }
    return { kind: "failed", stdout: "" };
  }
}

function deps(git: BaseResolutionGitPort) {
  return { git, clock: { nowIso: () => NOW }, hash: { sha256: () => "4".repeat(64) } };
}

describe("Q034 multi-root configuration", () => {
  it("resolves the checked-in multi-root configuration against its identity fixture", async () => {
    const source = await readFile(resolve(FIXTURES, "q034-multi-root-workspace.yaml"), "utf8");
    const registered = JSON.parse(
      await readFile(resolve(FIXTURES, "q034-registered-multi-root.json"), "utf8"),
    ) as RegisteredCodebase;
    const result = await loadAndResolveCodebaseConfiguration(
      {
        ...deps(new GitFixture()),
        codebasesDirectory: "/heniek/codebases",
        fs: { exists: async () => true, readText: async () => source },
      },
      { registration: registered },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.repositories).toHaveLength(4);
    expect(result.snapshot.basePins.map((pin) => pin.repositoryId)).toEqual(["repo-api"]);
  });

  it("loads application-home configuration and rejects duplicate YAML keys at source", async () => {
    const path = "/heniek/codebases/cb-1/workspace.yaml";
    const source = [
      "schemaVersion: 1",
      "codebaseId: cb-1",
      "repositories:",
      "  repo-managed:",
      "    expectedPath: /workspace/api",
      "    expectedPath: /workspace/moved",
      "    provisioning:",
      "      strategy: managed-worktree",
      "      remote: origin",
      "      requestedRef: auto",
      "      synchronization: notify",
      "    setup: null",
    ].join("\n");
    const result = await loadAndResolveCodebaseConfiguration(
      {
        ...deps(new GitFixture()),
        codebasesDirectory: "/heniek/codebases",
        fs: { exists: async () => true, readText: async () => source },
      },
      { registration: registration() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "yaml.duplicate-key",
        sourcePath: path,
        line: 6,
      }),
    );
  });

  it("supports all four strategies while resolving pins only for managed repositories", async () => {
    const repositories = [
      repository("repo-managed", "api"),
      repository("repo-current", "web"),
      repository("repo-existing", "admin"),
      repository("repo-custom", "shared"),
    ];
    const git = new GitFixture();
    const result = await resolveCodebaseConfiguration(deps(git), {
      registration: registration(repositories),
      documents: [
        document("codebase", {
          schemaVersion: 1,
          codebaseId: "cb-1",
          repositories: {
            "repo-managed": managed(),
            "repo-current": {
              expectedPath: "/workspace/web",
              provisioning: { strategy: "current-checkout" },
              setup: null,
            },
            "repo-existing": {
              expectedPath: "/workspace/admin",
              provisioning: { strategy: "existing-checkout", checkoutPath: "/checkouts/admin" },
              setup: "bundle install",
            },
            "repo-custom": {
              expectedPath: "/workspace/shared",
              provisioning: { strategy: "custom", command: "bin/provision" },
              setup: null,
            },
          },
        }),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.repositories.map((entry) => entry.repositoryId)).toEqual([
      "repo-current",
      "repo-custom",
      "repo-existing",
      "repo-managed",
    ]);
    expect(result.snapshot.basePins).toHaveLength(1);
    expect(result.snapshot.basePins[0]).toMatchObject({
      repositoryId: "repo-managed",
      requestedRef: "auto",
      resolvedRef: "refs/heads/main",
      commitSha: SHA,
    });
    expect(new Set(git.calls.map((call) => call.path))).toEqual(new Set(["/workspace/api"]));
  });

  it("applies repository through invocation precedence with exact provenance", async () => {
    const git = new GitFixture();
    const layers: ConfigurationLayerDocument["layer"][] = [
      "codebase",
      "repository",
      "pipeline-template",
      "profile-or-stage",
      "invocation-override",
    ];
    const refs = ["codebase", "repository", "pipeline", "stage", "invocation"];
    const documents = layers.map((layer, index) =>
      index === 0
        ? document(layer, {
            schemaVersion: 1,
            codebaseId: "cb-1",
            repositories: { "repo-managed": managed("/workspace/api", refs[index] ?? "") },
          })
        : document(layer, {
            repositories: {
              "repo-managed": {
                provisioning: { requestedRef: refs[index] ?? "" },
                setup: `${layer}-setup`,
              },
            },
          }),
    );
    const result = await resolveCodebaseConfiguration(deps(git), {
      registration: registration(),
      documents,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.basePins[0]?.requestedRef).toBe("invocation");
    expect(result.snapshot.repositories[0]?.setup).toBe("invocation-override-setup");
    expect(
      result.snapshot.repositories[0]?.provenance.find((entry) => entry.pointer.endsWith("/setup")),
    ).toMatchObject({
      layer: "invocation-override",
      sourcePath: "/config/invocation-override.yaml",
    });
  });

  it("fails all-or-nothing after three observations of remote movement", async () => {
    const git = new GitFixture({ advertised: ["b".repeat(40), "c".repeat(40), "d".repeat(40)] });
    const result = await resolveCodebaseConfiguration(deps(git), {
      registration: registration(),
      documents: [
        document("codebase", {
          schemaVersion: 1,
          codebaseId: "cb-1",
          repositories: { "repo-managed": managed() },
        }),
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((entry) => entry.code)).toContain("codebase.remote-moved");
    expect(git.calls.filter((call) => call.args[0] === "fetch")).toHaveLength(3);
    expect("snapshot" in result).toBe(false);
  });

  it("resolves auto through the main/master fallback without observing a checkout", async () => {
    const calls: string[][] = [];
    const git: BaseResolutionGitPort = {
      async run(_path, args) {
        calls.push([...args]);
        if (args[0] === "remote") return { kind: "ok", stdout: "git@example.test:acme/api.git" };
        if (args.includes("--symref")) return { kind: "missing", stdout: "" };
        if (args[0] === "fetch") return { kind: "ok", stdout: "" };
        if (args[0] === "rev-parse") return { kind: "ok", stdout: SHA };
        if (args.at(-1) === "refs/heads/main") return { kind: "missing", stdout: "" };
        return { kind: "ok", stdout: `${SHA}\trefs/heads/master` };
      },
    };
    const result = await resolveCodebaseConfiguration(deps(git), {
      registration: registration(),
      documents: [
        document("codebase", {
          schemaVersion: 1,
          codebaseId: "cb-1",
          repositories: { "repo-managed": managed() },
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.basePins[0]?.resolvedRef).toBe("refs/heads/master");
    expect(calls.some((args) => args[0] === "status")).toBe(false);
  });

  it("reports unauthorized access at the authored YAML location without leaking command output", async () => {
    const sourcePath = "/config/codebase.yaml";
    const source = [
      "schemaVersion: 1",
      "codebaseId: cb-1",
      "repositories:",
      "  repo-managed:",
      "    expectedPath: /workspace/api",
      "    provisioning:",
      "      strategy: managed-worktree",
      "      remote: origin",
      "      requestedRef: auto",
      "      synchronization: notify",
      "    setup: pnpm install",
    ].join("\n");
    const result = await resolveCodebaseConfiguration(
      deps(new GitFixture({ unauthorized: true })),
      {
        registration: registration(),
        documents: [
          document(
            "codebase",
            {
              schemaVersion: 1,
              codebaseId: "cb-1",
              repositories: { "repo-managed": managed() },
            },
            sourcePath,
          ),
        ],
        sourceTexts: { [sourcePath]: source },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "codebase.repository-unauthorized",
        sourcePath,
        line: 8,
        column: 15,
        pointer: "/repositories/repo-managed/provisioning/remote",
      }),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("stderr");
  });

  it("rejects credential-bearing remote URLs without retaining them", async () => {
    const result = await resolveCodebaseConfiguration(
      deps(new GitFixture({ remoteUrl: "https://alice:super-secret@example.test/acme/api.git" })),
      {
        registration: registration([
          repository("repo-managed", "api", "https://example.test/acme/api"),
        ]),
        documents: [
          document("codebase", {
            schemaVersion: 1,
            codebaseId: "cb-1",
            repositories: { "repo-managed": managed() },
          }),
        ],
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "codebase.repository-unauthorized",
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("super-secret");
  });

  it.each([
    {
      name: "moved repository",
      registration: registration(),
      repositories: { "repo-managed": managed("/workspace/renamed") },
      code: "codebase.repository-moved",
    },
    {
      name: "unknown repository",
      registration: registration(),
      repositories: { "repo-unknown": managed() },
      code: "codebase.repository-missing",
    },
    {
      name: "ambiguous remote",
      registration: registration([
        repository("repo-managed", "api", "ssh://git@example.test/acme/shared"),
        repository("repo-second", "web", "ssh://git@example.test/acme/shared"),
      ]),
      repositories: {
        "repo-managed": managed(),
        "repo-second": managed("/workspace/web"),
      },
      code: "codebase.remote-ambiguous",
    },
  ])("returns a typed diagnostic for $name", async (fixture) => {
    const result = await resolveCodebaseConfiguration(deps(new GitFixture()), {
      registration: fixture.registration,
      documents: [
        document("codebase", {
          schemaVersion: 1,
          codebaseId: "cb-1",
          repositories: fixture.repositories,
        }),
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((entry) => entry.code)).toContain(fixture.code);
  });
});

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
