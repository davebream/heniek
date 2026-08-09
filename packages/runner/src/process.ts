/**
 * Detached process-group spawn and SIGTERM→SIGKILL cleanup for command stages.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { asAttemptId } from "./brands.js";
import type { StageRunnerCleanupReport } from "./types.js";

export interface SpawnCommandInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly runtimeDirectory: string;
}

export interface SpawnCommandHandle {
  readonly pid: number;
  readonly processGroupId: number;
  readonly child: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export async function spawnCommand(input: SpawnCommandInput): Promise<SpawnCommandHandle> {
  if (input.argv.length === 0) {
    throw new Error("command argv must be non-empty");
  }
  await mkdir(input.runtimeDirectory, { recursive: true, mode: 0o700 });
  const stdoutPath = join(input.runtimeDirectory, "stdout.log");
  const stderrPath = join(input.runtimeDirectory, "stderr.log");
  const stdout = createWriteStream(stdoutPath, { mode: 0o600 });
  const stderr = createWriteStream(stderrPath, { mode: 0o600 });

  const executable = input.argv[0];
  if (executable === undefined) {
    throw new Error("command argv must be non-empty");
  }
  const child = spawn(executable, input.argv.slice(1), {
    cwd: input.cwd,
    env: { ...input.env },
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (child.pid === undefined) {
    stdout.destroy();
    stderr.destroy();
    throw new Error("failed to spawn command: no pid");
  }

  if (child.stdout !== null) child.stdout.pipe(stdout);
  else stdout.end();
  if (child.stderr !== null) child.stderr.pipe(stderr);
  else stderr.end();

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      stdout.end();
      stderr.end();
      resolve({ code, signal });
    });
  });

  // Detached on unix: the child is its own session/process-group leader.
  const processGroupId = child.pid;
  return { pid: child.pid, processGroupId, child, exit };
}

export interface TerminateProcessGroupInput {
  readonly attemptId: string;
  readonly processGroupId: number;
  readonly gracePeriodMs: number;
  readonly nowIso: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
}

function processGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the group still exists but we lack permission to signal it.
    if (code === "EPERM") return true;
    return false;
  }
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Sends SIGTERM to the process group, waits `gracePeriodMs`, then SIGKILL.
 * Proves cleanup by checking `kill(-pgid, 0)` throws ESRCH.
 */
export async function terminateProcessGroup(
  input: TerminateProcessGroupInput,
): Promise<StageRunnerCleanupReport> {
  const sleep = input.sleep ?? defaultSleep;
  const signalSequence: Array<"SIGTERM" | "SIGKILL"> = [];

  if (processGroupAlive(input.processGroupId)) {
    try {
      process.kill(-input.processGroupId, "SIGTERM");
      signalSequence.push("SIGTERM");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        // Continue to SIGKILL attempt / liveness proof.
      }
    }
  }

  if (processGroupAlive(input.processGroupId) && input.gracePeriodMs > 0) {
    await sleep(input.gracePeriodMs);
  }

  if (processGroupAlive(input.processGroupId)) {
    try {
      process.kill(-input.processGroupId, "SIGKILL");
      signalSequence.push("SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        // Fall through to the liveness check.
      }
    }
    // Brief settle so the kernel reaps the group before we probe.
    await sleep(Math.min(50, Math.max(10, Math.floor(input.gracePeriodMs / 10) || 10)));
  }

  const alive = processGroupAlive(input.processGroupId);
  const cleaned = !alive;
  return {
    schemaVersion: 1,
    attemptId: asAttemptId(input.attemptId),
    processGroupId: input.processGroupId,
    signalSequence,
    descendantsRemaining: alive ? 1 : 0,
    gracePeriodMs: input.gracePeriodMs,
    cleaned,
    recordedAt: input.nowIso(),
    ...(cleaned ? {} : { detail: "process group still alive after SIGKILL" }),
  };
}
