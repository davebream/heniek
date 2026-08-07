import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeChildEnvironment } from "./environment.js";
import { ClaudexorRuntimeError } from "./errors.js";
import type { RuntimeIdentityProbe, RuntimeProbeResult } from "./types.js";

const REQUIRED_OPERATIONS = [
  "POST /v2/handshake",
  "GET /v2/operations",
  "POST /v2/harnesses/:id/auth-readiness",
  "POST /v2/threads",
  "GET /v2/threads/:id",
  "POST /v2/threads/:id/turns",
  "GET /v2/runs/:id",
  "POST /v2/runs/:id/interactions/:id/answer",
  "POST /v2/runs/:id/control",
  "GET /v2/runs/:id/produced",
  "GET /v2/runs/:id/produced/<path>",
] as const;

export interface ClaudexorRuntimeProbeOptions {
  /** Explicit, bounded values for a probe; never inferred from process.env. */
  readonly explicitEnvironment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly readyTimeoutMilliseconds?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve a loopback port")));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function temporaryHome(): Promise<string> {
  const root = process.platform === "win32" ? tmpdir() : await realpath("/tmp");
  return mkdtemp(join(root, "heniek-runtime-probe-"));
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${operation} returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

export function createClaudexorRuntimeProbe(
  options: ClaudexorRuntimeProbeOptions = {},
): RuntimeIdentityProbe {
  const request = options.fetch ?? globalThis.fetch;
  const readyTimeoutMilliseconds = options.readyTimeoutMilliseconds ?? 60_000;

  return {
    async inspect(entryPath: string): Promise<RuntimeProbeResult> {
      const home = await temporaryHome();
      const port = await reservePort();
      const child = spawn(process.execPath, [entryPath], {
        detached: process.platform !== "win32",
        env: {
          ...buildRuntimeChildEnvironment({ home, explicit: options.explicitEnvironment }),
          CLAUDEXOR_CONTROL_PORT: String(port),
        },
        stdio: "ignore",
      });
      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + readyTimeoutMilliseconds;
        let healthy = false;
        while (Date.now() < deadline) {
          if (child.exitCode !== null) throw new Error("candidate daemon exited before readiness");
          try {
            const response = await request(`${baseUrl}/healthz`, {
              signal: AbortSignal.timeout(1_000),
            });
            if (response.ok) {
              healthy = true;
              break;
            }
          } catch {
            // Candidate startup is asynchronous; retry until the bounded deadline.
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!healthy) throw new Error("candidate daemon did not become ready");

        const token = (await readFile(join(home, ".claudexor/v3/daemon/token"), "utf8")).trim();
        const headers = {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1",
          "X-Claudexor-Protocol-Major": "3",
        };
        const handshake = await responseJson(
          await request(`${baseUrl}/v2/handshake`, {
            method: "POST",
            headers,
            body: JSON.stringify({ protocolMajor: 3, client: "heniek-q013-runtime-probe" }),
            signal: AbortSignal.timeout(10_000),
          }),
          "handshake",
        );
        if (!isRecord(handshake) || !isRecord(handshake.engine)) {
          throw new Error("candidate handshake was malformed");
        }
        const version = handshake.engine.version;
        const buildSha = handshake.engine.sha;
        if (
          handshake.compatible !== true ||
          handshake.protocolMajor !== 3 ||
          typeof version !== "string" ||
          !/^\d+\.\d+\.\d+$/.test(version) ||
          typeof buildSha !== "string" ||
          !/^[0-9a-f]{40}$/.test(buildSha)
        ) {
          throw new Error("candidate handshake identity was incompatible");
        }

        const catalogue = await responseJson(
          await request(`${baseUrl}/v2/operations`, {
            headers,
            signal: AbortSignal.timeout(10_000),
          }),
          "operation catalogue",
        );
        if (!isRecord(catalogue) || !Array.isArray(catalogue.operations)) {
          throw new Error("candidate operation catalogue was malformed");
        }
        const available = new Set(
          catalogue.operations.flatMap((operation) => {
            if (!isRecord(operation)) return [];
            return typeof operation.method === "string" && typeof operation.path === "string"
              ? [`${operation.method.toUpperCase()} ${operation.path}`]
              : [];
          }),
        );
        if (REQUIRED_OPERATIONS.some((operation) => !available.has(operation))) {
          throw new Error("candidate operation catalogue is incomplete");
        }
        return { version, buildSha };
      } catch (error) {
        throw new ClaudexorRuntimeError(
          "RUNTIME_INTEGRITY_FAILED",
          "The Claudexor candidate failed its live identity, protocol, or operation probe.",
          { cause: error },
        );
      } finally {
        await stopProcess(child);
        await rm(home, { recursive: true, force: true });
      }
    },
  };
}
