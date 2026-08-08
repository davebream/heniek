export const CLAUDEXOR_PATH_PREFIX = "/v2";
export const CLAUDEXOR_PROTOCOL_MAJOR = 3;
export const CLAUDEXOR_ENGINE_VERSION = "3.1.2";
export const CLAUDEXOR_ENGINE_SHA = "bb5efee24132aa3d65e417040df201e08da44c8c";

export const REQUIRED_OPERATIONS = [
  "POST /v2/handshake",
  "GET /v2/operations",
  "POST /v2/harnesses/:id/auth-readiness",
  "POST /v2/threads",
  "GET /v2/threads/:id",
  "POST /v2/threads/:id/turns",
  "GET /v2/runs/:id",
  "GET /v2/runs/:id/events",
  "POST /v2/runs/:id/interactions/:id/answer",
  "POST /v2/runs/:id/control",
  "GET /v2/runs/:id/produced",
  "GET /v2/runs/:id/produced/<path>",
] as const;

export const REQUIRED_OPERATION_IDEMPOTENCY = {
  "POST /v2/runs/:id/interactions/:id/answer": "natural",
  "POST /v2/threads/:id/turns": "key_required",
} as const;

export interface ClaudexorHandshake {
  readonly protocolMajor: number;
  readonly operationsPath: string;
  readonly engine: { readonly version: string; readonly sha: string };
}

export interface ClaudexorEngineIdentity {
  readonly version: string;
  readonly buildSha: string;
}

export class ClaudexorCompatibilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClaudexorCompatibilityError";
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClaudexorCompatibilityError("MALFORMED_RESPONSE", `${field} is malformed`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ClaudexorCompatibilityError("MALFORMED_RESPONSE", `${field} is malformed`);
  }
  return value;
}

export function parseHandshake(
  value: unknown,
  expectedEngine: ClaudexorEngineIdentity,
): ClaudexorHandshake {
  const body = record(value, "handshake");
  const engine = record(body.engine, "handshake.engine");
  if (body.compatible !== true) {
    throw new ClaudexorCompatibilityError(
      "PROTOCOL_MISMATCH",
      "Claudexor did not accept protocol negotiation.",
    );
  }
  if (body.protocolMajor !== CLAUDEXOR_PROTOCOL_MAJOR) {
    throw new ClaudexorCompatibilityError(
      "PROTOCOL_MISMATCH",
      `Claudexor protocol is incompatible; expected major ${CLAUDEXOR_PROTOCOL_MAJOR}.`,
    );
  }
  const operationsPath = text(body.operationsPath, "handshake.operationsPath");
  if (
    !operationsPath.startsWith(`${CLAUDEXOR_PATH_PREFIX}/`) ||
    operationsPath.startsWith("//") ||
    operationsPath.includes(":")
  ) {
    throw new ClaudexorCompatibilityError(
      "OPERATIONS_PATH_INVALID",
      "Claudexor returned an unsafe operations path.",
    );
  }
  const version = text(engine.version, "handshake.engine.version");
  const sha = text(engine.sha, "handshake.engine.sha");
  if (version !== expectedEngine.version || sha !== expectedEngine.buildSha) {
    throw new ClaudexorCompatibilityError(
      "ENGINE_PIN_MISMATCH",
      `Claudexor is not the selected build ${expectedEngine.version}/${expectedEngine.buildSha}.`,
    );
  }
  return { protocolMajor: CLAUDEXOR_PROTOCOL_MAJOR, operationsPath, engine: { version, sha } };
}

export function claudexorHeaders(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: "http://127.0.0.1",
    "X-Claudexor-Protocol-Major": String(CLAUDEXOR_PROTOCOL_MAJOR),
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
  };
}
