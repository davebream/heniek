import { createHash } from "node:crypto";
import type {
  BackendArtifactId,
  BackendArtifactV1,
  BackendExecutionId,
  ExecutionBackendV2,
  ExecutionEventV3,
  ExecutionRequestV2,
  ExecutionRequestV3,
  ExecutionRequestV4,
  ExecutionResultV2,
  ExecutionResultV4,
  ExecutionResultV5,
  ExecutionResumeRequestV1,
  ExecutionStatus,
  ExecutionTelemetryV1,
  InteractionAnswerSetV1,
  InteractionId,
  InteractionQuestionId,
  PendingInteractionV2,
} from "@heniek/contracts";
import { createTelemetryReducer, type TelemetryMetricName } from "@heniek/telemetry";
import type { Static } from "@sinclair/typebox";
import {
  type ClaudexorDiagnostic,
  type DiagnosticRunner,
  diagnoseRuntimeAvailability,
  diagnoseSubscriptionRoute,
} from "./diagnostics.js";
import {
  CLAUDEXOR_PROTOCOL_MAJOR,
  type ClaudexorEngineIdentity,
  claudexorHeaders,
  parseHandshake,
  REQUIRED_OPERATION_IDEMPOTENCY,
  REQUIRED_OPERATIONS,
} from "./protocol.js";

export interface ClaudexorBackendOptions {
  readonly baseUrl: string;
  readonly expectedEngine: ClaudexorEngineIdentity;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMilliseconds?: number;
  readonly runtimeEntryPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly claudeCommand?: string;
  readonly diagnosticRunner?: DiagnosticRunner;
}

export interface ClaudexorExecutionBackend extends Omit<ExecutionBackendV2, "resume"> {
  resume(request: Static<typeof ExecutionResumeRequestV1>): Promise<void>;
  /** Internal primitive used by the subscription-only profile adapter. */
  startProfile(
    request: Static<typeof ExecutionRequestV3>,
  ): Promise<Static<typeof import("@heniek/contracts").BackendExecutionHandleV1>>;
  /** Q021 primitive: explicit profile/account plus a non-escalating permission envelope. */
  startScheduled(
    request: Static<typeof ExecutionRequestV4>,
  ): Promise<Static<typeof import("@heniek/contracts").BackendExecutionHandleV1>>;
  /** Internal primitive used by the subscription-only profile adapter. */
  resumeProfile(request: Static<typeof ExecutionResumeRequestV1>): Promise<void>;
  /** Normalized, replayable lifecycle facts; raw SSE payloads never escape. */
  events(executionId: string, after?: string): AsyncIterable<Static<typeof ExecutionEventV3>>;
  /** Internal structured result used by the Q019 profile adapter. */
  resultProfile(executionId: string): Promise<Static<typeof ExecutionResultV4>>;
  resultScheduled(executionId: string): Promise<Static<typeof ExecutionResultV5>>;
  diagnoseCompatibility(): Promise<readonly ClaudexorDiagnostic[]>;
  diagnoseRuntime(): Promise<ClaudexorDiagnostic>;
  diagnoseAuthRoute(): Promise<ClaudexorDiagnostic>;
  diagnoseCodexAuthRoute(): Promise<ClaudexorDiagnostic>;
  diagnoseCursorAuthRoute(): Promise<ClaudexorDiagnostic>;
}

export class ClaudexorControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly operation: string,
  ) {
    super(`${operation} failed: HTTP ${status} (${code})`);
    this.name = "ClaudexorControlError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}

function requiredString(value: unknown, name: string, operation: string): string {
  const found = field(value, name);
  if (typeof found !== "string" || found.length === 0) {
    throw new ClaudexorControlError(200, "malformed", operation);
  }
  return found;
}

function safeArtifactPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").some((segment) => segment === ".." || segment.length === 0)
  );
}

function stateOf(run: unknown): string {
  const summary = field(run, "summary");
  return requiredString(summary, "state", "getRun");
}

function mapStatus(run: unknown): ExecutionStatus {
  const state = stateOf(run);
  const waiting = field(field(run, "summary"), "waitingOnUser") === true;
  if ((state === "queued" || state === "running") && waiting) return "waiting_on_user";
  if (state === "queued" || state === "running") return state;
  if (state === "succeeded" || state === "failed" || state === "cancelled") return state;
  if (state === "interrupted") return "recovery_required";
  throw new ClaudexorControlError(200, "unknown_state", "getRun");
}

function idempotencyKey(kind: string, source: string): string {
  return `heniek-${kind}-${createHash("sha256").update(source).digest("hex").slice(0, 40)}`;
}

function encodedArtifactPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

type ResolvedProfile =
  | Static<typeof ExecutionRequestV3>["profile"]
  | Static<typeof ExecutionRequestV4>["profile"];
type ProfileHarness = "claude" | "codex" | "cursor";

const SUBSCRIPTION_AUTH_SOURCES = {
  claude: "oauth_token_env",
  codex: "native_session",
  cursor: "native_session",
} as const;
const SUBSCRIPTION_ROUTE_UNATTESTED_CODES = {
  claude: "claude_subscription_route_unattested",
  codex: "codex_native_session_unattested",
  cursor: "cursor_native_session_unattested",
} as const;

interface SubscriptionProfileRoute {
  readonly harness: ProfileHarness;
  readonly credentialProfileId?: string;
}

function subscriptionProfileRoute(
  profile: ResolvedProfile,
  operation: string,
): SubscriptionProfileRoute {
  if (profile.engine !== "claude" && profile.engine !== "codex" && profile.engine !== "cursor") {
    throw new ClaudexorControlError(400, "unsupported_profile", operation);
  }
  if (
    profile.executionMode !== "external" ||
    profile.billing !== "subscription" ||
    (profile.engine === "claude" &&
      (typeof profile.accountId !== "string" || profile.accountId.length === 0))
  ) {
    throw new ClaudexorControlError(400, "unsupported_profile", operation);
  }
  // Codex's selected ChatGPT session and Cursor's keychain-backed login both
  // belong to Claudexor, not to a Heniek account label. A resolved Heniek
  // account may still identify the user's profile, but must never be forwarded
  // as a Claudexor credential-profile id when the route is `native_session`.
  //
  // For Cursor this is not merely a naming preference: Claudexor's INV-135
  // treats a cursor credential profile as *exactly* an API key and refuses any
  // other transport, so forwarding an account id here would silently move the
  // run onto the metered API-key route that §10.4's billing guard forbids.
  if (profile.engine === "codex") return { harness: "codex" };
  if (profile.engine === "cursor") return { harness: "cursor" };
  const accountId = profile.accountId;
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new ClaudexorControlError(400, "unsupported_profile", operation);
  }
  return {
    harness: "claude",
    credentialProfileId: accountId,
  };
}

function statusFromEvent(value: unknown): ExecutionStatus | undefined {
  const summary = isRecord(field(value, "summary"))
    ? field(value, "summary")
    : isRecord(value)
      ? value
      : undefined;
  const state = field(summary, "state");
  if (typeof state !== "string") return undefined;
  try {
    return mapStatus({ summary });
  } catch {
    return undefined;
  }
}

function retryAfterMs(value: unknown): number | undefined {
  const rateLimit = field(field(value, "payload"), "rate_limit");
  if (!isRecord(rateLimit)) return undefined;
  const candidate = field(rateLimit, "retry_after_ms") ?? field(rateLimit, "retryAfterMs");
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

function hasRateLimit(value: unknown): boolean {
  return isRecord(field(field(value, "payload"), "rate_limit"));
}

function hasContextCapacityExhaustion(value: unknown): boolean {
  const facts = field(value, "outcomeFacts") ?? field(field(value, "summary"), "outcomeFacts");
  return field(facts, "reason") === "context_capacity_exhausted";
}

function harnessPayload(value: unknown): Record<string, unknown> | undefined {
  const payload = field(value, "payload");
  if (field(value, "type") === "harness.event" && isRecord(payload)) return payload;
  return isRecord(value) ? value : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const candidate = finiteNonNegative(value);
  return candidate !== undefined && Number.isSafeInteger(candidate) ? candidate : undefined;
}

const TOOL_KINDS = new Set(["web", "file", "command", "mcp", "search", "other"]);
const TOOL_OUTCOMES = new Map([
  ["ok", "succeeded"],
  ["error", "failed"],
  ["cancelled", "cancelled"],
  ["denied", "denied"],
] as const);

function normalizedTool(value: unknown):
  | {
      readonly name: string;
      readonly kind: "web" | "file" | "command" | "mcp" | "search" | "other";
      readonly useId?: string;
    }
  | undefined {
  const name = field(value, "name");
  const kind = field(value, "kind");
  const useId = field(value, "use_id");
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    typeof kind !== "string" ||
    !TOOL_KINDS.has(kind)
  ) {
    return undefined;
  }
  return {
    name,
    kind: kind as "web" | "file" | "command" | "mcp" | "search" | "other",
    ...(typeof useId === "string" && useId.length > 0 ? { useId } : {}),
  };
}

function firstField(value: unknown, names: readonly string[]): { found: boolean; value: unknown } {
  if (!isRecord(value)) return { found: false, value: undefined };
  for (const name of names) {
    if (Object.hasOwn(value, name)) return { found: true, value: value[name] };
  }
  return { found: false, value: undefined };
}

function normalizedTelemetry(
  value: unknown,
  options: {
    readonly engine: "claude" | "codex" | "cursor";
    readonly executionMode: "external" | "native";
    readonly evidenceRef: string;
    readonly providerSessionId?: unknown;
    readonly capacityExhausted?: boolean;
  },
): Static<typeof ExecutionTelemetryV1> {
  const reducer = createTelemetryReducer(options);
  const metrics: Partial<
    Record<
      TelemetryMetricName,
      { value: unknown; confidence: "exact" | "estimated"; aggregation: "cumulative" | "gauge" }
    >
  > = {};
  const mappings = [
    ["inputUnits", ["input_tokens", "inputTokens"], "cumulative"],
    ["outputUnits", ["output_tokens", "outputTokens"], "cumulative"],
    ["cacheReadUnits", ["cache_read_tokens", "cacheReadTokens"], "cumulative"],
    [
      "cacheWriteUnits",
      ["cache_write_input_tokens", "cacheWriteInputTokens", "cacheWriteTokens"],
      "cumulative",
    ],
    ["totalUnits", ["total_tokens", "totalTokens"], "cumulative"],
    ["costUsd", ["cost_usd", "costUsd", "spendUsd"], "cumulative"],
    ["wallDurationMs", ["duration_ms", "durationMs"], "gauge"],
    ["apiDurationMs", ["duration_api_ms", "durationApiMs"], "gauge"],
    ["contextUsedUnits", ["context_used_tokens", "contextUsedTokens"], "gauge"],
    ["contextWindowUnits", ["context_window_tokens", "contextWindowTokens"], "gauge"],
    ["contextUtilization", ["context_utilization", "contextUtilization"], "gauge"],
  ] as const;
  const estimated = field(value, "estimated") ?? field(value, "spendEstimated");
  for (const [name, aliases, aggregation] of mappings) {
    const candidate = firstField(value, aliases);
    if (!candidate.found) continue;
    metrics[name] = {
      value: candidate.value,
      confidence: name === "costUsd" && estimated === true ? "estimated" : "exact",
      aggregation,
    };
  }
  const cachedInput = firstField(value, ["cached_input_tokens", "cachedInputTokens"]);
  if (cachedInput.found) {
    // Claudexor combines Claude cache reads and cache creation into one counter.
    // Codex and Cursor expose the same normalized field as cache reads.
    metrics[options.engine === "claude" ? "cachedInputUnits" : "cacheReadUnits"] = {
      value: cachedInput.value,
      confidence: "exact",
      aggregation: "cumulative",
    };
  }
  const usedPercentage = firstField(value, ["used_percentage", "usedPercentage"]);
  if (usedPercentage.found && typeof usedPercentage.value === "number") {
    metrics.contextUtilization = {
      value: usedPercentage.value / 100,
      confidence: "estimated",
      aggregation: "gauge",
    };
  }
  reducer.observe({
    providerSessionId: options.providerSessionId,
    metrics,
    ...(options.capacityExhausted === undefined
      ? {}
      : { capacityExhausted: options.capacityExhausted }),
  });
  return reducer.snapshot();
}

function normalizedDiff(
  value: unknown,
): { readonly files: number; readonly additions: number; readonly deletions: number } | undefined {
  const files = nonNegativeInteger(field(value, "files"));
  const additions = nonNegativeInteger(field(value, "additions"));
  const deletions = nonNegativeInteger(field(value, "deletions"));
  return files === undefined || additions === undefined || deletions === undefined
    ? undefined
    : { files, additions, deletions };
}

interface ParsedSseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: unknown;
}

function parseSse(text: string): readonly ParsedSseEvent[] {
  const result: ParsedSseEvent[] = [];
  for (const frame of text.replace(/\r\n/g, "\n").split("\n\n")) {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (id === undefined || id.length === 0 || event === undefined || data.length === 0) continue;
    try {
      result.push({ id, event, data: JSON.parse(data.join("\n")) });
    } catch {
      // A malformed or non-JSON provider frame is not a public event.
    }
  }
  return result;
}

export function createClaudexorExecutionBackend(
  options: ClaudexorBackendOptions,
): ClaudexorExecutionBackend {
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 60_000;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  let handshakeComplete = false;
  const profiles = new Map<string, ResolvedProfile>();

  async function callJson(
    method: string,
    path: string,
    operation: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: { ...claudexorHeaders(options.token), ...extraHeaders },
      signal: AbortSignal.timeout(timeoutMilliseconds),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await request(`${baseUrl}${path}`, init);
    const responseText = await response.text();
    let parsed: unknown = null;
    try {
      parsed = responseText.length === 0 ? null : JSON.parse(responseText);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      throw new ClaudexorControlError(response.status, "remote_error", operation);
    }
    return parsed;
  }

  async function callBytes(path: string, operation: string): Promise<Uint8Array> {
    const response = await request(`${baseUrl}${path}`, {
      method: "GET",
      headers: claudexorHeaders(options.token),
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    if (!response.ok) throw new ClaudexorControlError(response.status, "unknown", operation);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function callText(
    path: string,
    operation: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<string> {
    const response = await request(`${baseUrl}${path}`, {
      method: "GET",
      headers: { ...claudexorHeaders(options.token), ...extraHeaders },
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    if (!response.ok) throw new ClaudexorControlError(response.status, "remote_error", operation);
    return response.text();
  }

  async function handshake(): Promise<void> {
    if (handshakeComplete) return;
    parseHandshake(
      await callJson("POST", "/v2/handshake", "handshake", {
        protocolMajor: CLAUDEXOR_PROTOCOL_MAJOR,
        client: "heniek-q012",
      }),
      options.expectedEngine,
    );
    handshakeComplete = true;
  }

  /**
   * Attest one harness's selected subscription route.
   *
   * Every one of the six comparisons is load-bearing: Claudexor echoes the
   * request back, so checking only `readiness` would accept an answer about a
   * different harness or a different auth source than the one asked for.
   */
  async function subscriptionRouteAttested(harness: ProfileHarness): Promise<boolean> {
    const source = SUBSCRIPTION_AUTH_SOURCES[harness];
    const response = await callJson(
      "POST",
      `/v2/harnesses/${encodeURIComponent(harness)}/auth-readiness`,
      "authReadiness",
      { authRequest: "subscription", source },
    );
    const readiness = field(response, "readiness");
    return (
      field(response, "harnessId") === harness &&
      field(response, "authRequest") === "subscription" &&
      field(response, "requestedSource") === source &&
      field(readiness, "source") === source &&
      field(readiness, "availability") === "available" &&
      field(readiness, "verification") === "passed"
    );
  }

  async function requireSubscriptionRoute(harness: ProfileHarness): Promise<void> {
    if (!(await subscriptionRouteAttested(harness))) {
      throw new ClaudexorControlError(
        409,
        SUBSCRIPTION_ROUTE_UNATTESTED_CODES[harness],
        "authReadiness",
      );
    }
  }

  async function thread(executionId: string): Promise<unknown> {
    await handshake();
    return callJson("GET", `/v2/threads/${encodeURIComponent(executionId)}`, "getThread");
  }

  async function headRunId(executionId: string): Promise<string | null> {
    const value = field(field(await thread(executionId), "thread"), "headRunId");
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  async function run(executionId: string): Promise<unknown | null> {
    const id = await headRunId(executionId);
    return id === null ? null : callJson("GET", `/v2/runs/${encodeURIComponent(id)}`, "getRun");
  }

  async function createTurn(
    executionId: string,
    prompt: string,
    keySource: string,
    limits?: { readonly maxDurationMs?: number; readonly maxTurns?: number },
    profile?: ResolvedProfile,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      prompt,
      mode: "agent",
      harnesses: ["claude"],
      primaryHarness: "claude",
      // Claudexor v3.1.2 reserves `subscription` for native-session login.
      // Q004 provides only the OAuth carrier and excludes every API-key route,
      // so `auto` can resolve only to that attested subscription source.
      authPreference: "auto",
      access: "workspace_write",
    };
    if (profile !== undefined) {
      const route = subscriptionProfileRoute(profile, "createTurn");
      body.harnesses = [route.harness];
      body.primaryHarness = route.harness;
      body.authPreference = "subscription";
      if (route.credentialProfileId !== undefined) {
        body.credentialProfileId = route.credentialProfileId;
      }
      body.model = profile.model;
      body.effort = profile.effort;
    }
    if (limits?.maxTurns !== undefined) body.maxTurns = limits.maxTurns;
    if (limits?.maxDurationMs !== undefined) {
      body.maxSeconds = Math.max(1, Math.ceil(limits.maxDurationMs / 1_000));
    }
    const created = await callJson(
      "POST",
      `/v2/threads/${encodeURIComponent(executionId)}/turns`,
      "createTurn",
      body,
      { "Idempotency-Key": idempotencyKey("turn", keySource) },
    );
    if (
      field(created, "threadId") !== executionId ||
      typeof field(created, "turnId") !== "string" ||
      (typeof field(created, "runId") !== "string" && typeof field(created, "jobId") !== "string")
    ) {
      throw new ClaudexorControlError(200, "malformed", "createTurn");
    }
  }

  async function listedArtifacts(executionId: string): Promise<Static<typeof BackendArtifactV1>[]> {
    const id = await headRunId(executionId);
    if (id === null) return [];
    const response = await callJson(
      "GET",
      `/v2/runs/${encodeURIComponent(id)}/produced`,
      "listProduced",
    );
    const raw = field(response, "artifacts");
    if (!Array.isArray(raw)) throw new ClaudexorControlError(200, "malformed", "listProduced");
    return raw.flatMap((entry) => {
      if (!isRecord(entry) || entry.kind !== "file" || typeof entry.path !== "string") return [];
      if (!safeArtifactPath(entry.path)) {
        throw new ClaudexorControlError(200, "unsafe_artifact_path", "listProduced");
      }
      if (
        typeof entry.bytes !== "number" ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0
      ) {
        throw new ClaudexorControlError(200, "malformed", "listProduced");
      }
      const bytes = entry.bytes;
      const mime = typeof entry.mime === "string" ? entry.mime : "application/octet-stream";
      return [
        {
          schemaVersion: 1 as const,
          id: entry.path as BackendArtifactId,
          // Claudexor's /produced paths are relative to its project's
          // `artifacts/` output root. Heniek declares artifact paths relative
          // to the repository, while retaining the upstream value as opaque ID.
          path: `artifacts/${entry.path}`,
          byteLength: bytes,
          mediaType: mime,
        },
      ];
    });
  }

  return {
    async start(input: Static<typeof ExecutionRequestV2>) {
      await handshake();
      const created = await callJson(
        "POST",
        "/v2/threads",
        "createThread",
        {
          title: `Heniek ${input.runId}`,
          scope: { kind: "project", root: input.workingDirectory, context: "auto" },
          workspace: "in_place",
          // See createTurn: the isolated process environment makes this
          // auto-selection subscription-only in practice.
          authPreference: "auto",
          primaryHarness: "claude",
          eligibleHarnesses: ["claude"],
          access: "workspace_write",
        },
        { "Idempotency-Key": idempotencyKey("thread", input.runId) },
      );
      const executionId = requiredString(created, "id", "createThread");
      await createTurn(
        executionId,
        `${input.prompt}\n\nWrite the requested final artifact to ${input.artifactPath}. ` +
          "Do not write outside the current workspace. Finish with a concise summary.",
        `${input.runId}:${input.stageId}:initial`,
        input.limits,
      );
      return { schemaVersion: 1, executionId: executionId as BackendExecutionId };
    },

    async startProfile(input: Static<typeof ExecutionRequestV3>) {
      const route = subscriptionProfileRoute(input.profile, "startProfile");
      await handshake();
      await requireSubscriptionRoute(route.harness);
      const created = await callJson(
        "POST",
        "/v2/threads",
        "createThread",
        {
          title: `Heniek ${input.runId}`,
          scope: { kind: "project", root: input.workingDirectory, context: "auto" },
          workspace: "in_place",
          authPreference: "subscription",
          ...(route.credentialProfileId === undefined
            ? {}
            : { credentialProfileId: route.credentialProfileId }),
          primaryHarness: route.harness,
          eligibleHarnesses: [route.harness],
          access: "workspace_write",
        },
        {
          "Idempotency-Key": idempotencyKey(
            "thread",
            `${input.runId}:${input.profile.fingerprint}`,
          ),
        },
      );
      const executionId = requiredString(created, "id", "createThread");
      await createTurn(
        executionId,
        `${input.prompt}\n\nWrite the requested final artifact to ${input.artifactPath}. ` +
          "Do not write outside the current workspace. Finish with a concise summary.",
        `${input.runId}:${input.stageId}:${input.profile.fingerprint}:initial`,
        input.limits,
        input.profile,
      );
      profiles.set(executionId, input.profile);
      return { schemaVersion: 1, executionId: executionId as BackendExecutionId };
    },

    async startScheduled(input: Static<typeof ExecutionRequestV4>) {
      const route = subscriptionProfileRoute(input.profile, "startScheduled");
      await handshake();
      await requireSubscriptionRoute(route.harness);
      const created = await callJson(
        "POST",
        "/v2/threads",
        "createThread",
        {
          title: `Heniek ${input.runId}`,
          scope: { kind: "project", root: input.workingDirectory, context: "auto" },
          workspace: "in_place",
          authPreference: "subscription",
          ...(route.credentialProfileId === undefined
            ? {}
            : { credentialProfileId: route.credentialProfileId }),
          primaryHarness: route.harness,
          eligibleHarnesses: [route.harness],
          access: input.permissions.workspace === "read-only" ? "readonly" : "workspace_write",
        },
        {
          "Idempotency-Key": idempotencyKey(
            "thread",
            `${input.runId}:${input.profile.fingerprint}`,
          ),
        },
      );
      const executionId = requiredString(created, "id", "createThread");
      await createTurn(
        executionId,
        `${input.prompt}\n\nWrite the requested final artifact to ${input.artifactPath}. ` +
          "Do not write outside the current workspace. Finish with a concise summary.",
        `${input.runId}:${input.stageId}:${input.profile.fingerprint}:initial`,
        input.limits,
        input.profile,
      );
      profiles.set(executionId, input.profile);
      return { schemaVersion: 1, executionId: executionId as BackendExecutionId };
    },

    async status(executionId: string) {
      const value = await run(executionId);
      return value === null ? "queued" : mapStatus(value);
    },

    async interactions(executionId: string) {
      const value = await run(executionId);
      if (value === null) return [];
      const raw = field(value, "pendingInteractions");
      if (!Array.isArray(raw)) return [];
      return raw.map((entry) => {
        const interactionId = requiredString(entry, "interactionId", "getInteractions");
        const questions = field(entry, "questions");
        if (!Array.isArray(questions) || questions.length === 0) {
          throw new ClaudexorControlError(200, "malformed", "getInteractions");
        }
        return {
          schemaVersion: 2 as const,
          id: interactionId as InteractionId,
          questions: questions.map((question) => {
            const optionsValue = field(question, "options");
            const options = Array.isArray(optionsValue)
              ? optionsValue.map((option) => ({
                  label: requiredString(option, "label", "getInteractions"),
                  ...(typeof field(option, "description") === "string"
                    ? { description: field(option, "description") as string }
                    : {}),
                }))
              : [];
            const header = field(question, "header");
            return {
              id: requiredString(question, "id", "getInteractions") as InteractionQuestionId,
              prompt: requiredString(question, "question", "getInteractions"),
              ...(typeof header === "string" && header.length > 0 ? { header } : {}),
              options,
              multiSelect: field(question, "multi_select") === true,
            };
          }),
          requestedAt: requiredString(entry, "requestedAt", "getInteractions"),
          ...(typeof field(entry, "timeoutAt") === "string"
            ? { timeoutAt: field(entry, "timeoutAt") as string }
            : {}),
        } satisfies Static<typeof PendingInteractionV2>;
      });
    },

    async answer(executionId: string, answer: Static<typeof InteractionAnswerSetV1>) {
      const id = await headRunId(executionId);
      if (id === null) throw new ClaudexorControlError(409, "run_not_started", "answer");
      const response = await callJson(
        "POST",
        `/v2/runs/${encodeURIComponent(id)}/interactions/${encodeURIComponent(answer.interactionId)}/answer`,
        "answer",
        {
          answers: answer.answers.map((entry) => ({
            questionId: entry.questionId,
            selectedLabels: entry.selectedLabels,
            freeText: entry.freeText ?? null,
          })),
        },
      );
      if (field(response, "accepted") !== true || field(response, "status") !== "delivered") {
        throw new ClaudexorControlError(409, "answer_rejected", "answer");
      }
    },

    async resume(request: Static<typeof ExecutionResumeRequestV1>) {
      await createTurn(
        request.executionId,
        request.inputArtifactRefs.length === 0
          ? "Continue the stage from the current workspace state."
          : `Continue the stage using these Heniek input artifact references: ${request.inputArtifactRefs.join(", ")}.`,
        request.operationId,
      );
    },

    async resumeProfile(request: Static<typeof ExecutionResumeRequestV1>) {
      const profile = profiles.get(request.executionId);
      if (profile === undefined) {
        throw new ClaudexorControlError(409, "profile_context_unavailable", "resume");
      }
      // Re-attest before every resume: the session can be revoked or expire
      // between the original turn and the follow-up one.
      const resumeRoute = subscriptionProfileRoute(profile, "resume");
      await requireSubscriptionRoute(resumeRoute.harness);
      await createTurn(
        request.executionId,
        request.inputArtifactRefs.length === 0
          ? "Continue the stage from the current workspace state."
          : `Continue the stage using these Heniek input artifact references: ${request.inputArtifactRefs.join(", ")}.`,
        request.operationId,
        undefined,
        profile,
      );
    },

    async resultProfile(executionId: string): Promise<Static<typeof ExecutionResultV4>> {
      const value = await run(executionId);
      if (value === null) throw new ClaudexorControlError(409, "run_not_started", "resultProfile");
      const status = mapStatus(value);
      if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
        throw new ClaudexorControlError(409, "run_not_terminal", "resultProfile");
      }
      const summary = field(value, "summary");
      const rawSummary = field(value, "finalSummary");
      const rawError = field(summary, "error");
      const threadValue = await thread(executionId);
      const sessions = field(threadValue, "sessions");
      const profile = profiles.get(executionId);
      const session = Array.isArray(sessions)
        ? sessions.find((entry) => field(entry, "harnessId") === (profile?.engine ?? "claude"))
        : undefined;
      const sessionId = field(session, "nativeSessionId");
      const telemetry = normalizedTelemetry(summary, {
        engine: profile?.engine ?? "claude",
        executionMode: profile?.executionMode ?? "external",
        evidenceRef: `backend-result:${executionId}`,
        providerSessionId: sessionId,
        capacityExhausted: hasContextCapacityExhaustion(value),
      });
      const diff = normalizedDiff(field(field(summary, "result"), "diffStat"));
      return {
        schemaVersion: 4,
        status,
        // Trimmed, not just non-empty: Q018 observed Cursor terminate a run as
        // `subtype: "success"` with an empty `result` and no assistant frame at
        // all. A whitespace-only final would satisfy `minLength: 1` while
        // carrying no summary, so it falls through to the typed default rather
        // than surfacing a blank one.
        summary:
          typeof rawSummary === "string" && rawSummary.trim().length > 0
            ? rawSummary
            : typeof rawError === "string" && rawError.trim().length > 0
              ? rawError
              : `Claudexor execution ${status}.`,
        ...(typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}),
        artifacts: await listedArtifacts(executionId),
        telemetry,
        ...(diff === undefined ? {} : { diff }),
      };
    },

    async resultScheduled(executionId: string): Promise<Static<typeof ExecutionResultV5>> {
      const result = await this.resultProfile(executionId);
      const failure =
        result.status === "succeeded"
          ? undefined
          : result.status === "cancelled"
            ? {
                schemaVersion: 1 as const,
                classification: "cancelled" as const,
                phase: "running" as const,
                code: "cancelled",
                message: "Execution was cancelled.",
                fallbackEligible: false,
              }
            : result.telemetry.context.pressure.state === "exhausted"
              ? {
                  schemaVersion: 1 as const,
                  classification: "context_capacity_exhausted" as const,
                  phase: "running" as const,
                  code: "context_capacity_exhausted",
                  message: "Execution exhausted the available context capacity.",
                  fallbackEligible: true,
                }
              : {
                  schemaVersion: 1 as const,
                  classification: "unknown" as const,
                  phase: "completion" as const,
                  code: "provider_failure",
                  message: "Provider execution failed without a safe fallback classification.",
                  fallbackEligible: false,
                };
      return {
        ...result,
        schemaVersion: 5,
        ...(failure === undefined ? {} : { failure }),
      };
    },

    async result(executionId: string): Promise<Static<typeof ExecutionResultV2>> {
      const result = await this.resultProfile(executionId);
      return {
        schemaVersion: 2,
        status: result.status,
        summary: result.summary,
        ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        artifacts: result.artifacts,
      };
    },

    async cancel(executionId: string) {
      const id = await headRunId(executionId);
      if (id === null) return;
      const response = await callJson(
        "POST",
        `/v2/runs/${encodeURIComponent(id)}/control`,
        "cancel",
        {
          control: { kind: "cancel", reason: "cancelled by Heniek" },
        },
      );
      const controlStatus = field(response, "status");
      if (
        field(response, "accepted") !== true ||
        (controlStatus !== "applied" && controlStatus !== "queued")
      ) {
        throw new ClaudexorControlError(409, "cancel_rejected", "cancel");
      }
    },

    artifacts: listedArtifacts,

    async readArtifact(executionId: string, artifactId: string) {
      const artifacts = await listedArtifacts(executionId);
      const artifact = artifacts.find((entry) => entry.id === artifactId);
      if (artifact === undefined || !safeArtifactPath(artifact.path)) {
        throw new ClaudexorControlError(404, "artifact_not_found", "readProduced");
      }
      const id = await headRunId(executionId);
      if (id === null) throw new ClaudexorControlError(404, "run_not_started", "readProduced");
      return callBytes(
        `/v2/runs/${encodeURIComponent(id)}/produced/${encodedArtifactPath(artifact.id)}`,
        "readProduced",
      );
    },

    async *events(executionId: string, after?: string) {
      const id = await headRunId(executionId);
      if (id === null) return;
      const text = await callText(
        `/v2/runs/${encodeURIComponent(id)}/events`,
        "events",
        after === undefined ? {} : { "Last-Event-ID": after },
      );
      for (const event of parseSse(text)) {
        const status = statusFromEvent(event.data);
        const profile = profiles.get(executionId);
        const engine = profile?.engine ?? "claude";
        const executionMode = profile?.executionMode ?? "external";
        if (status !== undefined) {
          yield { schemaVersion: 3, cursor: event.id, kind: "status", status } satisfies Static<
            typeof ExecutionEventV3
          >;
          continue;
        }
        if (hasRateLimit(event.data)) {
          const retry = retryAfterMs(event.data);
          yield {
            schemaVersion: 3,
            cursor: event.id,
            kind: "rate_limited",
            ...(retry === undefined ? {} : { retryAfterMs: retry }),
          } satisfies Static<typeof ExecutionEventV3>;
          continue;
        }
        if (hasContextCapacityExhaustion(event.data)) {
          yield {
            schemaVersion: 3,
            cursor: event.id,
            kind: "telemetry",
            telemetry: normalizedTelemetry(undefined, {
              engine,
              executionMode,
              evidenceRef: `backend-event:${event.id}`,
              capacityExhausted: true,
            }),
          } satisfies Static<typeof ExecutionEventV3>;
          continue;
        }
        const payload = harnessPayload(event.data);
        const type = field(payload, "type");
        if (type === "tool_call") {
          const tool = normalizedTool(field(payload, "tool"));
          if (tool !== undefined) {
            yield { schemaVersion: 3, cursor: event.id, kind: "tool_call", tool } satisfies Static<
              typeof ExecutionEventV3
            >;
          }
          continue;
        }
        if (type === "tool_result") {
          const tool = normalizedTool(field(payload, "tool"));
          const outcome = TOOL_OUTCOMES.get(field(field(payload, "tool"), "status") as never);
          const exitCode = field(field(payload, "tool"), "exit_code");
          if (tool !== undefined && outcome !== undefined) {
            yield {
              schemaVersion: 3,
              cursor: event.id,
              kind: "tool_result",
              tool: {
                ...tool,
                outcome,
                ...(typeof exitCode === "number" && Number.isSafeInteger(exitCode)
                  ? { exitCode }
                  : {}),
              },
            } satisfies Static<typeof ExecutionEventV3>;
          }
          continue;
        }
        if (type === "file_change") {
          const path = field(field(payload, "payload"), "path");
          if (typeof path === "string" && safeArtifactPath(path)) {
            yield {
              schemaVersion: 3,
              cursor: event.id,
              kind: "file_change",
              path,
            } satisfies Static<typeof ExecutionEventV3>;
          }
          continue;
        }
        if (type === "usage") {
          yield {
            schemaVersion: 3,
            cursor: event.id,
            kind: "telemetry",
            telemetry: normalizedTelemetry(field(payload, "usage"), {
              engine,
              executionMode,
              evidenceRef: `backend-event:${event.id}`,
            }),
          } satisfies Static<typeof ExecutionEventV3>;
          continue;
        }
        if (type === "error") {
          yield { schemaVersion: 3, cursor: event.id, kind: "error" } satisfies Static<
            typeof ExecutionEventV3
          >;
        }
      }
    },

    async diagnoseCompatibility() {
      try {
        handshakeComplete = false;
        await handshake();
        const response = await callJson("GET", "/v2/operations", "operations");
        const operations = field(response, "operations");
        const descriptors = Array.isArray(operations) ? operations : [];
        const available = new Set(
          descriptors.flatMap((entry) => {
            const method = field(entry, "method");
            const path = field(entry, "path");
            return typeof method === "string" && typeof path === "string"
              ? [`${method.toUpperCase()} ${path}`]
              : [];
          }),
        );
        const missing = REQUIRED_OPERATIONS.filter((operation) => !available.has(operation));
        if (missing.length > 0) {
          return [
            {
              category: "compatibility" as const,
              status: "fail" as const,
              code: "CLAUDEXOR_OPERATIONS_MISSING",
              message: `${missing.length} required Claudexor operation(s) are unavailable.`,
              remediation: `Use selected Claudexor ${options.expectedEngine.version}/${options.expectedEngine.buildSha}.`,
            },
          ];
        }
        const policyMismatch = Object.entries(REQUIRED_OPERATION_IDEMPOTENCY).filter(
          ([operation, expected]) => {
            const descriptor = descriptors.find((entry) => {
              const method = field(entry, "method");
              const path = field(entry, "path");
              return `${String(method).toUpperCase()} ${String(path)}` === operation;
            });
            return field(descriptor, "idempotency") !== expected;
          },
        );
        if (policyMismatch.length > 0) {
          return [
            {
              category: "compatibility" as const,
              status: "fail" as const,
              code: "CLAUDEXOR_IDEMPOTENCY_INCOMPATIBLE",
              message: `${policyMismatch.length} required Claudexor idempotency declaration(s) are incompatible.`,
              remediation: `Use selected Claudexor ${options.expectedEngine.version}/${options.expectedEngine.buildSha}.`,
            },
          ];
        }
        return [
          {
            category: "compatibility" as const,
            status: "pass" as const,
            code: "CLAUDEXOR_COMPATIBLE",
            message: `Selected Claudexor ${options.expectedEngine.version} exposes the required /v2 operations.`,
          },
        ];
      } catch {
        return [
          {
            category: "compatibility" as const,
            status: "fail" as const,
            code: "CLAUDEXOR_INCOMPATIBLE",
            message: "Claudexor handshake or operation compatibility failed.",
            remediation: `Start selected Claudexor ${options.expectedEngine.version} and verify its local control endpoint.`,
          },
        ];
      }
    },

    diagnoseRuntime() {
      return diagnoseRuntimeAvailability(options.runtimeEntryPath, options.expectedEngine);
    },

    diagnoseAuthRoute() {
      return (async () => {
        const local = await diagnoseSubscriptionRoute({
          ambient: options.environment ?? process.env,
          ...(options.claudeCommand === undefined ? {} : { command: options.claudeCommand }),
          ...(options.diagnosticRunner === undefined ? {} : { run: options.diagnosticRunner }),
        });
        if (local.status !== "pass") return local;
        try {
          await handshake();
          if (!(await subscriptionRouteAttested("claude"))) {
            throw new Error("unattested");
          }
          return local;
        } catch {
          return {
            category: "auth-route" as const,
            status: "fail" as const,
            code: "CLAUDEXOR_SUBSCRIPTION_ROUTE_UNREADY",
            message:
              "Claudexor did not attest the isolated OAuth-token subscription source as ready.",
            remediation:
              "Start the pinned runtime with the Q004 isolated subscription carrier and rerun heniek doctor.",
          };
        }
      })();
    },

    diagnoseCodexAuthRoute() {
      return (async () => {
        try {
          await handshake();
          if (!(await subscriptionRouteAttested("codex"))) {
            throw new Error("unattested");
          }
          return {
            category: "auth-route" as const,
            status: "pass" as const,
            code: "CODEX_NATIVE_SESSION_ATTESTED",
            message: "Claudexor attested a native Codex ChatGPT subscription session.",
          };
        } catch {
          return {
            category: "auth-route" as const,
            status: "fail" as const,
            code: "CODEX_NATIVE_SESSION_UNATTESTED",
            message: "Claudexor did not attest a native Codex ChatGPT subscription session.",
            remediation: "Sign in to Codex through Claudexor and rerun heniek doctor.",
          };
        }
      })();
    },

    diagnoseCursorAuthRoute() {
      return (async () => {
        try {
          await handshake();
          if (!(await subscriptionRouteAttested("cursor"))) {
            throw new Error("unattested");
          }
          return {
            category: "auth-route" as const,
            status: "pass" as const,
            code: "CURSOR_NATIVE_SESSION_ATTESTED",
            message: "Claudexor attested a native Cursor subscription session.",
          };
        } catch {
          return {
            category: "auth-route" as const,
            status: "fail" as const,
            code: "CURSOR_NATIVE_SESSION_UNATTESTED",
            message: "Claudexor did not attest a native Cursor subscription session.",
            // Cursor's login is keychain-backed and read through the daemon's
            // own HOME, so a daemon started with a scratch HOME reports this
            // even when the user is genuinely signed in.
            remediation:
              "Sign in with `cursor-agent login`, ensure the Claudexor daemon runs under your real HOME, then rerun heniek doctor.",
          };
        }
      })();
    },
  };
}
