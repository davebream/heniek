import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildInstructionSnapshot,
  createNodeFileSystem,
  createNodeGitPort,
  createNodeHashPort,
  detectCodebase,
  loadRegistrations,
  normalizeRemoteUrl,
  type RegisteredCodebase,
  registerCodebase,
} from "../src/index.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const clock = { nowIso: () => "2026-08-06T10:00:00.000Z" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heniek-codebase-"));
  roots.push(root);
  return root;
}

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", repository, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function initializeRepository(
  repository: string,
  remote = "https://user:secret@example.com/acme/repository.git?token=hidden#fragment",
): Promise<void> {
  await mkdir(repository, { recursive: true });
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.email", "fixture@example.com");
  await git(repository, "config", "user.name", "Fixture");
  await writeFile(join(repository, "README.md"), "Use pnpm.\n", "utf8");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "fixture");
  await git(repository, "remote", "add", "origin", remote);
  await git(repository, "update-ref", "refs/remotes/origin/main", "HEAD");
  await git(repository, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
}

function dependencies(registrations: readonly RegisteredCodebase[] = []) {
  return {
    fs: createNodeFileSystem(),
    git: createNodeGitPort(),
    hash: createNodeHashPort(),
    clock,
    registrations,
  };
}

describe("remote normalization", () => {
  it("strips credentials, query strings, fragments, default ports, and .git suffixes", () => {
    expect(
      normalizeRemoteUrl(
        "https://user:secret@Example.COM:443/acme/repo.git?token=secret#readme",
        "/work/repo",
      ),
    ).toBe("https://example.com/acme/repo");
    expect(normalizeRemoteUrl("git@Example.COM:acme/repo.git", "/work/repo")).toBe(
      "ssh://git@example.com/acme/repo",
    );
    expect(normalizeRemoteUrl("../bare.git", "/work/repo")).toBe("file:///work/bare");
  });
});

describe("instruction discovery and classification", () => {
  it("discovers every supported visible source, reports precedence/scope, and anchors conflicts", async () => {
    const content = new Map([
      ["/repo/README.md", "Use pnpm.\n"],
      ["/repo/docs/architecture.md", "Architecture only.\n"],
      ["/repo/AGENTS.md", "package manager: pnpm\nUse pnpm.\n"],
      ["/repo/packages/api/AGENTS.md", "package manager: yarn\n"],
      ["/repo/CLAUDE.md", "Do not use pnpm.\n"],
      ["/repo/.cursor/rules/typescript.mdc", "Preserve strict ESM TypeScript.\n"],
      ["/home/stages/build.md", "Run pnpm check.\n"],
    ]);
    const fs = {
      ...createNodeFileSystem(),
      realpath: async (path: string) => path,
      readText: async (path: string) => {
        const value = content.get(path);
        if (value === undefined) throw new Error(`missing ${path}`);
        return value;
      },
    };
    const snapshot = await buildInstructionSnapshot(
      fs,
      createNodeHashPort(),
      clock.nowIso(),
      [
        {
          path: "/repo",
          gitCommonDirectory: "/repo/.git",
          remotes: [],
          defaultRemote: null,
          defaultBranch: null,
          repositoryId: "repo-1" as RegisteredCodebase["repositories"][number]["repositoryId"],
          visibleFiles: [
            "ignored/AGENTS.md",
            "packages/api/AGENTS.md",
            ".cursor/rules/typescript.mdc",
            "docs/architecture.md",
            "CLAUDE.md",
            "AGENTS.md",
            "README.md",
          ].filter((path) => !path.startsWith("ignored/")),
        },
      ],
      [
        {
          kind: "stage",
          path: "/home/stages/build.md",
          locationPath: "stages/build.md",
        },
      ],
    );

    expect(snapshot.sources).toHaveLength(7);
    expect(snapshot.sources.at(-1)).toMatchObject({
      kind: "stage",
      precedence: 5,
      location: { kind: "application-home", path: "stages/build.md" },
    });
    expect(
      snapshot.sources.find((source) => source.location.path === "packages/api/AGENTS.md"),
    ).toMatchObject({
      scope: "packages/api",
      precedence: 2,
    });
    expect(snapshot.readiness).toBe("blocked");
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ classification: "incompatible", topic: "package manager" }),
        expect.objectContaining({
          classification: "incompatible",
          anchors: expect.arrayContaining([
            expect.objectContaining({ startLine: 2, endLine: 2 }),
            expect.objectContaining({ startLine: 1, endLine: 1 }),
          ]),
        }),
      ]),
    );
    expect(snapshot.sources.every((source) => /^[a-f0-9]{64}$/.test(source.contentSha256))).toBe(
      true,
    );
  });

  it("keeps identical guidance additive and blocks conservative topic overlap", async () => {
    const make = async (left: string, right: string) =>
      buildInstructionSnapshot(
        {
          ...createNodeFileSystem(),
          readText: async (path: string) => (path.endsWith("AGENTS.md") ? left : right),
        },
        createNodeHashPort(),
        clock.nowIso(),
        [
          {
            path: "/repo",
            gitCommonDirectory: "/repo/.git",
            remotes: [],
            defaultRemote: null,
            defaultBranch: null,
            repositoryId: "repo-1" as RegisteredCodebase["repositories"][number]["repositoryId"],
            visibleFiles: ["AGENTS.md", "CLAUDE.md"],
          },
        ],
      );
    await expect(make("Use pnpm.\n", "Use pnpm.\n")).resolves.toMatchObject({
      readiness: "ready",
      diagnostics: [expect.objectContaining({ classification: "additive" })],
    });
    await expect(
      make("Use strict ESM TypeScript.\n", "Use strict ESM JavaScript.\n"),
    ).resolves.toMatchObject({ readiness: "blocked" });
    await expect(
      make("Use pnpm.\nDo not use pnpm.\n", "Documentation only.\n"),
    ).resolves.toMatchObject({
      readiness: "blocked",
      diagnostics: [
        expect.objectContaining({
          classification: "incompatible",
          anchors: [
            expect.objectContaining({ startLine: 1 }),
            expect.objectContaining({ startLine: 2 }),
          ],
        }),
      ],
    });
  });
});

describe("repository topology and registration", () => {
  it("finds only direct-child repositories, deduplicates symlinks/worktrees, and sorts deterministically", async () => {
    const root = await temporaryRoot();
    const alpha = join(root, "alpha");
    const beta = join(root, "beta");
    await initializeRepository(alpha, "git@example.com:acme/alpha.git");
    await initializeRepository(beta, "ssh://git@example.com/acme/beta.git");
    const deep = join(root, "container", "deep");
    await initializeRepository(deep, "https://example.com/acme/deep.git");
    const alphaLink = join(root, "alpha-link");
    await symlink(alpha, alphaLink);
    const worktree = join(root, "alpha-worktree");
    await git(alpha, "worktree", "add", "--detach", worktree);

    const result = await detectCodebase(dependencies(), {
      roots: [beta, alphaLink, worktree, alpha, root],
      sourceRepositoryPath: deep,
    });
    expect(result.repositories.map((repository) => repository.path)).toEqual([
      await realpath(alpha),
      await realpath(beta),
    ]);
    expect(result.repositories.every((repository) => repository.repositoryId === null)).toBe(true);
    expect(result.registrationState).toBe("unregistered");
    expect(result.sourceRepositoryPath).toBe(await realpath(deep));
    expect(result.repositories[0]).toMatchObject({
      defaultRemote: "origin",
      defaultBranch: "main",
      remotes: [expect.objectContaining({ fetchUrl: "ssh://git@example.com/acme/alpha" })],
    });
  });

  it("allocates IDs only after confirmation and reconciles a file-first retry idempotently", async () => {
    const root = await temporaryRoot();
    const repository = join(root, "repository");
    const codebasesDirectory = join(root, "application-home", "codebases");
    await initializeRepository(repository);
    const detection = await detectCodebase(dependencies(), { roots: [repository] });
    let idCalls = 0;
    let commitCalls = 0;
    const ids = { next: (prefix: "cb" | "repo") => `${prefix}-${++idCalls}` };
    const registrationDeps = {
      ...dependencies(),
      codebasesDirectory,
      ids,
      state: {
        async commitRegistration(): Promise<void> {
          commitCalls += 1;
          if (commitCalls === 1) throw new Error("simulated database crash");
        },
      },
    };

    expect(idCalls).toBe(0);
    await expect(
      registerCodebase(registrationDeps, {
        roots: [repository],
        expectedTopologySha256: detection.topologySha256,
        confirmed: true,
      }),
    ).rejects.toThrow("simulated database crash");
    expect(idCalls).toBe(2);
    const stored = await loadRegistrations(registrationDeps);
    expect(stored).toHaveLength(1);

    const retried = await registerCodebase(registrationDeps, {
      roots: [repository],
      expectedTopologySha256: detection.topologySha256,
      confirmed: true,
    });
    expect(retried.codebaseId).toBe("cb-1");
    expect(retried.repositories[0]?.repositoryId).toBe("repo-2");
    expect(idCalls).toBe(2);
    expect(commitCalls).toBe(2);
  });

  it("matches a moved repository by normalized remote and reports ambiguous evidence", async () => {
    const root = await temporaryRoot();
    const original = join(root, "original");
    const moved = join(root, "moved");
    const codebasesDirectory = join(root, "home", "codebases");
    await initializeRepository(original, "https://example.com/acme/repository.git");
    const initial = await detectCodebase(dependencies(), { roots: [original] });
    let id = 0;
    const registration = await registerCodebase(
      {
        ...dependencies(),
        codebasesDirectory,
        ids: { next: (prefix) => `${prefix}-${++id}` },
        state: { commitRegistration: async () => undefined },
      },
      {
        roots: [original],
        expectedTopologySha256: initial.topologySha256,
        confirmed: true,
      },
    );
    await rename(original, moved);
    const matched = await detectCodebase(dependencies([registration]), { roots: [moved] });
    expect(matched).toMatchObject({
      registrationState: "registered",
      codebaseId: registration.codebaseId,
      repositories: [
        expect.objectContaining({ repositoryId: "repo-2", path: await realpath(moved) }),
      ],
    });

    const duplicate = {
      ...registration,
      codebaseId: "cb-duplicate" as RegisteredCodebase["codebaseId"],
      configurationSha256: "f".repeat(64),
    };
    const ambiguous = await detectCodebase(dependencies([registration, duplicate]), {
      roots: [moved],
    });
    expect(ambiguous.registrationState).toBe("ambiguous");
    expect(ambiguous.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AMBIGUOUS_REGISTRATION", severity: "blocker" }),
    );
  });

  it("rejects TOCTOU changes and manually altered registration files", async () => {
    const root = await temporaryRoot();
    const repository = join(root, "repository");
    const codebasesDirectory = join(root, "home", "codebases");
    await initializeRepository(repository);
    const detection = await detectCodebase(dependencies(), { roots: [repository] });
    const deps = {
      ...dependencies(),
      codebasesDirectory,
      ids: { next: (prefix: "cb" | "repo") => `${prefix}-1` },
      state: { commitRegistration: async () => undefined },
    };
    await git(
      repository,
      "remote",
      "set-url",
      "origin",
      "https://example.com/changed/repository.git",
    );
    await expect(
      registerCodebase(deps, {
        roots: [repository],
        expectedTopologySha256: detection.topologySha256,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "TOPOLOGY_CHANGED", retryable: true });

    const refreshed = await detectCodebase(dependencies(), { roots: [repository] });
    const registration = await registerCodebase(deps, {
      roots: [repository],
      expectedTopologySha256: refreshed.topologySha256,
      confirmed: true,
    });
    const path = join(codebasesDirectory, registration.codebaseId, "codebase.yaml");
    await writeFile(path, `${await readFile(path, "utf8")}manual: true\n`, "utf8");
    await expect(loadRegistrations(deps)).rejects.toMatchObject({
      code: "REGISTRATION_FILE_CONFLICT",
    });
  });
});
