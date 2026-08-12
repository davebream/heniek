import type { SensitiveValue } from "@heniek/secrets";

export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_ACCEPT = "application/vnd.github+json";

export interface GitHubTransportRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly maxResponseBytes?: number;
}

export interface GitHubTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface GitHubTransport {
  request(request: GitHubTransportRequest): Promise<GitHubTransportResponse>;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly requestId: string | null;
  readonly kind: "authentication" | "not_found" | "rate_limit" | "malformed_response" | "api";
  readonly retryAfterMilliseconds: number | null;

  constructor(input: {
    readonly status: number;
    readonly requestId?: string | null;
    readonly kind: GitHubApiError["kind"];
    readonly retryAfterMilliseconds?: number | null;
    readonly message: string;
  }) {
    super(input.message);
    this.name = "GitHubApiError";
    this.status = input.status;
    this.requestId = input.requestId ?? null;
    this.kind = input.kind;
    this.retryAfterMilliseconds = input.retryAfterMilliseconds ?? null;
  }
}

function lowerCaseHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of headers.entries()) normalized[name.toLowerCase()] = value;
  return normalized;
}

async function boundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new GitHubApiError({
          status: response.status,
          kind: "malformed_response",
          message: `GitHub response exceeded the ${maximum} byte limit`,
        });
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function createGitHubTransport(input: {
  readonly token: SensitiveValue;
  readonly userAgent?: string;
  readonly timeoutMilliseconds?: number;
  readonly authenticatedOrigins?: readonly string[];
}): GitHubTransport {
  const timeoutMilliseconds = input.timeoutMilliseconds ?? 30_000;
  const authenticatedOrigins = new Set(input.authenticatedOrigins ?? ["https://api.github.com"]);
  return {
    async request(request) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
      try {
        const authorization = authenticatedOrigins.has(new URL(request.url).origin)
          ? { authorization: `Bearer ${input.token.expose()}` }
          : {};
        const response = await fetch(request.url, {
          method: request.method,
          headers: {
            accept: GITHUB_ACCEPT,
            ...authorization,
            "content-type": "application/json",
            "user-agent": input.userAgent ?? "heniek-task-source-github",
            "x-github-api-version": GITHUB_API_VERSION,
            ...request.headers,
          },
          ...(request.body === undefined ? {} : { body: request.body }),
          redirect: "manual",
          signal: controller.signal,
        });
        return {
          status: response.status,
          headers: lowerCaseHeaders(response.headers),
          body: await boundedBody(response, request.maxResponseBytes ?? 4 * 1024 * 1024),
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function classifyGitHubResponse(response: GitHubTransportResponse, operation: string): void {
  if (response.status >= 200 && response.status < 300) return;
  const requestId = response.headers["x-github-request-id"] ?? null;
  const remaining = response.headers["x-ratelimit-remaining"];
  const rateLimited = response.status === 429 || (response.status === 403 && remaining === "0");
  const retryAfter = response.headers["retry-after"];
  throw new GitHubApiError({
    status: response.status,
    requestId,
    kind: rateLimited
      ? "rate_limit"
      : response.status === 401 || response.status === 403
        ? "authentication"
        : response.status === 404
          ? "not_found"
          : "api",
    retryAfterMilliseconds:
      retryAfter === undefined || !/^\d+$/.test(retryAfter) ? null : Number(retryAfter) * 1000,
    message: `GitHub ${operation} failed with HTTP ${response.status}`,
  });
}

export function parseJson(value: Uint8Array, context: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(value)) as unknown;
  } catch {
    throw new GitHubApiError({
      status: 200,
      kind: "malformed_response",
      message: `GitHub returned malformed JSON for ${context}`,
    });
  }
}
