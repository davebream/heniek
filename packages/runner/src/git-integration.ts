/**
 * Local Git integration adapter — operates only under a workspace checkout.
 * All `git` invocations use `shell: false`.
 */

import { spawn } from "node:child_process";

export interface GitIntegrationAdapter {
  readRefSha(checkoutPath: string, ref: string): Promise<string>;
  prepareMergeCandidate(input: {
    checkoutPath: string;
    sourceSha: string;
    targetSha: string;
    message?: string;
  }): Promise<
    | { status: "prepared"; candidateSha: string }
    | { status: "conflict"; detail: string }
    | { status: "already_applied"; candidateSha: string }
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
  return await new Promise<GitExecResult>((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: checkoutPath,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function resolveCommitSha(checkoutPath: string, rev: string): Promise<string> {
  const result = await runGit(checkoutPath, ["rev-parse", "--verify", `${rev}^{commit}`]);
  if (result.code !== 0) {
    throw new Error(
      `git rev-parse failed for ${rev}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`git rev-parse returned non-sha output for ${rev}`);
  }
  return sha;
}

async function isAncestor(
  checkoutPath: string,
  ancestorSha: string,
  descendantSha: string,
): Promise<boolean> {
  const result = await runGit(checkoutPath, [
    "merge-base",
    "--is-ancestor",
    ancestorSha,
    descendantSha,
  ]);
  return result.code === 0;
}

export function createLocalGitIntegrationAdapter(): GitIntegrationAdapter {
  return {
    async readRefSha(checkoutPath, ref) {
      return await resolveCommitSha(checkoutPath, ref);
    },

    async prepareMergeCandidate(input) {
      const sourceSha = await resolveCommitSha(input.checkoutPath, input.sourceSha);
      const targetSha = await resolveCommitSha(input.checkoutPath, input.targetSha);

      if (sourceSha === targetSha) {
        return { status: "already_applied", candidateSha: targetSha };
      }

      if (await isAncestor(input.checkoutPath, sourceSha, targetSha)) {
        return { status: "already_applied", candidateSha: targetSha };
      }

      // Fast-forward: target is already an ancestor of source.
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
        const detail =
          merge.stderr.trim() ||
          merge.stdout.trim() ||
          "merge-tree reported a conflict while preparing the candidate";
        return { status: "conflict", detail: detail.slice(0, 1024) };
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
      if (commit.code !== 0) {
        throw new Error(`git commit-tree failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
      }
      const candidateSha = commit.stdout.trim();
      if (!/^[0-9a-f]{40}$/u.test(candidateSha)) {
        throw new Error("git commit-tree returned a non-sha candidate");
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
      if (result.code === 0) {
        return { status: "updated" };
      }
      const actualSha = await resolveCommitSha(input.checkoutPath, input.ref);
      return { status: "stale", actualSha };
    },
  };
}
