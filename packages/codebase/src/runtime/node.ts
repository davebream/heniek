import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ClockPort,
  CodebaseFileSystem,
  GitPort,
  GitRemoteObservation,
  HashPort,
  IdPort,
} from "../types.js";

const execFile = promisify(execFileCallback);

async function git(path: string, args: readonly string[]): Promise<string | null> {
  try {
    const result = await execFile("git", ["-C", path, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

export function createNodeFileSystem(): CodebaseFileSystem {
  return {
    realpath,
    readText: (path) => readFile(path, "utf8"),
    async list(path) {
      const entries = await readdir(path, { withFileTypes: true });
      return Promise.all(
        entries.map(async (entry) => {
          const entryPath = resolve(path, entry.name);
          const metadata = entry.isSymbolicLink()
            ? await stat(entryPath).catch(() => undefined)
            : entry;
          return {
            name: entry.name,
            path: entryPath,
            directory: metadata?.isDirectory() ?? false,
          };
        }),
      );
    },
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async writeTextAtomic(path, content) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    },
  };
}

export function createNodeHashPort(): HashPort {
  return { sha256: (value) => createHash("sha256").update(value).digest("hex") };
}

export function createSystemClock(): ClockPort {
  return { nowIso: () => new Date().toISOString() };
}

export function createRandomIdPort(): IdPort {
  return {
    next: (prefix: "cb" | "repo" | "proposal") => `${prefix}-${randomBytes(16).toString("hex")}`,
  };
}

export function createNodeGitPort(): GitPort {
  return {
    async inspect(inputPath) {
      const rootOutput = await git(inputPath, ["rev-parse", "--show-toplevel"]);
      if (rootOutput === null || rootOutput === "") return null;
      const path = await realpath(rootOutput);
      const commonOutput = await git(path, ["rev-parse", "--git-common-dir"]);
      if (commonOutput === null) return null;
      const gitCommonDirectory = await realpath(
        isAbsolute(commonOutput) ? commonOutput : resolve(path, commonOutput),
      );
      const remoteOutput = await git(path, ["remote"]);
      const names =
        remoteOutput === null || remoteOutput === ""
          ? []
          : remoteOutput.split(/\r?\n/).filter(Boolean).sort();
      const remotes: GitRemoteObservation[] = [];
      for (const name of names) {
        const fetchUrl = await git(path, ["remote", "get-url", name]);
        const pushUrl = await git(path, ["remote", "get-url", "--push", name]);
        const head = await git(path, [
          "symbolic-ref",
          "--quiet",
          "--short",
          `refs/remotes/${name}/HEAD`,
        ]);
        remotes.push({
          name,
          fetchUrl,
          pushUrl,
          defaultBranch: head?.startsWith(`${name}/`) ? head.slice(name.length + 1) : null,
        });
      }
      const defaultRemote = names.includes("origin") ? "origin" : (names[0] ?? null);
      const defaultBranch =
        remotes.find((remote) => remote.name === defaultRemote)?.defaultBranch ?? null;
      const filesOutput = await git(path, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      const visibleFiles =
        filesOutput === null || filesOutput === ""
          ? []
          : filesOutput.split("\0").filter(Boolean).sort();
      return { path, gitCommonDirectory, remotes, defaultRemote, defaultBranch, visibleFiles };
    },
  };
}
