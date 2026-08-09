import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryId } from "@heniek/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AnalyzeRepository,
  applyCodebaseOnboarding,
  type CodebaseError,
  canonicalJson,
  createNodeFileSystem,
  createNodeHashPort,
  digestProposal,
  isShellWrapperArgv,
  loadRepositoryPolicy,
  policyToWorkspaceConfigurationV1,
  policyToWorkspaceConfigurationV2,
  proposeCodebaseOnboarding,
  type RegisteredCodebase,
  type RepositoryOnboardingDraft,
  resolveVerifyChecksFromPolicy,
} from "../src/index.js";

const roots: string[] = [];
const clock = { nowIso: () => "2026-08-10T10:00:00.000Z" };
const hash = createNodeHashPort();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heniek-onboard-"));
  roots.push(root);
  return root;
}

function repository(
  repositoryId: string,
  path: string,
): RegisteredCodebase["repositories"][number] {
  return {
    repositoryId: repositoryId as RepositoryId,
    name: repositoryId,
    path,
    gitCommonDirectory: `${path}/.git`,
    remotes: [
      {
        name: "origin",
        fetchUrl: `https://example.com/${repositoryId}`,
        pushUrl: `https://example.com/${repositoryId}`,
        defaultBranch: "main",
      },
    ],
    defaultRemote: "origin",
    defaultBranch: "main",
  };
}

function registration(
  codebasesDirectory: string,
  codebaseId: string,
  repositories: RegisteredCodebase["repositories"],
): RegisteredCodebase {
  const withoutHash = {
    schemaVersion: 1 as const,
    codebaseId: codebaseId as RegisteredCodebase["codebaseId"],
    name: "fixture",
    rootPath: codebasesDirectory,
    sourceRepositoryPath: null,
    topologySha256: "a".repeat(64),
    repositories,
    instructionSnapshot: {
      schemaVersion: 1 as const,
      snapshotSha256: "b".repeat(64),
      capturedAt: clock.nowIso(),
      readiness: "ready" as const,
      sources: [],
      diagnostics: [],
    },
    diagnostics: [],
    readiness: "ready" as const,
    registeredAt: clock.nowIso(),
  };
  return {
    ...withoutHash,
    configurationSha256: hash.sha256(canonicalJson(withoutHash)),
  };
}

async function writeRegistration(
  codebasesDirectory: string,
  value: RegisteredCodebase,
): Promise<void> {
  const directory = join(codebasesDirectory, value.codebaseId);
  await mkdir(directory, { recursive: true });
  const { stringify } = await import("yaml");
  await writeFile(join(directory, "codebase.yaml"), stringify(value, { sortMapEntries: true }));
}

function validDraft(repositoryId: string): RepositoryOnboardingDraft {
  return {
    files: { copy: [".env.example"] },
    scripts: {
      setup: "pnpm install --frozen-lockfile",
      verify: [
        {
          schemaVersion: 1,
          checkId: `${repositoryId}-check`,
          argv: ["pnpm", "check"],
          expectedExitCode: 0,
          required: true,
        },
      ],
    },
    rationale: `Detected pnpm workspace for ${repositoryId}.`,
    evidence: [
      {
        kind: "manifest",
        path: "package.json",
        detail: "packageManager pnpm",
      },
    ],
  };
}

function analyzerReturning(
  drafts: Record<string, RepositoryOnboardingDraft | RepositoryOnboardingDraft[]>,
): AnalyzeRepository {
  const counters = new Map<string, number>();
  return async (input) => {
    const entry = drafts[input.repositoryId];
    if (entry === undefined) throw new Error(`missing draft for ${input.repositoryId}`);
    if (Array.isArray(entry)) {
      const index = counters.get(input.repositoryId) ?? 0;
      counters.set(input.repositoryId, index + 1);
      const draft = entry[Math.min(index, entry.length - 1)];
      if (draft === undefined) throw new Error("empty draft sequence");
      return draft;
    }
    return entry;
  };
}

describe("onboarding validation helpers", () => {
  it("rejects shell wrappers and -c patterns", () => {
    expect(isShellWrapperArgv(["bash", "-c", "pnpm check"])).toBe(true);
    expect(isShellWrapperArgv(["/bin/sh", "-c", "true"])).toBe(true);
    expect(isShellWrapperArgv(["cmd.exe", "/c", "dir"])).toBe(true);
    expect(isShellWrapperArgv(["pnpm", "check"])).toBe(false);
    expect(isShellWrapperArgv(["node", "scripts/check.mjs"])).toBe(false);
  });
});

describe("codebase onboard propose/apply", () => {
  it("proposes across multiple repositories and applies policies atomically", async () => {
    const root = await temporaryRoot();
    const codebasesDirectory = join(root, "codebases");
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    const registered = registration(codebasesDirectory, "cb-multi", [
      repository("repo-a", repoA),
      repository("repo-b", repoB),
    ]);
    await writeRegistration(codebasesDirectory, registered);

    let proposalCount = 0;
    const ids = {
      next: (prefix: "cb" | "repo" | "proposal") => {
        if (prefix === "proposal") {
          proposalCount += 1;
          return `proposal-${proposalCount}`;
        }
        return `${prefix}-x`;
      },
    };

    const proposed = await proposeCodebaseOnboarding(
      {
        fs: createNodeFileSystem(),
        hash,
        clock,
        ids,
        codebasesDirectory,
        analyzeRepository: analyzerReturning({
          "repo-a": validDraft("repo-a"),
          "repo-b": {
            ...validDraft("repo-b"),
            files: { copy: ["docker-compose.yml"] },
          },
        }),
      },
      { codebaseId: "cb-multi" },
    );

    expect(proposed.repaired).toBe(false);
    expect(proposed.proposal.profileId).toBe("task-owner");
    expect(proposed.proposal.repositories).toHaveLength(2);
    expect(proposed.proposal.digest).toBe(digestProposal(hash, proposed.proposal));
    expect(proposed.proposal.topologySha256).toBe(registered.topologySha256);
    expect(proposed.proposal.configurationBasisSha256).toBe(registered.configurationSha256);

    const applied = await applyCodebaseOnboarding(
      {
        fs: createNodeFileSystem(),
        hash,
        clock,
        codebasesDirectory,
      },
      {
        proposalId: proposed.proposal.proposalId,
        expectedSha256: proposed.proposal.digest,
      },
    );

    expect(applied.policies).toHaveLength(2);
    const policyA = await loadRepositoryPolicy(
      { fs: createNodeFileSystem(), codebasesDirectory },
      "cb-multi",
      "repo-a",
    );
    const policyB = await loadRepositoryPolicy(
      { fs: createNodeFileSystem(), codebasesDirectory },
      "cb-multi",
      "repo-b",
    );
    expect(policyA?.files.copy).toEqual([".env.example"]);
    expect(policyB?.files.copy).toEqual(["docker-compose.yml"]);
    expect(resolveVerifyChecksFromPolicy(policyA!).map((check) => check.argv)).toEqual([
      ["pnpm", "check"],
    ]);

    const v2 = policyToWorkspaceConfigurationV2(policyA!, {
      base: { remote: "origin", branch: "main" },
    });
    expect(v2.schemaVersion).toBe(2);
    expect(v2.scripts.verify).toHaveLength(1);
    const v1 = policyToWorkspaceConfigurationV1(policyA!, {
      base: { remote: "origin", branch: "main" },
    });
    expect(v1.schemaVersion).toBe(1);
    expect(v1.scripts).toEqual({ setup: "pnpm install --frozen-lockfile" });
  });

  it("repairs malformed analyzer output once, then blocks on second failure", async () => {
    const root = await temporaryRoot();
    const codebasesDirectory = join(root, "codebases");
    const repoPath = join(root, "repo");
    await mkdir(repoPath, { recursive: true });
    const registered = registration(codebasesDirectory, "cb-repair", [
      repository("repo-1", repoPath),
    ]);
    await writeRegistration(codebasesDirectory, registered);

    const bad: RepositoryOnboardingDraft = {
      ...validDraft("repo-1"),
      scripts: {
        setup: null,
        verify: [
          {
            schemaVersion: 1,
            checkId: "shell",
            argv: ["bash", "-c", "pnpm check"],
            expectedExitCode: 0,
            required: true,
          },
        ],
      },
    };

    const ids = {
      next: (prefix: "cb" | "repo" | "proposal") =>
        prefix === "proposal" ? "proposal-repair" : `${prefix}-x`,
    };

    const repaired = await proposeCodebaseOnboarding(
      {
        fs: createNodeFileSystem(),
        hash,
        clock,
        ids,
        codebasesDirectory,
        analyzeRepository: analyzerReturning({
          "repo-1": [bad, validDraft("repo-1")],
        }),
      },
      { codebaseId: "cb-repair" },
    );
    expect(repaired.repaired).toBe(true);
    expect(repaired.proposal.repairAttempt).toBe(1);
    expect(repaired.proposal.repositories[0]?.scripts.verify[0]?.argv).toEqual(["pnpm", "check"]);

    await expect(
      proposeCodebaseOnboarding(
        {
          fs: createNodeFileSystem(),
          hash,
          clock,
          ids: {
            next: (prefix) => (prefix === "proposal" ? "proposal-blocked" : `${prefix}-x`),
          },
          codebasesDirectory,
          analyzeRepository: analyzerReturning({
            "repo-1": [bad, bad],
          }),
        },
        { codebaseId: "cb-repair" },
      ),
    ).rejects.toMatchObject({ code: "ONBOARDING_BLOCKED" } satisfies Partial<CodebaseError>);
  });

  it("rejects credential-shaped values, unsafe paths, and repository mutation", async () => {
    const root = await temporaryRoot();
    const codebasesDirectory = join(root, "codebases");
    const repoPath = join(root, "repo");
    await mkdir(repoPath, { recursive: true });
    const registered = registration(codebasesDirectory, "cb-reject", [
      repository("repo-1", repoPath),
    ]);
    await writeRegistration(codebasesDirectory, registered);

    const secretDraft: RepositoryOnboardingDraft = {
      ...validDraft("repo-1"),
      scripts: {
        setup: `ghp_${"a".repeat(36)}`,
        verify: validDraft("repo-1").scripts.verify,
      },
    };
    await expect(
      proposeCodebaseOnboarding(
        {
          fs: createNodeFileSystem(),
          hash,
          clock,
          ids: { next: (prefix) => `${prefix}-secret` },
          codebasesDirectory,
          analyzeRepository: analyzerReturning({ "repo-1": [secretDraft, secretDraft] }),
        },
        { codebaseId: "cb-reject" },
      ),
    ).rejects.toMatchObject({ code: "ONBOARDING_BLOCKED" });

    const pathDraft: RepositoryOnboardingDraft = {
      ...validDraft("repo-1"),
      files: { copy: ["../outside"] },
    };
    await expect(
      proposeCodebaseOnboarding(
        {
          fs: createNodeFileSystem(),
          hash,
          clock,
          ids: { next: (prefix) => `${prefix}-path` },
          codebasesDirectory,
          analyzeRepository: analyzerReturning({ "repo-1": [pathDraft, pathDraft] }),
        },
        { codebaseId: "cb-reject" },
      ),
    ).rejects.toMatchObject({ code: "ONBOARDING_BLOCKED" });

    await expect(
      proposeCodebaseOnboarding(
        {
          fs: createNodeFileSystem(),
          hash,
          clock,
          ids: { next: (prefix) => `${prefix}-mut` },
          codebasesDirectory,
          analyzeRepository: analyzerReturning({ "repo-1": validDraft("repo-1") }),
          worktrees: {
            async open(path) {
              return {
                path,
                async dispose() {},
                async isMutated() {
                  return true;
                },
              };
            },
          },
        },
        { codebaseId: "cb-reject" },
      ),
    ).rejects.toMatchObject({ code: "REPOSITORY_MUTATED" });
  });

  it("rejects stale topology/configuration and digest mismatches on apply", async () => {
    const root = await temporaryRoot();
    const codebasesDirectory = join(root, "codebases");
    const repoPath = join(root, "repo");
    await mkdir(repoPath, { recursive: true });
    const registered = registration(codebasesDirectory, "cb-stale", [
      repository("repo-1", repoPath),
    ]);
    await writeRegistration(codebasesDirectory, registered);

    const proposed = await proposeCodebaseOnboarding(
      {
        fs: createNodeFileSystem(),
        hash,
        clock,
        ids: { next: (prefix) => `${prefix}-stale` },
        codebasesDirectory,
        analyzeRepository: analyzerReturning({ "repo-1": validDraft("repo-1") }),
      },
      { codebaseId: "cb-stale" },
    );

    await expect(
      applyCodebaseOnboarding(
        {
          fs: createNodeFileSystem(),
          hash,
          clock,
          codebasesDirectory,
        },
        {
          proposalId: proposed.proposal.proposalId,
          expectedSha256: "f".repeat(64),
        },
      ),
    ).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });

    const staleTopology = {
      ...registered,
      topologySha256: "c".repeat(64),
    };
    const staleTopologyBody = (({ configurationSha256: _ignored, ...body }) => body)(staleTopology);
    await writeRegistration(codebasesDirectory, {
      ...staleTopologyBody,
      configurationSha256: hash.sha256(canonicalJson(staleTopologyBody)),
    });
    await expect(
      applyCodebaseOnboarding(
        {
          fs: createNodeFileSystem(),
          hash,
          clock,
          codebasesDirectory,
        },
        {
          proposalId: proposed.proposal.proposalId,
          expectedSha256: proposed.proposal.digest,
        },
      ),
    ).rejects.toMatchObject({ code: "TOPOLOGY_CHANGED" });

    await writeRegistration(codebasesDirectory, registered);
    const staleConfigurationBody = {
      ...(({ configurationSha256: _ignored, ...body }) => body)(registered),
      name: "renamed-fixture",
    };
    await writeRegistration(codebasesDirectory, {
      ...staleConfigurationBody,
      configurationSha256: hash.sha256(canonicalJson(staleConfigurationBody)),
    });
    await expect(
      applyCodebaseOnboarding(
        {
          fs: createNodeFileSystem(),
          hash,
          clock,
          codebasesDirectory,
        },
        {
          proposalId: proposed.proposal.proposalId,
          expectedSha256: proposed.proposal.digest,
        },
      ),
    ).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
  });
});
