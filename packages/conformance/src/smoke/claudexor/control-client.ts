import type { RunStatus } from "@heniek/contracts";
import { assertPinnedEngine, negotiateProtocol, protocolHeaders } from "./protocol.js";
import { type ClaudexorRunObservation, toHeniekRunState } from "./state-map.js";

/**
 * Minimal, provider-neutral client for the pinned Claudexor `/v2` control API.
 *
 * This is the anti-corruption boundary §23.2 requires, in miniature: it speaks
 * only HTTP, imports nothing from `@claudexor/*`, and returns Heniek-shaped
 * values so Claudexor's JSON never escapes the module.
 *
 * Errors carry the HTTP status and the engine's `code` only — never headers,
 * never a request init, never a response body — because every product call
 * carries the daemon bearer token.
 */

export interface ControlClientOptions {
  readonly baseUrl: string;
  readonly token: string;
}

export interface RunStartInput {
  readonly prompt: string;
  readonly projectRoot: string;
  readonly primaryHarness?: string;
}

export interface RunHandle {
  readonly runId: string;
  readonly jobId: string;
  readonly taskId: string;
}

export interface AuthRouteObservation {
  readonly requested: string | null;
  readonly effective: string | null;
  readonly source: string | null;
}

export interface RunObservation {
  readonly heniekState: RunStatus;
  readonly claudexorState: string;
  readonly waitingOnUser: boolean;
  readonly authRoute: AuthRouteObservation | null;
  readonly failed: boolean;
}

export interface SseFrame {
  readonly id: string | null;
  readonly event: string | null;
  readonly data: unknown;
}

/** A `/v2` call failed. Deliberately carries no header or body material. */
export class ControlApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly operation: string,
  ) {
    super(`${operation} failed: HTTP ${status} (${code})`);
    this.name = "ControlApiError";
  }
}

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

/** True when a Claudexor lifecycle state will not change again. */
export function isTerminalClaudexorState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

function idempotencyKey(prefix: string): string {
  return `${prefix}-${process.pid}-${performance.now().toString(36).replace(".", "")}`;
}

export interface ControlClient {
  handshake(): Promise<{
    protocolMajor: number;
    operationsPath: string;
    version: string;
    sha: string;
  }>;
  registerProject(root: string): Promise<string>;
  startRun(input: RunStartInput): Promise<RunHandle>;
  getRun(runId: string): Promise<RunObservation>;
  cancel(runId: string): Promise<void>;
  answer(runId: string, interactionId: string, answer: string): Promise<void>;
  streamEvents(
    runId: string,
    options?: { lastEventId?: string; signal?: AbortSignal },
  ): AsyncGenerator<SseFrame>;
}

export function createControlClient(options: ControlClientOptions): ControlClient {
  const { baseUrl, token } = options;

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...protocolHeaders(3),
      Authorization: `Bearer ${token}`,
      ...extra,
    };
  }

  async function call(
    method: string,
    path: string,
    operation: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: headers(extra),
      signal: AbortSignal.timeout(60_000),
    };
    // `exactOptionalPropertyTypes` forbids assigning `undefined` to `body`.
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const code =
        typeof parsed === "object" && parsed !== null && "code" in parsed
          ? String((parsed as { code: unknown }).code).slice(0, 64)
          : "unknown";
      throw new ControlApiError(response.status, code, operation);
    }
    return parsed;
  }

  function field(source: unknown, name: string): unknown {
    if (typeof source !== "object" || source === null) return undefined;
    return Object.hasOwn(source, name) ? (source as Record<string, unknown>)[name] : undefined;
  }

  return {
    async handshake() {
      const body = await call("POST", "/v2/handshake", "handshake", {
        protocolMajor: 3,
        client: "heniek-q003-canary",
      });
      const negotiated = negotiateProtocol(body);
      // Proves the evidence came from the pinned revision, rather than from
      // whatever else might be answering on a loopback port.
      assertPinnedEngine(negotiated.engine);
      return {
        protocolMajor: negotiated.major,
        operationsPath: negotiated.operationsPath,
        version: negotiated.engine.version,
        sha: negotiated.engine.sha,
      };
    },

    async registerProject(root: string) {
      const body = await call(
        "POST",
        "/v2/projects",
        "registerProject",
        { root },
        {
          "Idempotency-Key": idempotencyKey("proj"),
        },
      );
      const id = field(body, "id");
      if (typeof id !== "string") throw new ControlApiError(200, "malformed", "registerProject");
      return id;
    },

    async startRun(input: RunStartInput) {
      const body = await call(
        "POST",
        "/v2/runs",
        "startRun",
        {
          prompt: input.prompt,
          mode: "agent",
          primaryHarness: input.primaryHarness ?? "claude",
          scope: { kind: "project", root: input.projectRoot, context: "auto" },
        },
        { "Idempotency-Key": idempotencyKey("run") },
      );
      const runId = field(body, "runId");
      const jobId = field(body, "jobId");
      const taskId = field(body, "taskId");
      if (typeof runId !== "string" || typeof jobId !== "string" || typeof taskId !== "string") {
        throw new ControlApiError(200, "malformed", "startRun");
      }
      return { runId, jobId, taskId };
    },

    async getRun(runId: string) {
      const body = await call("GET", `/v2/runs/${runId}`, "getRun");
      const summary = field(body, "summary");
      const state = field(summary, "state");
      if (typeof state !== "string") throw new ControlApiError(200, "malformed", "getRun");
      const waitingOnUser = field(summary, "waitingOnUser") === true;
      const rawAuth = field(summary, "authRoute");
      const authRoute =
        typeof rawAuth === "object" && rawAuth !== null
          ? {
              requested: asStringOrNull(field(rawAuth, "requested")),
              effective: asStringOrNull(field(rawAuth, "effective")),
              source: asStringOrNull(field(rawAuth, "source")),
            }
          : null;
      const observation: ClaudexorRunObservation = { state, waitingOnUser };
      return {
        heniekState: toHeniekRunState(observation),
        claudexorState: state,
        waitingOnUser,
        authRoute,
        failed: field(summary, "failure") !== null && field(summary, "failure") !== undefined,
      };
    },

    async cancel(runId: string) {
      await call("POST", `/v2/runs/${runId}/control`, "cancel", { control: "cancel" });
    },

    async answer(runId: string, interactionId: string, answer: string) {
      await call("POST", `/v2/runs/${runId}/interactions/${interactionId}/answer`, "answer", {
        answer,
      });
    },

    async *streamEvents(runId, streamOptions = {}) {
      const extra: Record<string, string> = { Accept: "text/event-stream" };
      if (streamOptions.lastEventId !== undefined) {
        extra["Last-Event-ID"] = streamOptions.lastEventId;
      }
      const requestInit: RequestInit = { method: "GET", headers: headers(extra) };
      if (streamOptions.signal !== undefined) requestInit.signal = streamOptions.signal;
      const response = await fetch(`${baseUrl}/v2/runs/${runId}/events`, requestInit);
      if (!response.ok || response.body === null) {
        throw new ControlApiError(response.status, "stream", "streamEvents");
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const frame = parseSseFrame(raw);
          if (frame !== null) yield frame;
          boundary = buffer.indexOf("\n\n");
        }
      }
    },
  };
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Parse one SSE frame. Comment-only frames (`: connected`) yield null. */
export function parseSseFrame(raw: string): SseFrame | null {
  let id: string | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  let data: unknown = null;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    data = null;
  }
  return { id, event, data };
}
