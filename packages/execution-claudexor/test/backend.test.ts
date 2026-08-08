import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionRequestV2 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDEXOR_ENGINE_SHA,
  CLAUDEXOR_ENGINE_VERSION,
  ClaudexorControlError,
  createClaudexorExecutionBackend,
  REQUIRED_OPERATION_IDEMPOTENCY,
  REQUIRED_OPERATIONS,
} from "../src/index.js";

const homes: string[] = [];
const expectedEngine = {
  version: CLAUDEXOR_ENGINE_VERSION,
  buildSha: CLAUDEXOR_ENGINE_SHA,
} as const;

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function handshake(sha = CLAUDEXOR_ENGINE_SHA, version = CLAUDEXOR_ENGINE_VERSION): unknown {
  return {
    protocolMajor: 3,
    compatible: true,
    operationsPath: "/v2/operations",
    engine: { version, sha, entry: "/runtime/claudexord.js" },
  };
}

const input: Static<typeof ExecutionRequestV2> = {
  schemaVersion: 2,
  runId: "run-heniek-1",
  stageId: "stage-1" as never,
  workspaceId: "workspace-1" as never,
  workingDirectory: "/work/repository",
  prompt: "Create the report.",
  artifactPath: "artifacts/report.md",
  inputArtifactRefs: [],
  limits: { maxDurationMs: 1_500, maxTurns: 4 },
};

describe("Claudexor ExecutionBackendV2", () => {
  it("accepts the dynamically selected runtime identity", async () => {
    const selected = { version: "3.2.0", buildSha: "c".repeat(40) };
    const backend = createClaudexorExecutionBackend({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine: selected,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/v2/handshake") return json(handshake(selected.buildSha, selected.version));
        if (path === "/v2/operations") {
          return json({
            operations: REQUIRED_OPERATIONS.map((operation) => {
              const [method, ...pathParts] = operation.split(" ");
              const path = pathParts.join(" ");
              return {
                method,
                path,
                idempotency:
                  REQUIRED_OPERATION_IDEMPOTENCY[
                    `${method} ${path}` as keyof typeof REQUIRED_OPERATION_IDEMPOTENCY
                  ],
              };
            }),
          });
        }
        throw new Error(`unexpected ${path}`);
      },
    });
    await expect(backend.diagnoseCompatibility()).resolves.toMatchObject([
      { status: "pass", code: "CLAUDEXOR_COMPATIBLE" },
    ]);
  });

  it("uses exact /v2 routes, stable thread continuation, grouped answers and produced bytes", async () => {
    const calls: { method: string; path: string; body: unknown; idempotencyKey: string | null }[] =
      [];
    let state = "running";
    let waiting = true;
    const fetch: typeof globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({
        method,
        path: parsed.pathname,
        body,
        idempotencyKey: new Headers(init.headers).get("Idempotency-Key"),
      });
      if (parsed.pathname === "/v2/handshake") return json(handshake());
      if (parsed.pathname === "/v2/threads" && method === "POST") {
        return json({ id: "thread-stable-1" });
      }
      if (parsed.pathname === "/v2/threads/thread-stable-1/turns") {
        return json({ jobId: "job-1", threadId: "thread-stable-1", turnId: "turn-1", state });
      }
      if (parsed.pathname === "/v2/threads/thread-stable-1") {
        return json({
          thread: { id: "thread-stable-1", headRunId: "run-upstream-1" },
          sessions: [{ harnessId: "claude", nativeSessionId: "session-native-1" }],
          turns: [],
        });
      }
      if (parsed.pathname === "/v2/runs/run-upstream-1") {
        return json({
          summary: { state, waitingOnUser: waiting },
          finalSummary: state === "succeeded" ? "Report completed." : null,
          pendingInteractions: waiting
            ? [
                {
                  interactionId: "interaction-1",
                  runId: "run-upstream-1",
                  questions: [
                    {
                      id: "question-1",
                      question: "Which format?",
                      header: "Format",
                      options: [{ label: "Markdown", description: "A text report." }],
                      multi_select: false,
                    },
                    {
                      id: "question-2",
                      question: "Add notes?",
                      header: null,
                      options: [],
                      multi_select: false,
                    },
                  ],
                  requestedAt: "2026-08-06T10:00:00.000Z",
                  timeoutAt: null,
                },
              ]
            : [],
        });
      }
      if (parsed.pathname.endsWith("/interactions/interaction-1/answer")) {
        waiting = false;
        return json({ accepted: true, status: "delivered" });
      }
      if (parsed.pathname.endsWith("/control")) {
        return json({ accepted: true, status: "applied", cascadeRunIds: [] });
      }
      if (parsed.pathname === "/v2/runs/run-upstream-1/produced") {
        return json({
          runId: "run-upstream-1",
          artifacts: [{ path: "report.md", kind: "file", bytes: 6, mime: "text/markdown" }],
        });
      }
      if (parsed.pathname === "/v2/runs/run-upstream-1/produced/report.md") {
        return new Response("report");
      }
      throw new Error(`unexpected route: ${method} ${parsed.pathname}`);
    };
    const backend = createClaudexorExecutionBackend({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch,
    });

    const handle = await backend.start(input);
    expect(handle.executionId).toBe("thread-stable-1");
    expect(await backend.status(handle.executionId)).toBe("waiting_on_user");
    expect(await backend.interactions(handle.executionId)).toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        id: "interaction-1",
        questions: [
          expect.objectContaining({ id: "question-1", prompt: "Which format?" }),
          expect.objectContaining({ id: "question-2", prompt: "Add notes?" }),
        ],
      }),
    ]);
    await backend.answer(handle.executionId, {
      schemaVersion: 1,
      interactionId: "interaction-1" as never,
      answers: [
        { questionId: "question-1" as never, selectedLabels: ["Markdown"] },
        { questionId: "question-2" as never, selectedLabels: [], freeText: "Yes" },
      ],
    });
    expect(calls.filter((call) => call.path.endsWith("/turns"))).toHaveLength(1);
    const resumeRequest = {
      schemaVersion: 1 as const,
      executionId: handle.executionId,
      operationId: "operation-resume-1",
      inputArtifactRefs: [],
    };
    await backend.resume(resumeRequest);
    await backend.resume(resumeRequest);
    await backend.cancel(handle.executionId);
    state = "succeeded";
    const result = await backend.result(handle.executionId);
    expect(result).toMatchObject({
      status: "succeeded",
      summary: "Report completed.",
      sessionId: "session-native-1",
      artifacts: [{ path: "artifacts/report.md", byteLength: 6 }],
    });
    await expect(backend.readArtifact(handle.executionId, "report.md")).resolves.toEqual(
      new TextEncoder().encode("report"),
    );

    const threadCreates = calls.filter((call) => call.path === "/v2/threads");
    const turns = calls.filter((call) => call.path.endsWith("/turns"));
    expect(threadCreates).toHaveLength(1);
    expect(turns).toHaveLength(3);
    expect(turns.every((call) => call.path.includes("thread-stable-1"))).toBe(true);
    expect(threadCreates[0]?.idempotencyKey).toMatch(/^heniek-thread-/);
    expect(turns[0]?.idempotencyKey).toMatch(/^heniek-turn-/);
    expect(turns[1]?.idempotencyKey).toMatch(/^heniek-turn-/);
    expect(turns[2]?.idempotencyKey).toBe(turns[1]?.idempotencyKey);
    expect(turns[1]?.idempotencyKey).not.toBe(turns[0]?.idempotencyKey);
    expect(calls.find((call) => call.path.endsWith("/answer"))?.body).toEqual({
      answers: [
        { questionId: "question-1", selectedLabels: ["Markdown"], freeText: null },
        { questionId: "question-2", selectedLabels: [], freeText: "Yes" },
      ],
    });
    expect(calls.find((call) => call.path.endsWith("/control"))?.body).toEqual({
      control: { kind: "cancel", reason: "cancelled by Heniek" },
    });
  });

  it("rejects incompatible pins, unsafe paths, malformed sizes and redacts remote payloads", async () => {
    const incompatible = createClaudexorExecutionBackend({
      baseUrl: "http://127.0.0.1:1",
      expectedEngine,
      fetch: async () => json(handshake("0".repeat(40))),
    });
    await expect(incompatible.start(input)).rejects.toThrow("selected build");

    const artifactFetch: typeof globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v2/handshake") return json(handshake());
      if (path === "/v2/threads/thread-1") {
        return json({ thread: { headRunId: "run-1" }, sessions: [], turns: [] });
      }
      if (path === "/v2/runs/run-1/produced") {
        return json({ runId: "run-1", artifacts: [{ path: "../secret", kind: "file", bytes: 1 }] });
      }
      throw new Error(`unexpected ${path}`);
    };
    const artifacts = createClaudexorExecutionBackend({
      baseUrl: "http://127.0.0.1:1",
      expectedEngine,
      fetch: artifactFetch,
    });
    await expect(artifacts.artifacts("thread-1")).rejects.toMatchObject({
      code: "unsafe_artifact_path",
    });

    const secret = "sk-secret-should-not-escape";
    const failing = createClaudexorExecutionBackend({
      baseUrl: "http://127.0.0.1:1",
      expectedEngine,
      fetch: async () => json({ code: secret, detail: secret }, 500),
    });
    let observed: unknown;
    try {
      await failing.start(input);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(ClaudexorControlError);
    expect(String(observed)).not.toContain(secret);
  });

  it("checks the exact operation catalog, runtime entry and both subscription attestations", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-claudexor-runtime-"));
    homes.push(root);
    await mkdir(join(root, "packages/cli/dist"), { recursive: true });
    await writeFile(join(root, "packages/cli/dist/claudexord.js"), "", "utf8");
    const seenEnvironments: Readonly<Record<string, string>>[] = [];
    const fetch: typeof globalThis.fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v2/handshake") return json(handshake());
      if (path === "/v2/operations") {
        return json({
          protocolMajor: 3,
          operations: REQUIRED_OPERATIONS.map((operation) => {
            const space = operation.indexOf(" ");
            const method = operation.slice(0, space);
            const path = operation.slice(space + 1);
            return {
              method,
              path,
              idempotency:
                REQUIRED_OPERATION_IDEMPOTENCY[
                  `${method} ${path}` as keyof typeof REQUIRED_OPERATION_IDEMPOTENCY
                ],
            };
          }),
        });
      }
      if (path === "/v2/harnesses/claude/auth-readiness") {
        expect(JSON.parse(String(init.body))).toEqual({
          authRequest: "subscription",
          source: "oauth_token_env",
        });
        return json({
          harnessId: "claude",
          authRequest: "subscription",
          requestedSource: "oauth_token_env",
          observedAt: "2026-08-06T10:00:00.000Z",
          readiness: {
            source: "oauth_token_env",
            availability: "available",
            verification: "passed",
          },
        });
      }
      throw new Error(`unexpected ${path}`);
    };
    const backend = createClaudexorExecutionBackend({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch,
      runtimeEntryPath: join(root, "packages/cli/dist/claudexord.js"),
      environment: {
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
        ANTHROPIC_API_KEY: "must-not-pass",
        PATH: "/hostile/path",
      },
      diagnosticRunner: async (_command, args, environment) => {
        expect(args).toEqual(["auth", "status", "--json"]);
        seenEnvironments.push(environment);
        return {
          exitCode: 0,
          spawnFailure: false,
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "oauth_token",
            apiProvider: "firstParty",
          }),
          stderr: "",
        };
      },
    });
    await expect(backend.diagnoseRuntime()).resolves.toMatchObject({ status: "pass" });
    await expect(backend.diagnoseCompatibility()).resolves.toEqual([
      expect.objectContaining({ status: "pass", code: "CLAUDEXOR_COMPATIBLE" }),
    ]);
    await expect(backend.diagnoseAuthRoute()).resolves.toMatchObject({
      status: "pass",
      code: "SUBSCRIPTION_ROUTE_ATTESTED",
    });
    expect(seenEnvironments).toHaveLength(1);
    expect(seenEnvironments[0]).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(seenEnvironments[0]?.PATH).not.toBe("/hostile/path");
    expect(seenEnvironments[0]?.HOME).toBe(seenEnvironments[0]?.CLAUDE_CONFIG_DIR);
  });

  it("fails doctor checks independently for runtime, auth route and required operations", async () => {
    const fetch: typeof globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v2/handshake") return json(handshake());
      if (path === "/v2/operations") return json({ protocolMajor: 3, operations: [] });
      throw new Error(`unexpected ${path}`);
    };
    const backend = createClaudexorExecutionBackend({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch,
      environment: {},
    });
    await expect(backend.diagnoseRuntime()).resolves.toMatchObject({
      category: "runtime",
      status: "fail",
    });
    await expect(backend.diagnoseAuthRoute()).resolves.toMatchObject({
      category: "auth-route",
      status: "fail",
    });
    await expect(backend.diagnoseCompatibility()).resolves.toEqual([
      expect.objectContaining({ category: "compatibility", status: "fail" }),
    ]);
  });
});
