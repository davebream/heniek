import type { ExecutionRequestV3 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  CLAUDEXOR_ENGINE_SHA,
  CLAUDEXOR_ENGINE_VERSION,
  ClaudexorControlError,
  createClaudeProfileExecutionAdapter,
  createCodexProfileExecutionAdapter,
  createCursorProfileExecutionAdapter,
} from "../src/index.js";

const expectedEngine = {
  version: CLAUDEXOR_ENGINE_VERSION,
  buildSha: CLAUDEXOR_ENGINE_SHA,
} as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function handshake(): unknown {
  return {
    protocolMajor: 3,
    compatible: true,
    operationsPath: "/v2/operations",
    engine: { version: CLAUDEXOR_ENGINE_VERSION, sha: CLAUDEXOR_ENGINE_SHA },
  };
}

const input: Static<typeof ExecutionRequestV3> = {
  schemaVersion: 3,
  runId: "run-profile-1",
  stageId: "stage-profile-1" as never,
  workspaceId: "workspace-profile-1" as never,
  workingDirectory: "/work/repository",
  prompt: "Create the report.",
  artifactPath: "artifacts/report.md",
  inputArtifactRefs: [],
  limits: { maxDurationMs: 1_500, maxTurns: 4 },
  profile: {
    schemaVersion: 1,
    profileId: "claude-report" as never,
    workerId: "claude-worker" as never,
    roleId: "reporter" as never,
    engine: "claude",
    accountId: "claude-subscription" as never,
    billing: "subscription",
    model: "sonnet",
    effort: "high",
    executionMode: "external",
    questions: "parent-mediated",
    instructionsPath: "roles/reporter.md",
    artifactContract: "report.v1",
    provenance: [],
    fingerprint: `sha256:${"a".repeat(64)}`,
  },
};

const { accountId: _claudeAccountId, ...nativeCodexProfile } = input.profile;
const codexInput: Static<typeof ExecutionRequestV3> = {
  ...input,
  runId: "run-codex-profile-1",
  profile: {
    ...nativeCodexProfile,
    profileId: "codex-report" as never,
    workerId: "codex-worker" as never,
    engine: "codex",
    accountId: "codex-main" as never,
    billing: "subscription",
    model: "gpt-5.6-terra",
    effort: "medium",
    fingerprint: `sha256:${"b".repeat(64)}`,
  },
};

const cursorInput: Static<typeof ExecutionRequestV3> = {
  ...input,
  runId: "run-cursor-profile-1",
  profile: {
    ...nativeCodexProfile,
    profileId: "cursor-report" as never,
    workerId: "cursor-worker" as never,
    engine: "cursor",
    // Deliberately account-bearing: Q018's point is that a resolved Heniek
    // account never becomes a Claudexor credential-profile id for Cursor.
    accountId: "cursor-main" as never,
    billing: "subscription",
    model: "cursor-auto",
    effort: "medium",
    fingerprint: `sha256:${"c".repeat(64)}`,
  },
};

describe("ExecutionBackendV5 profile conformance", () => {
  it("uses only the named subscription profile and normalizes replayable lifecycle events", async () => {
    const calls: { method: string; path: string; body: unknown; headers: Headers }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({
        method: init.method ?? "GET",
        path: parsed.pathname,
        body,
        headers: new Headers(init.headers),
      });
      if (parsed.pathname === "/v2/handshake") return json(handshake());
      if (parsed.pathname === "/v2/threads" && init.method === "POST") {
        return json({ id: "thread-profile-1" });
      }
      if (parsed.pathname === "/v2/threads/thread-profile-1/turns") {
        return json({ jobId: "run-profile-1", threadId: "thread-profile-1", turnId: "turn-1" });
      }
      if (parsed.pathname === "/v2/threads/thread-profile-1") {
        return json({ thread: { id: "thread-profile-1", headRunId: "run-profile-1" } });
      }
      if (parsed.pathname === "/v2/runs/run-profile-1/events") {
        return new Response(
          [
            "id: 41",
            "event: run.status",
            'data: {"summary":{"state":"running","waitingOnUser":false}}',
            "",
            "id: 42",
            "event: harness.event",
            'data: {"payload":{"rate_limit":{"retry_after_ms":1200,"provider_secret":"redacted"}}}',
            "",
            "id: 43",
            "event: run.terminal",
            'data: {"outcomeFacts":{"reason":"context_capacity_exhausted","provider_detail":"hidden"}}',
            "",
            "id: 44",
            "event: harness.event",
            'data: {"type":"harness.event","payload":{"type":"tool_call","tool":{"name":"shell","kind":"command","use_id":"tool-1","target":"secret command"}}}',
            "",
            "id: 45",
            "event: harness.event",
            'data: {"type":"harness.event","payload":{"type":"tool_result","tool":{"name":"shell","kind":"command","use_id":"tool-1","status":"ok","exit_code":0,"content_summary":"private output"}}}',
            "",
            "id: 46",
            "event: harness.event",
            'data: {"type":"harness.event","payload":{"type":"file_change","payload":{"path":"src/example.ts","tool":"apply_patch"}}}',
            "",
            "id: 47",
            "event: harness.event",
            'data: {"type":"harness.event","payload":{"type":"usage","usage":{"input_tokens":12,"output_tokens":34,"cached_input_tokens":5,"cost_usd":0.01,"estimated":true}}}',
            "",
            "id: 48",
            "event: harness.event",
            'data: {"type":"harness.event","payload":{"type":"error","text":"private provider failure"}}',
            "",
            "id: 49",
            "event: harness.event",
            "data: not-json",
            "",
          ].join("\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      throw new Error(`unexpected route: ${init.method ?? "GET"} ${parsed.pathname}`);
    };
    const adapter = createClaudeProfileExecutionAdapter({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch,
    });

    const handle = await adapter.start(input);
    await adapter.resume(handle.executionId, []);
    const events = [];
    for await (const event of adapter.events(handle.executionId, "40")) events.push(event);

    expect(events).toMatchObject([
      { schemaVersion: 3, cursor: "41", kind: "status", status: "running" },
      { schemaVersion: 3, cursor: "42", kind: "rate_limited", retryAfterMs: 1_200 },
      {
        schemaVersion: 3,
        cursor: "43",
        kind: "telemetry",
        telemetry: {
          engine: "claude",
          context: {
            pressure: { state: "exhausted", confidence: "exact", basis: "capacity_signal" },
          },
        },
      },
      {
        schemaVersion: 3,
        cursor: "44",
        kind: "tool_call",
        tool: { name: "shell", kind: "command", useId: "tool-1" },
      },
      {
        schemaVersion: 3,
        cursor: "45",
        kind: "tool_result",
        tool: {
          name: "shell",
          kind: "command",
          useId: "tool-1",
          outcome: "succeeded",
          exitCode: 0,
        },
      },
      { schemaVersion: 3, cursor: "46", kind: "file_change", path: "src/example.ts" },
      {
        schemaVersion: 3,
        cursor: "47",
        kind: "telemetry",
        telemetry: {
          usage: {
            inputUnits: { availability: "available", value: 12, confidence: "exact" },
            outputUnits: { availability: "available", value: 34, confidence: "exact" },
            cachedInputUnits: { availability: "available", value: 5, confidence: "exact" },
            costUsd: { availability: "available", value: 0.01, confidence: "estimated" },
          },
        },
      },
      { schemaVersion: 3, cursor: "48", kind: "error" },
    ]);
    const creates = calls.filter((call) => call.path === "/v2/threads");
    const turns = calls.filter((call) => call.path.endsWith("/turns"));
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toMatchObject({
      authPreference: "subscription",
      credentialProfileId: "claude-subscription",
      primaryHarness: "claude",
      eligibleHarnesses: ["claude"],
    });
    expect(turns).toHaveLength(2);
    expect(
      turns.every(
        (call) =>
          call.body && (call.body as Record<string, unknown>).authPreference === "subscription",
      ),
    ).toBe(true);
    expect(turns[0]?.body).toMatchObject({
      credentialProfileId: "claude-subscription",
      model: "sonnet",
      effort: "high",
      maxSeconds: 2,
      maxTurns: 4,
    });
    expect(calls.find((call) => call.path.endsWith("/events"))?.headers.get("Last-Event-ID")).toBe(
      "40",
    );
    expect(JSON.stringify(events)).not.toContain("provider_secret");
    expect(JSON.stringify(events)).not.toContain("provider_detail");
  });

  it.each([
    ["native", { executionMode: "native" }],
    ["non-Claude", { engine: "codex" }],
    ["non-subscription", { billing: undefined }],
    ["account-less", { accountId: undefined }],
  ])("rejects %s profiles before sending control traffic", async (_name, profile) => {
    let calls = 0;
    const adapter = createClaudeProfileExecutionAdapter({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch: async () => {
        calls += 1;
        return json({});
      },
    });
    await expect(
      adapter.start({ ...input, profile: { ...input.profile, ...profile } as never }),
    ).rejects.toBeInstanceOf(ClaudexorControlError);
    expect(calls).toBe(0);
  });

  it("uses Claudexor's native Codex subscription session without a credential-profile ID", async () => {
    const calls: { method: string; path: string; body: unknown; headers: Headers }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({
        method: init.method ?? "GET",
        path: parsed.pathname,
        body,
        headers: new Headers(init.headers),
      });
      if (parsed.pathname === "/v2/handshake") return json(handshake());
      if (parsed.pathname === "/v2/harnesses/codex/auth-readiness") {
        return json({
          harnessId: "codex",
          authRequest: "subscription",
          requestedSource: "native_session",
          readiness: {
            source: "native_session",
            availability: "available",
            verification: "passed",
          },
        });
      }
      if (parsed.pathname === "/v2/threads" && init.method === "POST") {
        return json({ id: "thread-codex-profile-1" });
      }
      if (parsed.pathname === "/v2/threads/thread-codex-profile-1/turns") {
        return json({
          jobId: "run-codex-profile-1",
          threadId: "thread-codex-profile-1",
          turnId: "turn-1",
        });
      }
      if (parsed.pathname === "/v2/threads/thread-codex-profile-1") {
        return json({
          thread: { id: "thread-codex-profile-1", headRunId: "run-codex-profile-1" },
          sessions: [{ harnessId: "codex", nativeSessionId: "codex-session-1" }],
        });
      }
      if (parsed.pathname === "/v2/runs/run-codex-profile-1") {
        return json({
          summary: {
            state: "succeeded",
            waitingOnUser: false,
            inputTokens: 12,
            outputTokens: 34,
            cachedInputTokens: 5,
            spendUsd: 0.01,
            spendEstimated: true,
            result: { diffStat: { files: 1, additions: 2, deletions: 3 } },
          },
          finalSummary: "Codex done.",
        });
      }
      if (parsed.pathname === "/v2/runs/run-codex-profile-1/produced") {
        return json({ artifacts: [] });
      }
      if (parsed.pathname === "/v2/runs/run-codex-profile-1/events") {
        return new Response(
          [
            "id: 1",
            "event: run.status",
            'data: {"summary":{"state":"running","waitingOnUser":false}}',
            "",
          ].join("\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      throw new Error(`unexpected route: ${init.method ?? "GET"} ${parsed.pathname}`);
    };
    const adapter = createCodexProfileExecutionAdapter({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch,
    });

    const handle = await adapter.start(codexInput);
    await adapter.resume(handle.executionId, []);
    const events = [];
    for await (const event of adapter.events(handle.executionId)) events.push(event);

    await expect(adapter.result(handle.executionId)).resolves.toMatchObject({
      status: "succeeded",
      summary: "Codex done.",
      sessionId: "codex-session-1",
      telemetry: {
        engine: "codex",
        session: {
          providerSessionId: {
            availability: "available",
            value: "codex-session-1",
            confidence: "exact",
          },
        },
        usage: {
          inputUnits: { availability: "available", value: 12, confidence: "exact" },
          outputUnits: { availability: "available", value: 34, confidence: "exact" },
          cacheReadUnits: { availability: "available", value: 5, confidence: "exact" },
          costUsd: { availability: "available", value: 0.01, confidence: "estimated" },
        },
      },
      diff: { files: 1, additions: 2, deletions: 3 },
    });
    await expect(adapter.diagnoseAuthRoute()).resolves.toMatchObject({
      status: "pass",
      code: "CODEX_NATIVE_SESSION_ATTESTED",
    });

    expect(events).toEqual([{ schemaVersion: 3, cursor: "1", kind: "status", status: "running" }]);
    const creates = calls.filter((call) => call.path === "/v2/threads");
    const turns = calls.filter((call) => call.path.endsWith("/turns"));
    expect(creates[0]?.body).toMatchObject({
      authPreference: "subscription",
      primaryHarness: "codex",
      eligibleHarnesses: ["codex"],
    });
    expect(creates[0]?.body).not.toHaveProperty("credentialProfileId");
    expect(turns).toHaveLength(2);
    expect(turns[0]?.body).toMatchObject({
      authPreference: "subscription",
      harnesses: ["codex"],
      primaryHarness: "codex",
      model: "gpt-5.6-terra",
      effort: "medium",
    });
    expect(turns[0]?.body).not.toHaveProperty("credentialProfileId");
  });

  it("rejects a Claude profile before a Codex adapter sends control traffic", async () => {
    let calls = 0;
    const adapter = createCodexProfileExecutionAdapter({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch: async () => {
        calls += 1;
        return json({});
      },
    });
    await expect(adapter.start(input)).rejects.toBeInstanceOf(ClaudexorControlError);
    expect(calls).toBe(0);
  });

  it("blocks Codex before thread creation when native-session attestation fails", async () => {
    const paths: string[] = [];
    const adapter = createCodexProfileExecutionAdapter({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path === "/v2/handshake") return json(handshake());
        if (path === "/v2/harnesses/codex/auth-readiness") {
          return json({
            harnessId: "codex",
            authRequest: "subscription",
            requestedSource: "native_session",
            readiness: {
              source: "native_session",
              availability: "unavailable",
              verification: "failed",
            },
          });
        }
        throw new Error(`model work must not start: ${path}`);
      },
    });

    await expect(adapter.start(codexInput)).rejects.toMatchObject({
      code: "codex_native_session_unattested",
      operation: "authReadiness",
    });
    expect(paths).toEqual(["/v2/handshake", "/v2/harnesses/codex/auth-readiness"]);
  });

  it("uses Claudexor's native Cursor subscription session without a credential-profile ID", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method ?? "GET", path: parsed.pathname, body });
      if (parsed.pathname === "/v2/handshake") return json(handshake());
      if (parsed.pathname === "/v2/harnesses/cursor/auth-readiness") {
        return json({
          harnessId: "cursor",
          authRequest: "subscription",
          requestedSource: "native_session",
          readiness: {
            source: "native_session",
            availability: "available",
            verification: "passed",
          },
        });
      }
      if (parsed.pathname === "/v2/threads" && init.method === "POST") {
        return json({ id: "thread-cursor-profile-1" });
      }
      if (parsed.pathname === "/v2/threads/thread-cursor-profile-1/turns") {
        return json({
          jobId: "run-cursor-profile-1",
          threadId: "thread-cursor-profile-1",
          turnId: "turn-1",
        });
      }
      if (parsed.pathname === "/v2/threads/thread-cursor-profile-1") {
        return json({
          thread: { id: "thread-cursor-profile-1", headRunId: "run-cursor-profile-1" },
          sessions: [{ harnessId: "cursor", nativeSessionId: "cursor-session-1" }],
        });
      }
      if (parsed.pathname === "/v2/runs/run-cursor-profile-1") {
        return json({
          summary: {
            state: "succeeded",
            waitingOnUser: false,
            // Mirrors the observed subscription route: token counts are
            // reported, cost is not (Claudexor only emits a spend figure when
            // the provider supplies `total_cost_usd`, which the Cursor
            // subscription route does not).
            inputTokens: 29_985,
            outputTokens: 33,
            cachedInputTokens: 5_957,
          },
          finalSummary: "Cursor done.",
        });
      }
      if (parsed.pathname === "/v2/runs/run-cursor-profile-1/produced") {
        return json({ artifacts: [] });
      }
      if (parsed.pathname === "/v2/runs/run-cursor-profile-1/events") {
        return new Response(
          [
            "id: 1",
            "event: run.status",
            'data: {"summary":{"state":"running","waitingOnUser":false}}',
            "",
          ].join("\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      throw new Error(`unexpected route: ${init.method ?? "GET"} ${parsed.pathname}`);
    };
    const adapter = createCursorProfileExecutionAdapter({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch,
    });

    const handle = await adapter.start(cursorInput);
    await adapter.resume(handle.executionId, []);
    const events = [];
    for await (const event of adapter.events(handle.executionId)) events.push(event);

    await expect(adapter.result(handle.executionId)).resolves.toMatchObject({
      status: "succeeded",
      summary: "Cursor done.",
      sessionId: "cursor-session-1",
      telemetry: {
        engine: "cursor",
        usage: {
          inputUnits: { availability: "available", value: 29_985, confidence: "exact" },
          outputUnits: { availability: "available", value: 33, confidence: "exact" },
          cacheReadUnits: { availability: "available", value: 5_957, confidence: "exact" },
        },
      },
    });
    await expect(adapter.diagnoseAuthRoute()).resolves.toMatchObject({
      status: "pass",
      code: "CURSOR_NATIVE_SESSION_ATTESTED",
    });

    expect(events).toEqual([{ schemaVersion: 3, cursor: "1", kind: "status", status: "running" }]);
    const creates = calls.filter((call) => call.path === "/v2/threads");
    const turns = calls.filter((call) => call.path.endsWith("/turns"));
    expect(creates[0]?.body).toMatchObject({
      authPreference: "subscription",
      primaryHarness: "cursor",
      eligibleHarnesses: ["cursor"],
    });
    // The load-bearing assertion. Claudexor's INV-135 treats a cursor
    // credential profile as exactly an API key, so forwarding `cursor-main`
    // here would silently move the run onto the metered route that §10.4's
    // billing guard forbids.
    expect(creates[0]?.body).not.toHaveProperty("credentialProfileId");
    expect(turns).toHaveLength(2);
    expect(turns[0]?.body).toMatchObject({
      authPreference: "subscription",
      harnesses: ["cursor"],
      primaryHarness: "cursor",
      model: "cursor-auto",
    });
    expect(turns[0]?.body).not.toHaveProperty("credentialProfileId");
  });

  it.each([
    ["native", { executionMode: "native" }],
    ["non-Cursor", { engine: "claude" }],
    ["non-subscription", { billing: undefined }],
  ])("rejects %s profiles before a Cursor adapter sends control traffic", async (_n, profile) => {
    let calls = 0;
    const adapter = createCursorProfileExecutionAdapter({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch: async () => {
        calls += 1;
        return json({});
      },
    });
    await expect(
      adapter.start({ ...cursorInput, profile: { ...cursorInput.profile, ...profile } as never }),
    ).rejects.toBeInstanceOf(ClaudexorControlError);
    expect(calls).toBe(0);
  });

  it("blocks Cursor before thread creation when native-session attestation fails", async () => {
    const paths: string[] = [];
    const adapter = createCursorProfileExecutionAdapter({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path === "/v2/handshake") return json(handshake());
        if (path === "/v2/harnesses/cursor/auth-readiness") {
          return json({
            harnessId: "cursor",
            authRequest: "subscription",
            requestedSource: "native_session",
            readiness: {
              source: "native_session",
              // Exactly what the pinned daemon returns when it cannot see the
              // keychain-backed Cursor login (Q018 §I).
              availability: "unavailable",
              verification: "not_run",
            },
          });
        }
        throw new Error(`model work must not start: ${path}`);
      },
    });

    await expect(adapter.start(cursorInput)).rejects.toMatchObject({
      code: "cursor_native_session_unattested",
      operation: "authReadiness",
    });
    expect(paths).toEqual(["/v2/handshake", "/v2/harnesses/cursor/auth-readiness"]);
    await expect(adapter.diagnoseAuthRoute()).resolves.toMatchObject({
      status: "fail",
      code: "CURSOR_NATIVE_SESSION_UNATTESTED",
    });
  });

  it("re-attests the Cursor session on resume and refuses a revoked one", async () => {
    let attested = true;
    const paths: string[] = [];
    const fetch: typeof globalThis.fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === "/v2/handshake") return json(handshake());
      if (path === "/v2/harnesses/cursor/auth-readiness") {
        return json({
          harnessId: "cursor",
          authRequest: "subscription",
          requestedSource: "native_session",
          readiness: {
            source: "native_session",
            availability: attested ? "available" : "unavailable",
            verification: attested ? "passed" : "not_run",
          },
        });
      }
      if (path === "/v2/threads" && init.method === "POST") return json({ id: "thread-cursor-2" });
      if (path === "/v2/threads/thread-cursor-2/turns") {
        return json({ jobId: "run-cursor-2", threadId: "thread-cursor-2", turnId: "turn-1" });
      }
      throw new Error(`unexpected route: ${path}`);
    };
    const adapter = createCursorProfileExecutionAdapter({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch,
    });

    const handle = await adapter.start(cursorInput);
    attested = false;
    await expect(adapter.resume(handle.executionId, [])).rejects.toMatchObject({
      code: "cursor_native_session_unattested",
    });
    // The refused resume must not have created a second turn.
    expect(paths.filter((path) => path.endsWith("/turns"))).toHaveLength(1);
  });

  it("substitutes a typed summary when Cursor ends successfully with no final text", async () => {
    // Regression for the Q018 spike defect: Cursor can terminate a run as
    // `subtype: "success"` with an empty `result` and no assistant frame, so
    // Claudexor emits no final message at all. A blank summary would violate
    // `ExecutionResultV3.summary`'s minLength of 1.
    const adapter = createCursorProfileExecutionAdapter({
      baseUrl: "http://127.0.0.1:43001",
      expectedEngine,
      fetch: async (url, init = {}) => {
        const path = new URL(String(url)).pathname;
        if (path === "/v2/handshake") return json(handshake());
        if (path === "/v2/harnesses/cursor/auth-readiness") {
          return json({
            harnessId: "cursor",
            authRequest: "subscription",
            requestedSource: "native_session",
            readiness: {
              source: "native_session",
              availability: "available",
              verification: "passed",
            },
          });
        }
        if (path === "/v2/threads" && init.method === "POST")
          return json({ id: "thread-cursor-3" });
        if (path === "/v2/threads/thread-cursor-3/turns") {
          return json({ jobId: "run-cursor-3", threadId: "thread-cursor-3", turnId: "turn-1" });
        }
        if (path === "/v2/threads/thread-cursor-3") {
          return json({
            thread: { id: "thread-cursor-3", headRunId: "run-cursor-3" },
            sessions: [{ harnessId: "cursor", nativeSessionId: "cursor-session-3" }],
          });
        }
        if (path === "/v2/runs/run-cursor-3") {
          return json({
            summary: { state: "succeeded", waitingOnUser: false },
            // Whitespace-only, not merely absent: this is the shape that would
            // slip past a bare length check.
            finalSummary: "   \n  ",
          });
        }
        if (path === "/v2/runs/run-cursor-3/produced") return json({ artifacts: [] });
        throw new Error(`unexpected route: ${path}`);
      },
    });

    const handle = await adapter.start(cursorInput);
    const result = await adapter.result(handle.executionId);
    expect(result.summary).toBe("Claudexor execution succeeded.");
    expect(result.summary.trim().length).toBeGreaterThan(0);
  });
});
