import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class UnsafeExecutionWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeExecutionWorkspaceError";
  }
}

function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\0") &&
    !path.split(/[\\/]/u).some((segment) => segment === ".." || segment === "")
  );
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate)
        throw new UnsafeExecutionWorkspaceError("artifact parent does not exist");
      candidate = parent;
    }
  }
}

export interface ValidatedExecutionWorkspace {
  readonly worktree: string;
  readonly workingDirectory: string;
  readonly artifactPaths: readonly string[];
}

/** Canonicalizes paths and proves every declared output stays inside the assigned worktree. */
export async function validateExecutionWorkspace(input: {
  readonly assignedWorktree: string;
  readonly workingDirectory: string;
  readonly artifactPaths: readonly string[];
}): Promise<ValidatedExecutionWorkspace> {
  const worktree = await realpath(input.assignedWorktree);
  const workingDirectory = await realpath(input.workingDirectory);
  if (workingDirectory !== worktree) {
    throw new UnsafeExecutionWorkspaceError(
      "backend working directory does not match its worktree",
    );
  }
  for (const artifactPath of input.artifactPaths) {
    if (!safeRelativePath(artifactPath)) {
      throw new UnsafeExecutionWorkspaceError("artifact path is not a safe relative path");
    }
    const absolute = resolve(worktree, artifactPath);
    if (!isWithin(worktree, absolute)) {
      throw new UnsafeExecutionWorkspaceError("artifact path escapes the assigned worktree");
    }
    const ancestor = await nearestExistingAncestor(absolute);
    const canonicalAncestor = await realpath(ancestor);
    if (!isWithin(worktree, canonicalAncestor)) {
      throw new UnsafeExecutionWorkspaceError("artifact path escapes through a symbolic link");
    }
  }
  return Object.freeze({ worktree, workingDirectory, artifactPaths: [...input.artifactPaths] });
}

export interface WorkspaceGitState {
  readonly head: string;
  readonly indexTree: string;
  readonly trackedPatchHash: string;
  readonly untracked: readonly { readonly path: string; readonly hash: string }[];
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function captureWorkspaceGitState(worktree: string): Promise<WorkspaceGitState> {
  const canonical = await realpath(worktree);
  const [head, indexTree, trackedPatch, untrackedOutput] = await Promise.all([
    git(canonical, ["rev-parse", "HEAD"]),
    git(canonical, ["write-tree"]),
    git(canonical, ["diff", "--binary", "HEAD", "--"]),
    git(canonical, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const untracked = await Promise.all(
    untrackedOutput
      .split("\0")
      .filter((path) => path.length > 0)
      .sort()
      .map(async (path) => {
        const absolute = resolve(canonical, path);
        const stat = await lstat(absolute);
        const bytes = stat.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute);
        return { path, hash: digest(bytes) };
      }),
  );
  return Object.freeze({
    head: head.trim(),
    indexTree: indexTree.trim(),
    trackedPatchHash: digest(trackedPatch),
    untracked: Object.freeze(untracked),
  });
}

export function assertReadonlyWorkspaceUnchanged(
  before: WorkspaceGitState,
  after: WorkspaceGitState,
): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new UnsafeExecutionWorkspaceError("read-only execution mutated its assigned worktree");
  }
}
