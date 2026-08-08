import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function run(argv: readonly string[], configHome?: string, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", entrypoint, ...argv], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(configHome === undefined ? {} : { XDG_CONFIG_HOME: configHome }),
      ...environment,
    },
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
  const artifactBytes = Buffer.from("q012-artifact\n".repeat(5_000));
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
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
                methodVersion: required?.name === "stage.start" ? 2 : 1,
                wireMethod: `${required?.name}.v${required?.name === "stage.start" ? 2 : 1}`,
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
        } else if (request.method === "stage.start.v2") {
          result = {
            schemaVersion: 2,
            runId: "run-q012",
            stageId: "stage-q012",
            status: "queued",
            schedulingRevision: 1,
          };
        } else if (request.method === "run.status.v1") {
          result = {
            schemaVersion: 1,
            runId: "run-q012",
            stageId: "stage-q012",
            status: "waiting_on_user",
            interactions: [
              {
                schemaVersion: 2,
                id: "interaction-q012",
                questions: [
                  {
                    id: "question-q012",
                    prompt: "Which title?",
                    options: [],
                    multiSelect: false,
                  },
                ],
                requestedAt: "2026-08-06T10:00:00.000Z",
              },
            ],
          };
        } else if (
          request.method === "run.answer.v1" ||
          request.method === "run.resume.v1" ||
          request.method === "run.cancel.v1"
        ) {
          result = {
            schemaVersion: 1,
            runId: "run-q012",
            status: request.method === "run.cancel.v1" ? "cancelled" : "running",
            accepted: true,
          };
        } else if (request.method === "run.result.v1") {
          result = {
            schemaVersion: 1,
            runId: "run-q012",
            stageId: "stage-q012",
            status: "succeeded",
            summary: "Completed.",
            sessionId: "session-q012",
            artifacts: [
              {
                name: "artifacts/report.md",
                artifactId: "artifact-q012",
                mediaType: "text/markdown",
                byteLength: artifactBytes.byteLength,
                sha256: artifactSha256,
              },
            ],
          };
        } else if (request.method === "artifact.get.v1") {
          const offset = typeof request.params?.offset === "number" ? request.params.offset : 0;
          const chunk = artifactBytes.subarray(offset, offset + 32 * 1024);
          result = {
            schemaVersion: 1,
            artifactId: "artifact-q012",
            name: "artifacts/report.md",
            mediaType: "text/markdown",
            byteLength: artifactBytes.byteLength,
            sha256: artifactSha256,
            offset,
            eof: offset + chunk.byteLength === artifactBytes.byteLength,
            contentBase64: chunk.toString("base64"),
          };
        } else if (request.method === "doctor.v1") {
          result = {
            schemaVersion: 1,
            health: "degraded",
            checks: ["runtime", "auth-route", "compatibility", "cleanup"].map((category) => ({
              category,
              status: category === "cleanup" ? "warn" : "pass",
              code: `${category.toUpperCase()}_CHECK`,
              message: `${category} checked`,
            })),
          };
        } else if (request.method === "engine.catalogue.v1") {
          const observedAt = "2026-08-07T10:00:00.000Z";
          const unknown = { support: "unknown", evidence: [], reasons: ["not-advertised"] };
          result = {
            schemaVersion: 1,
            generatedAt: observedAt,
            entries: ["claude", "codex", "cursor"].map((engine) => ({
              engine,
              accountId: engine === "claude" ? null : `${engine}-work`,
              engineVersion: "1.0.0",
              claudexorVersion: "3.1.2",
              observedAt,
              expiresAt: "2026-08-07T10:02:00.000Z",
              freshness: "fresh",
              discovery: "complete",
              configured: true,
              installation: "installed",
              authentication: "authenticated",
              compatibility: "compatible",
              capacity: engine === "cursor" ? "unknown" : "available",
              ready: true,
              models: [
                {
                  id: `${engine}-model`,
                  provenance: "api",
                  efforts: ["high"],
                  executionModes: engine === "claude" ? ["native", "external"] : ["external"],
                },
              ],
              features: {
                questions: unknown,
                resume: unknown,
                usage: unknown,
                structuredOutput: unknown,
                cancellation: unknown,
                tools: [],
              },
              provenance: [{ source: "harness-inventory", observedAt }],
              reasons: [],
            })),
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
      "Usage: heniek status [--json]\n       heniek codebase detect [ROOT...] [--json]\n       heniek codebase register [ROOT...] [--confirm-registration] [--json]\n       heniek stage start --task-file PATH --artifact-path PATH --profile PROFILE [--priority 0-9] [--secret ID...] [--json]\n       heniek run status RUN_ID [--json]\n       heniek run answer RUN_ID INTERACTION_ID --answers-json JSON [--json]\n       heniek run resume RUN_ID [--input-artifact ARTIFACT_ID...] [--json]\n       heniek run cancel RUN_ID [--json]\n       heniek run result RUN_ID [--json]\n       heniek artifact get ARTIFACT_ID [--output PATH] [--json]\n       heniek engine list [--refresh] [--json]\n       heniek runtime list [--json]\n       heniek runtime install claudexor VERSION [--json]\n       heniek runtime activate claudexor VERSION [--json]\n       heniek runtime upgrade claudexor VERSION [--json]\n       heniek runtime rollback claudexor [--json]\n       heniek runtime adopt claudexor --entry ABSOLUTE_PATH [--json]\n       heniek doctor [--json]\n       heniek --help\n       heniek --version\n",
    );
    expect(result.stderr).toBe("");
  });

  it("lists an empty local runtime inventory without contacting the daemon", async () => {
    const home = await mkdtemp(join(tmpdir(), "heniek-cli-runtime-"));
    homes.push(home);
    const result = run(["runtime", "list", "--json"], undefined, { HENIEK_HOME: home });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: "runtime.list",
      result: { schemaVersion: 1, active: null, previous: null, installed: [] },
    });
    expect(result.stderr).toBe("");
  });

  it("returns a stable typed error and nonzero exit for an invalid runtime version", async () => {
    const home = await mkdtemp(join(tmpdir(), "heniek-cli-runtime-"));
    homes.push(home);
    const result = run(["runtime", "install", "claudexor", "latest", "--json"], undefined, {
      HENIEK_HOME: home,
    });
    expect(result.status).toBe(8);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "runtime.install",
      error: { code: "RELEASE_MANIFEST_INVALID", retryable: false },
    });
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

  it("drives the bounded Q012 stage/run/doctor surface and retrieves a multi-chunk artifact", {
    timeout: 20_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), "heniek-cli-q012-test-"));
    homes.push(home);
    const taskFile = join(home, "task.md");
    const outputFile = join(home, "retrieved-report.md");
    await writeFile(taskFile, "Create the report.\n", "utf8");
    const daemon = await startFakeDaemon(home);
    try {
      const start = await runAsync(
        [
          "stage",
          "start",
          "--task-file",
          taskFile,
          "--artifact-path",
          "artifacts/report.md",
          "--profile",
          "claude-report",
          "--priority",
          "3",
          "--json",
        ],
        home,
      );
      expect(start.status, `${start.stderr}\n${start.stdout}`).toBe(0);
      expect(JSON.parse(start.stdout)).toMatchObject({
        ok: true,
        command: "stage.start",
        result: { runId: "run-q012", status: "queued", schedulingRevision: 1 },
      });

      const status = await runAsync(["run", "status", "run-q012", "--json"], home);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        result: {
          status: "waiting_on_user",
          interactions: [{ id: "interaction-q012" }],
        },
      });

      const answer = await runAsync(
        [
          "run",
          "answer",
          "run-q012",
          "interaction-q012",
          "--answers-json",
          JSON.stringify([
            { questionId: "question-q012", selectedLabels: [], freeText: "Release notes" },
          ]),
          "--json",
        ],
        home,
      );
      expect(answer.status).toBe(0);
      expect(JSON.parse(answer.stdout)).toMatchObject({ result: { accepted: true } });

      const result = await runAsync(["run", "result", "run-q012", "--json"], home);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        result: { status: "succeeded", artifacts: [{ artifactId: "artifact-q012" }] },
      });

      const artifact = await runAsync(
        ["artifact", "get", "artifact-q012", "--output", outputFile],
        home,
      );
      expect(artifact.status).toBe(0);
      expect(artifact.stdout).toContain("Wrote 70000 bytes");
      expect((await readFile(outputFile)).byteLength).toBe(70_000);

      const doctor = await runAsync(["doctor", "--json"], home);
      expect(doctor.status).toBe(0);
      expect(JSON.parse(doctor.stdout)).toMatchObject({
        ok: true,
        result: { health: "degraded" },
      });
      expect(daemon.methods).toContain("stage.start.v2");
      expect(daemon.methods).toContain("run.answer.v1");
      expect(daemon.methods.filter((method) => method === "artifact.get.v1")).toHaveLength(3);
      expect(daemon.methods).toContain("doctor.v1");
    } finally {
      await daemon.close();
    }
  });

  it("renders the engine capability matrix and stable JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "heniek-cli-q015-test-"));
    homes.push(home);
    const daemon = await startFakeDaemon(home);
    try {
      const human = await runAsync(["engine", "list", "--refresh"], home);
      expect(human.status).toBe(0);
      expect(human.stdout).toContain("ENGINE  ACCOUNT");
      expect(human.stdout).toContain("claude  native/-");
      expect(human.stdout).toContain("cursor  cursor-work");
      const json = await runAsync(["engine", "list", "--json"], home);
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: true,
        command: "engine.list",
        result: { entries: [{ engine: "claude" }, { engine: "codex" }, { engine: "cursor" }] },
      });
      expect(daemon.methods.filter((method) => method === "engine.catalogue.v1")).toHaveLength(2);
    } finally {
      await daemon.close();
    }
  });
});
