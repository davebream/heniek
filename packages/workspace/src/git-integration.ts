import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitIntegrationAdapter {
  readRefSha(checkoutPath: string, ref: string): Promise<string>;
  importCommit?(checkoutPath: string, sourceCheckoutPath: string, sha: string): Promise<void>;
  prepareMergeCandidate(input: {
    checkoutPath: string;
    sourceSha: string;
    targetSha: string;
    message?: string;
  }): Promise<
    | { status: "prepared"; candidateSha: string }
    | { status: "already_applied"; candidateSha: string }
    | { status: "conflict"; detail: string }
  >;
  updateRefCompareAndSwap(input: {
    checkoutPath: string;
    ref: string;
    expectedSha: string;
    newSha: string;
  }): Promise<{ status: "updated" } | { status: "stale"; actualSha: string }>;
}

interface GitExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGit(checkoutPath: string, args: readonly string[]): Promise<GitExecResult> {
  try {
    const result = await execFileAsync("git", ["-C", checkoutPath, ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

async function resolveCommitSha(checkoutPath: string, ref: string): Promise<string> {
  const result = await runGit(checkoutPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(sha)) {
    throw new Error(`git ref cannot be resolved: ${ref}`);
  }
  return sha;
}

async function isAncestor(checkoutPath: string, ancestor: string, descendant: string) {
  return (
    (await runGit(checkoutPath, ["merge-base", "--is-ancestor", ancestor, descendant])).code === 0
  );
}

export function createLocalGitIntegrationAdapter(): GitIntegrationAdapter {
  return {
    async readRefSha(checkoutPath, ref) {
      return await resolveCommitSha(checkoutPath, ref);
    },

    async importCommit(checkoutPath, sourceCheckoutPath, sha) {
      try {
        await resolveCommitSha(checkoutPath, sha);
        return;
      } catch {
        // Isolated clones do not share objects with the canonical checkout.
      }
      const result = await runGit(checkoutPath, [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        sourceCheckoutPath,
        sha,
      ]);
      if (result.code !== 0) {
        throw new Error(
          `git candidate import failed: ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      await resolveCommitSha(checkoutPath, sha);
    },

    async prepareMergeCandidate(input) {
      const sourceSha = await resolveCommitSha(input.checkoutPath, input.sourceSha);
      const targetSha = await resolveCommitSha(input.checkoutPath, input.targetSha);
      if (sourceSha === targetSha || (await isAncestor(input.checkoutPath, sourceSha, targetSha))) {
        return { status: "already_applied", candidateSha: targetSha };
      }
      if (await isAncestor(input.checkoutPath, targetSha, sourceSha)) {
        return { status: "prepared", candidateSha: sourceSha };
      }
      const merge = await runGit(input.checkoutPath, [
        "merge-tree",
        "--write-tree",
        targetSha,
        sourceSha,
      ]);
      if (merge.code !== 0) {
        return {
          status: "conflict",
          detail: (merge.stderr.trim() || merge.stdout.trim() || "merge-tree conflict").slice(
            0,
            1024,
          ),
        };
      }
      const treeSha = merge.stdout.trim().split("\n")[0]?.trim();
      if (treeSha === undefined || treeSha.length === 0) {
        return { status: "conflict", detail: "merge-tree produced no tree oid" };
      }
      const message =
        input.message ?? `Integrate ${sourceSha.slice(0, 7)} into ${targetSha.slice(0, 7)}`;
      const commit = await runGit(input.checkoutPath, [
        "commit-tree",
        treeSha,
        "-p",
        targetSha,
        "-p",
        sourceSha,
        "-m",
        message,
      ]);
      const candidateSha = commit.stdout.trim();
      if (commit.code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(candidateSha)) {
        throw new Error(`git commit-tree failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
      }
      return { status: "prepared", candidateSha };
    },

    async updateRefCompareAndSwap(input) {
      const result = await runGit(input.checkoutPath, [
        "update-ref",
        input.ref,
        input.newSha,
        input.expectedSha,
      ]);
      if (result.code === 0) return { status: "updated" };
      return { status: "stale", actualSha: await resolveCommitSha(input.checkoutPath, input.ref) };
    },
  };
}
