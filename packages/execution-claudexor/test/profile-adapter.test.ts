import type { ExecutionRequestV3 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  CLAUDEXOR_ENGINE_SHA,
  CLAUDEXOR_ENGINE_VERSION,
  ClaudexorControlError,
  createClaudeProfileExecutionAdapter,
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

describe("ExecutionBackendV3 Claude profile conformance", () => {
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

    expect(events).toEqual([
      { schemaVersion: 1, cursor: "41", kind: "status", status: "running" },
      { schemaVersion: 1, cursor: "42", kind: "rate_limited", retryAfterMs: 1_200 },
      {
        schemaVersion: 1,
        cursor: "43",
        kind: "context_pressure",
        pressure: "capacity_exhausted",
      },
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
});
