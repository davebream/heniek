import { createHash } from "node:crypto";
import type {
  ArtifactId,
  BackendArtifactId,
  BackendArtifactV1,
  BackendExecutionId,
  ExecutionBackendV2,
  ExecutionRequestV2,
  ExecutionResultV2,
  ExecutionStatus,
  InteractionAnswerSetV1,
  InteractionId,
  InteractionQuestionId,
  PendingInteractionV2,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import {
  type ClaudexorDiagnostic,
  type DiagnosticRunner,
  diagnoseRuntimeAvailability,
  diagnoseSubscriptionRoute,
} from "./diagnostics.js";
import {
  CLAUDEXOR_ENGINE_SHA,
  CLAUDEXOR_ENGINE_VERSION,
  CLAUDEXOR_PROTOCOL_MAJOR,
  claudexorHeaders,
  parseHandshake,
  REQUIRED_OPERATIONS,
} from "./protocol.js";

export interface ClaudexorBackendOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMilliseconds?: number;
  readonly runtimeRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly claudeCommand?: string;
  readonly diagnosticRunner?: DiagnosticRunner;
}

export interface ClaudexorExecutionBackend extends ExecutionBackendV2 {
  diagnoseCompatibility(): Promise<readonly ClaudexorDiagnostic[]>;
  diagnoseRuntime(): Promise<ClaudexorDiagnostic>;
  diagnoseAuthRoute(): Promise<ClaudexorDiagnostic>;
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

export function createClaudexorExecutionBackend(
  options: ClaudexorBackendOptions,
): ClaudexorExecutionBackend {
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 60_000;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  let handshakeComplete = false;

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

  async function handshake(): Promise<void> {
    if (handshakeComplete) return;
    parseHandshake(
      await callJson("POST", "/v2/handshake", "handshake", {
        protocolMajor: CLAUDEXOR_PROTOCOL_MAJOR,
        client: "heniek-q012",
      }),
    );
    handshakeComplete = true;
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

    async resume(executionId: string, inputArtifactRefs: ArtifactId[]) {
      await createTurn(
        executionId,
        inputArtifactRefs.length === 0
          ? "Continue the stage from the current workspace state."
          : `Continue the stage using these Heniek input artifact references: ${inputArtifactRefs.join(", ")}.`,
        `${executionId}:resume:${inputArtifactRefs.join(",")}`,
      );
    },

    async result(executionId: string): Promise<Static<typeof ExecutionResultV2>> {
      const value = await run(executionId);
      if (value === null) throw new ClaudexorControlError(409, "run_not_started", "result");
      const status = mapStatus(value);
      if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
        throw new ClaudexorControlError(409, "run_not_terminal", "result");
      }
      const summary = field(value, "summary");
      const rawSummary = field(value, "finalSummary");
      const rawError = field(summary, "error");
      const threadValue = await thread(executionId);
      const sessions = field(threadValue, "sessions");
      const session = Array.isArray(sessions)
        ? sessions.find((entry) => field(entry, "harnessId") === "claude")
        : undefined;
      const sessionId = field(session, "nativeSessionId");
      return {
        schemaVersion: 2,
        status,
        summary:
          typeof rawSummary === "string" && rawSummary.length > 0
            ? rawSummary
            : typeof rawError === "string" && rawError.length > 0
              ? rawError
              : `Claudexor execution ${status}.`,
        ...(typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}),
        artifacts: await listedArtifacts(executionId),
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

    async diagnoseCompatibility() {
      try {
        handshakeComplete = false;
        await handshake();
        const response = await callJson("GET", "/v2/operations", "operations");
        const operations = field(response, "operations");
        const available = new Set(
          Array.isArray(operations)
            ? operations.flatMap((entry) => {
                const method = field(entry, "method");
                const path = field(entry, "path");
                return typeof method === "string" && typeof path === "string"
                  ? [`${method.toUpperCase()} ${path}`]
                  : [];
              })
            : [],
        );
        const missing = REQUIRED_OPERATIONS.filter((operation) => !available.has(operation));
        if (missing.length > 0) {
          return [
            {
              category: "compatibility" as const,
              status: "fail" as const,
              code: "CLAUDEXOR_OPERATIONS_MISSING",
              message: `${missing.length} required Claudexor operation(s) are unavailable.`,
              remediation: `Use pinned Claudexor ${CLAUDEXOR_ENGINE_VERSION}/${CLAUDEXOR_ENGINE_SHA}.`,
            },
          ];
        }
        return [
          {
            category: "compatibility" as const,
            status: "pass" as const,
            code: "CLAUDEXOR_COMPATIBLE",
            message: `Pinned Claudexor ${CLAUDEXOR_ENGINE_VERSION} exposes the required /v2 operations.`,
          },
        ];
      } catch {
        return [
          {
            category: "compatibility" as const,
            status: "fail" as const,
            code: "CLAUDEXOR_INCOMPATIBLE",
            message: "Claudexor handshake or operation compatibility failed.",
            remediation: `Start pinned Claudexor ${CLAUDEXOR_ENGINE_VERSION} and verify its local control endpoint.`,
          },
        ];
      }
    },

    diagnoseRuntime() {
      return diagnoseRuntimeAvailability(options.runtimeRoot);
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
          const response = await callJson(
            "POST",
            "/v2/harnesses/claude/auth-readiness",
            "authReadiness",
            { authRequest: "subscription", source: "oauth_token_env" },
          );
          const readiness = field(response, "readiness");
          if (
            field(response, "harnessId") !== "claude" ||
            field(response, "authRequest") !== "subscription" ||
            field(response, "requestedSource") !== "oauth_token_env" ||
            field(readiness, "source") !== "oauth_token_env" ||
            field(readiness, "availability") !== "available" ||
            field(readiness, "verification") !== "passed"
          ) {
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
  };
}
