import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDaemonReady } from "./readiness.js";

/**
 * Lifecycle for a pinned Claudexor daemon, started for a canary run.
 *
 * The daemon home is always a fresh `mkdtemp` directory **outside the
 * repository**: it accumulates a 0600 bearer token, a journal, and run
 * artifacts, none of which may reach this repo (the issue excludes factory
 * runtime state, credentials, and transcripts).
 *
 * The bearer token is returned on the handle so the control client can use it,
 * but it is never logged and never interpolated into an error — including
 * request-failure diagnostics, which carry status and engine code only.
 *
 * Real processes and real time live here, which is legal because this file is
 * under `src/smoke/`.
 */

export interface DaemonHandle {
  readonly pid: number;
  readonly port: number;
  readonly baseUrl: string;
  readonly home: string;
  /** The daemon's bearer token. Pass straight to the control client. */
  readonly token: string;
  stop(): void;
}

export interface StartDaemonOptions {
  /** Absolute path to a built checkout of the pinned Claudexor revision. */
  readonly claudexorRoot: string;
  /**
   * When false, the daemon shares the caller's process group and inherits its
   * lifetime by default. Canary 1 runs both arms: a `detached` daemon survives
   * its parent on POSIX regardless of the engine, so a detached-only result
   * would measure the spawn flags rather than Claudexor.
   */
  readonly detached?: boolean;
  readonly readyTimeoutMs?: number;
  /** Optional pre-scrubbed environment; Q012 uses the Q004 subscription-only recipe. */
  readonly environment?: NodeJS.ProcessEnv;
}

/** Reserve an ephemeral port so concurrent canaries cannot collide. */
export async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve an ephemeral port"));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The daemon did not become ready within its deadline. */
export class DaemonStartTimeoutError extends Error {
  constructor(readonly port: number) {
    super(`claudexord did not answer /healthz on port ${port} within its deadline`);
    this.name = "DaemonStartTimeoutError";
  }
}

/**
 * Start a pinned daemon and wait until it actually answers `/healthz`.
 *
 * Readiness is never inferred from the daemon log: the log is not truncated
 * between daemons, so a stale `control-api listening` line reads as ready
 * while nothing is listening.
 */
export async function startDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
  const { claudexorRoot, detached = true, readyTimeoutMs = 60_000 } = options;
  const entry = join(claudexorRoot, "packages/cli/dist/claudexord.js");
  if (!existsSync(entry)) {
    throw new Error(`pinned claudexord entry not found; build the pin first (${entry})`);
  }

  const home = mkdtempSync(join(tmpdir(), "heniek-claudexor-"));
  const port = await reservePort();

  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [entry], {
      env: {
        ...(options.environment ?? process.env),
        HOME: home,
        CLAUDEXOR_CONTROL_PORT: String(port),
      },
      // `stdio: "ignore"` so daemon survival can never be an artifact of the
      // parent's pipes closing (EPIPE) rather than of the engine's design.
      stdio: "ignore",
      detached,
    });
    if (detached) child.unref();

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + readyTimeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt += 1;
      const status = await probeHealthz(baseUrl);
      if (status !== null && isDaemonReady({ source: "healthz", status, port, attempt }, port)) {
        const token = readDaemonToken(home);
        const pid = child.pid;
        if (pid === undefined) throw new Error("daemon spawned without a pid");
        return { pid, port, baseUrl, home, token, stop: () => stopDaemon(pid, home) };
      }
      await sleep(250);
    }
    throw new DaemonStartTimeoutError(port);
  } catch (error) {
    if (child?.pid !== undefined) stopDaemon(child.pid, home);
    else rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

async function probeHealthz(baseUrl: string): Promise<number | null> {
  try {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
    return response.status;
  } catch {
    return null;
  }
}

/** Read the daemon's 0600 bearer token. Never logged; never in an error. */
function readDaemonToken(home: string): string {
  const path = join(home, ".claudexor/v3/daemon/token");
  return readFileSync(path, "utf8").trim();
}

/** Terminate a daemon and remove its scratch home. Idempotent. */
export function stopDaemon(pid: number, home: string): void {
  // Positive pid only. A negative pid would signal the whole process group,
  // which in canary 1 would kill the daemon alongside the launcher and fake a
  // parent-independence failure.
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    rmSync(home, { recursive: true, force: true });
    return;
  }
  // Escalate rather than trusting SIGTERM: a daemon that ignores or is slow on
  // it would otherwise survive holding its port while its home is deleted out
  // from under its journal. Across a suite that starts a daemon per canary,
  // those leaks accumulate.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processAlive(pid)) {
    try {
      execFileSync(process.execPath, ["-e", "setTimeout(()=>{},100)"], { timeout: 400 });
    } catch {
      /* best-effort pause without a sleep dependency */
    }
  }
  if (processAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(home, { recursive: true, force: true });
}

/** True while a process exists, used to observe survival across a kill. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
