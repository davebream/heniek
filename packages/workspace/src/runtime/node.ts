import { execFile, execFileSync, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { OwnerLiveness, ProcessWitness } from "../types.js";

const exec = promisify(execFile);

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<CommandResult> {
  try {
    const result = await exec(command, [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), exitCode: 0 };
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: (value.stdout ?? "").trim(),
      stderr: (value.stderr ?? "").trim(),
      exitCode: typeof value.code === "number" ? value.code : 1,
    };
  }
}

export async function sha256File(path: string): Promise<{ sha256: string; byteLength: number }> {
  const content = await readFile(path);
  return { sha256: createHash("sha256").update(content).digest("hex"), byteLength: content.length };
}

export async function readStableRegularFile(path: string): Promise<{
  readonly content: Buffer;
  readonly mode: number;
  readonly device: number;
  readonly inode: number;
  readonly sha256: string;
  readonly byteLength: number;
}> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("source is not a regular file");
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      content.length !== after.size
    ) {
      throw new Error("source changed while it was read");
    }
    return {
      content,
      mode: after.mode,
      device: after.dev,
      inode: after.ino,
      sha256: createHash("sha256").update(content).digest("hex"),
      byteLength: content.length,
    };
  } finally {
    await handle.close();
  }
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const nodeFileSystem = {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
};

export function createNodeIdSource() {
  return { next: (prefix: string) => `${prefix}_${randomUUID()}` };
}

export function createSystemClock() {
  return { nowIso: () => new Date().toISOString() };
}

function darwinBootWitness(): string | null {
  try {
    return execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function linuxBootWitness(): string | null {
  try {
    return execFileSync("/bin/cat", ["/proc/sys/kernel/random/boot_id"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

export function createNodeOwnerLiveness(): OwnerLiveness {
  const current = process.platform === "darwin" ? darwinBootWitness() : linuxBootWitness();
  return {
    currentBootWitness: () => current,
    witnessState(bootWitness: string | null, witness: ProcessWitness) {
      if (bootWitness === null || current === null) return "unknown";
      if (bootWitness !== current) return "dead";
      try {
        process.kill(witness.kind === "process-group" ? -witness.value : witness.value, 0);
        return "alive";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return "dead";
        if (code === "EPERM") return "alive";
        return "unknown";
      }
    },
  };
}

export interface SetupProcess {
  readonly processGroupId: number;
  start(input: {
    readonly command: string;
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly logPath: string;
  }): void;
  readonly completed: Promise<{ exitCode: number; signal: string | null }>;
}

export async function createSetupProcess(): Promise<SetupProcess> {
  const supervisor = fileURLToPath(new URL("./setup-supervisor.ts", import.meta.url));
  const child = fork(supervisor, [], {
    detached: true,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const ready = await new Promise<number>((resolveReady, reject) => {
    const onMessage = (message: { type?: string; processGroupId?: number }) => {
      if (message.type === "ready" && typeof message.processGroupId === "number") {
        child.off("error", reject);
        child.off("message", onMessage);
        resolveReady(message.processGroupId);
      }
    };
    child.on("message", onMessage);
    child.once("error", reject);
  });
  const completed = new Promise<{ exitCode: number; signal: string | null }>((resolveCompleted) => {
    child.on("message", (message: { type?: string; exitCode?: number; signal?: string | null }) => {
      if (message.type === "completed") {
        resolveCompleted({ exitCode: message.exitCode ?? 1, signal: message.signal ?? null });
      }
    });
    child.once("exit", (code, signal) => resolveCompleted({ exitCode: code ?? 1, signal }));
  });
  return {
    processGroupId: ready,
    start(input) {
      child.send({ type: "start", ...input });
    },
    completed,
  };
}

export function scrubbedSetupEnvironment(stable: Record<string, string>): Record<string, string> {
  const names = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const;
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...stable };
}

export async function ensurePrivateParent(path: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
}
