import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveApplicationHome } from "@heniek/config";
import { createFileSecretStore, SensitiveValue } from "@heniek/secrets";
import { afterEach, describe, expect, it } from "vitest";

const entrypoint = new URL("../src/bin.ts", import.meta.url).pathname;
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function run(argv: readonly string[], configHome?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", entrypoint, ...argv], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    env: configHome === undefined ? process.env : { ...process.env, XDG_CONFIG_HOME: configHome },
  });
}

function runAsync(argv: readonly string[], home: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", entrypoint, ...argv], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, HENIEK_HOME: home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const HASH = "a".repeat(64);
const KEY_ID = "b".repeat(32);
const INSTRUCTION_SNAPSHOT = {
  schemaVersion: 1,
  snapshotSha256: HASH,
  capturedAt: "2026-08-06T10:00:00.000Z",
  readiness: "ready",
  sources: [],
  diagnostics: [],
};

async function startFakeDaemon(homeRoot: string) {
  const home = resolveApplicationHome({
    platform:
      process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "other",
    env: { HENIEK_HOME: homeRoot },
    homeDirectory: homeRoot,
  });
  await mkdir(dirname(home.paths.daemonSocketFile), { recursive: true });
  await createFileSecretStore({ directory: home.paths.secretsDirectory }).write(
    "daemon.local-control",
    SensitiveValue.from(`${KEY_ID}.${"c".repeat(64)}`),
  );
  const methods: string[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        const request = JSON.parse(line) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
        };
        methods.push(request.method);
        let result: unknown;
        if (request.method === "daemon.hello") {
          result = {
            schemaVersion: 1,
            protocolVersion: 1,
            instanceId: "daemon-fixture",
            challenge: "d".repeat(64),
            macAlgorithm: "hmac-sha256",
            keyId: KEY_ID,
          };
        } else if (request.method === "daemon.negotiate") {
          const requiredMethods = request.params?.requiredMethods;
          const required = Array.isArray(requiredMethods)
            ? (requiredMethods[0] as
                | {
                    name: string;
                    resultSchemas: Array<{ schemaId: string; sha256: string }>;
                  }
                | undefined)
            : undefined;
          result = {
            schemaVersion: 1,
            compatibility: "compatible",
            selectedTransportVersion: 1,
            contractManifestVersion: "heniek.contracts-manifest.v1",
            methods: [
              {
                name: required?.name,
                methodVersion: 1,
                wireMethod: `${required?.name}.v1`,
                resultSchemaId: required?.resultSchemas[0]?.schemaId,
                resultSchemaSha256: required?.resultSchemas[0]?.sha256,
              },
            ],
            reasons: [],
          };
        } else if (request.method === "codebase.detect.v1") {
          result = {
            schemaVersion: 1,
            registrationState: "unregistered",
            codebaseId: null,
            name: "fixture",
            rootPath: "/fixture",
            sourceRepositoryPath: null,
            topologySha256: HASH,
            repositories: [
              {
                repositoryId: null,
                name: "fixture",
                path: "/fixture",
                gitCommonDirectory: "/fixture/.git",
                remotes: [],
                defaultRemote: null,
                defaultBranch: null,
              },
            ],
            instructionSnapshot: INSTRUCTION_SNAPSHOT,
            diagnostics: [],
          };
        } else {
          result = {
            schemaVersion: 1,
            codebaseId: "cb-fixture",
            name: "fixture",
            rootPath: "/fixture",
            sourceRepositoryPath: null,
            topologySha256: HASH,
            repositories: [
              {
                repositoryId: "repo-fixture",
                name: "fixture",
                path: "/fixture",
                gitCommonDirectory: "/fixture/.git",
                remotes: [],
                defaultRemote: null,
                defaultBranch: null,
              },
            ],
            instructionSnapshot: INSTRUCTION_SNAPSHOT,
            diagnostics: [],
            readiness: "ready",
            registeredAt: "2026-08-06T10:00:00.000Z",
            configurationSha256: "e".repeat(64),
          };
        }
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      }
    });
  });
  server.listen(home.paths.daemonSocketFile);
  await once(server, "listening");
  return {
    methods,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

describe("heniek CLI", () => {
  it("accepts only the documented help invocation", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "Usage: heniek status [--json]\n       heniek codebase detect [ROOT...] [--json]\n       heniek codebase register [ROOT...] [--confirm-registration] [--json]\n       heniek --help\n       heniek --version\n",
    );
    expect(result.stderr).toBe("");
  });

  it("uses JSON stdout and exit 3 when no daemon is reachable without creating its home", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "heniek-cli-test-"));
    homes.push(configHome);
    const result = run(["status", "--json"], configHome);
    expect(result.status).toBe(3);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      command: "status",
      error: {
        code: "DAEMON_UNAVAILABLE",
        message: "Heniek daemon is not reachable.",
        retryable: true,
      },
    });
    expect(existsSync(join(configHome, "heniek"))).toBe(false);
  });

  it("rejects duplicate flags as usage errors", () => {
    const result = run(["status", "--json", "--json"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "status",
      error: { code: "USAGE_ERROR", retryable: false },
    });
    expect(result.stderr).toBe("");
  });

  it("refuses non-interactive JSON registration without explicit confirmation", () => {
    const result = run(["codebase", "register", "--json"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      command: "codebase.register",
      error: {
        code: "USAGE_ERROR",
        message: "Non-interactive Codebase registration requires --confirm-registration.",
        retryable: false,
      },
    });
    expect(result.stderr).toBe("");
  });

  it("prints stable JSON for confirmed registration after a fresh detection preview", async () => {
    const home = await mkdtemp(join(tmpdir(), "heniek-cli-rpc-test-"));
    homes.push(home);
    const daemon = await startFakeDaemon(home);
    try {
      const result = await runAsync(
        ["codebase", "register", "/fixture", "--confirm-registration", "--json"],
        home,
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: true,
        command: "codebase.register",
        result: { codebaseId: "cb-fixture", readiness: "ready" },
      });
      expect(daemon.methods).toEqual([
        "daemon.hello",
        "daemon.negotiate",
        "codebase.detect.v1",
        "daemon.hello",
        "daemon.negotiate",
        "codebase.register.v1",
      ]);
    } finally {
      await daemon.close();
    }
  });
});
