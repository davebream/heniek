import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertReadonlyWorkspaceUnchanged,
  captureWorkspaceGitState,
  UnsafeExecutionWorkspaceError,
  validateExecutionWorkspace,
} from "../src/safety.js";

const exec = promisify(execFile);
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heniek-workspace-safety-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("execution workspace safety", () => {
  it("accepts a canonical worktree and safe not-yet-created artifact parent", async () => {
    const root = await tempRoot();
    const canonical = await realpath(root);
    await expect(
      validateExecutionWorkspace({
        assignedWorktree: root,
        workingDirectory: root,
        artifactPaths: ["reports/result.md"],
      }),
    ).resolves.toMatchObject({ worktree: canonical, workingDirectory: canonical });
  });

  it("rejects traversal, a mismatched working directory, and symlink escape", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await mkdir(join(root, "safe"));
    await symlink(outside, join(root, "escape"));
    await expect(
      validateExecutionWorkspace({
        assignedWorktree: root,
        workingDirectory: root,
        artifactPaths: ["../outside.md"],
      }),
    ).rejects.toBeInstanceOf(UnsafeExecutionWorkspaceError);
    await expect(
      validateExecutionWorkspace({
        assignedWorktree: root,
        workingDirectory: outside,
        artifactPaths: ["result.md"],
      }),
    ).rejects.toThrow(/does not match/);
    await expect(
      validateExecutionWorkspace({
        assignedWorktree: root,
        workingDirectory: root,
        artifactPaths: ["escape/result.md"],
      }),
    ).rejects.toThrow(/symbolic link/);
  });

  it.each([
    [
      "HEAD",
      async (root: string) => {
        await writeFile(join(root, "tracked.txt"), "committed mutation\n");
        await exec("git", ["-C", root, "add", "tracked.txt"]);
        await exec("git", ["-C", root, "commit", "-m", "mutation"]);
      },
    ],
    [
      "index",
      async (root: string) => {
        await writeFile(join(root, "tracked.txt"), "staged mutation\n");
        await exec("git", ["-C", root, "add", "tracked.txt"]);
      },
    ],
    [
      "tracked worktree",
      async (root: string) => {
        await writeFile(join(root, "tracked.txt"), "unstaged mutation\n");
      },
    ],
    [
      "untracked worktree",
      async (root: string) => {
        await writeFile(join(root, "untracked.txt"), "created\n");
      },
    ],
  ])("detects %s mutation for read-only attempts", async (_kind, mutate) => {
    const root = await tempRoot();
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "tracked.txt"), "before\n");
    await exec("git", ["-C", root, "add", "tracked.txt"]);
    await exec("git", ["-C", root, "commit", "-m", "initial"]);
    const before = await captureWorkspaceGitState(root);
    assertReadonlyWorkspaceUnchanged(before, await captureWorkspaceGitState(root));

    await mutate(root);
    const after = await captureWorkspaceGitState(root);
    expect(() => assertReadonlyWorkspaceUnchanged(before, after)).toThrow(
      /read-only execution mutated/,
    );
  });
});
