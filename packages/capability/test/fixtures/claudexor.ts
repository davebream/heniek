import {
  CLAUDEXOR_ENGINE_SHA,
  CLAUDEXOR_ENGINE_VERSION,
  CLAUDEXOR_PROTOCOL_MAJOR,
} from "@heniek/execution-claudexor";

export const OBSERVED_AT = "2026-08-07T10:00:00.000Z";

const operations = [
  ["GET", "/v2/agent-capabilities"],
  ["GET", "/v2/credential-profiles"],
  ["GET", "/v2/harnesses"],
  ["GET", "/v2/harnesses/:id/models"],
  ["POST", "/v2/harnesses/:id/auth-readiness"],
  ["GET", "/v2/quota"],
].map(([method, path]) => ({ method, path }));

export const responses: Record<string, unknown> = {
  "POST /v2/handshake": {
    compatible: true,
    protocolMajor: CLAUDEXOR_PROTOCOL_MAJOR,
    operationsPath: "/v2/operations",
    engine: { version: CLAUDEXOR_ENGINE_VERSION, sha: CLAUDEXOR_ENGINE_SHA },
  },
  "GET /v2/operations": { operations },
  "GET /v2/harnesses": {
    harnesses: [
      {
        id: "claude",
        status: "ok",
        checks: [{ id: "installed", status: "pass", detail: "1.2.3" }],
        manifest: {
          version: "1.2.3",
          capabilities: {
            interactive: true,
            json_schema_output: true,
            read_files: true,
            browser_tool: true,
            tool_lists: true,
            effort_levels: ["low", "high"],
            model_effort_levels: {
              "claude-sonnet": { levels: ["low", "high"], default: "high" },
            },
          },
          capability_profile: { mcp_injection: true },
        },
      },
      {
        id: "codex",
        status: "ok",
        checks: [{ id: "installed", status: "pass", detail: "2.3.4" }],
        manifest: {
          version: "2.3.4",
          capabilities: {
            interactive: false,
            json_schema_output: true,
            read_files: true,
            browser_tool: true,
            tool_lists: true,
            model_effort_levels: {
              "gpt-5-codex": { levels: ["medium", "high"], default: "medium" },
            },
          },
          capability_profile: { mcp_injection: true },
        },
      },
      {
        id: "cursor",
        status: "ok",
        checks: [{ id: "installed", status: "pass", detail: "3.4.5" }],
        manifest: {
          version: "3.4.5",
          capabilities: {
            interactive: false,
            json_schema_output: false,
            read_files: true,
            browser_tool: false,
            tool_lists: false,
          },
          capability_profile: { mcp_injection: false },
        },
      },
    ],
  },
  "GET /v2/credential-profiles": {
    profiles: [
      {
        profile: {
          profile_id: "codex-work",
          harness_id: "codex",
          display_name: "Codex work",
          credential_kind: "config_dir_login",
        },
        status: { availability: "available", verification: "passed" },
        identity: { email: "must-not-leak@example.invalid", plan: "private" },
      },
      {
        profile: {
          profile_id: "cursor-work",
          harness_id: "cursor",
          display_name: "Cursor work",
          credential_kind: "api_key",
        },
        status: { availability: "available", verification: "passed" },
        identity: { email: "also-private@example.invalid" },
      },
    ],
    harnessAccounts: [
      {
        harness_id: "claude",
        native_credentials_enabled: true,
        native_login_detected: true,
        next_up: null,
        identity: { email: "private@example.invalid" },
      },
    ],
  },
  "GET /v2/agent-capabilities": {
    ok: true,
    version: CLAUDEXOR_ENGINE_VERSION,
    harnesses: [{ id: "claude" }, { id: "codex" }, { id: "cursor" }],
  },
  "GET /v2/quota": {
    snapshots: [
      { subject: { harness: "claude" }, constraints: [{ id: "window", used_ratio: 0.2 }] },
      {
        subject: { harness: "codex", subject_id: "codex-work" },
        constraints: [{ id: "window", used_ratio: 0.5 }],
      },
    ],
    absences: [
      {
        subject: { harness: "cursor", subject_id: "cursor-work" },
        reason: "no_source",
        observed_at: OBSERVED_AT,
      },
    ],
  },
  "GET /v2/harnesses/claude/models": {
    source: "manifest",
    models: [{ id: "claude-sonnet", label: "Sonnet" }],
  },
  "GET /v2/harnesses/codex/models": {
    source: "api",
    models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }],
  },
  "GET /v2/harnesses/cursor/models": {
    source: "api",
    models: [{ id: "cursor-auto" }],
  },
  "POST /v2/harnesses/claude/auth-readiness": {
    readiness: { availability: "available", verification: "passed" },
  },
  "POST /v2/harnesses/codex/auth-readiness": {
    readiness: { availability: "available", verification: "passed" },
  },
  "POST /v2/harnesses/cursor/auth-readiness": {
    readiness: { availability: "available", verification: "passed" },
  },
};

export function fixtureFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const key = `${(init?.method ?? "GET").toUpperCase()} ${path}`;
    const value = key in overrides ? overrides[key] : responses[key];
    if (value instanceof Error) return new Response(value.message, { status: 503 });
    if (value === undefined) return new Response("not found", { status: 404 });
    return Response.json(value);
  }) as typeof fetch;
}
