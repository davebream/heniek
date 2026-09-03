import { SensitiveValue } from "@heniek/secrets";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyGitHubResponse,
  createGitHubTransport,
  type GitHubApiError,
  parseJson,
} from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub client", () => {
  it("sends credentials only to explicitly authenticated origins", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        return new Response("{}", { status: 200 });
      }),
    );
    const transport = createGitHubTransport({ token: SensitiveValue.from("secret-token") });
    await transport.request({ method: "GET", url: "https://api.github.com/repos/acme/repo" });
    await transport.request({ method: "GET", url: "https://uploads.github.com/object" });
    expect(requests[0]?.headers).toMatchObject({ authorization: "Bearer secret-token" });
    expect(requests[1]?.headers).not.toHaveProperty("authorization");
  });

  it("distinguishes permission failures from authentication and rate limits", () => {
    expect(() =>
      classifyGitHubResponse({ status: 401, headers: {}, body: new Uint8Array() }, "read"),
    ).toThrowError(expect.objectContaining<Partial<GitHubApiError>>({ kind: "authentication" }));
    expect(() =>
      classifyGitHubResponse({ status: 403, headers: {}, body: new Uint8Array() }, "write"),
    ).toThrowError(expect.objectContaining<Partial<GitHubApiError>>({ kind: "permission" }));
    expect(() =>
      classifyGitHubResponse(
        {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "2" },
          body: new Uint8Array(),
        },
        "read",
      ),
    ).toThrowError(
      expect.objectContaining<Partial<GitHubApiError>>({
        kind: "rate_limit",
        retryAfterMilliseconds: 2_000,
      }),
    );
  });

  it("rejects malformed JSON without retaining response content", () => {
    expect(() =>
      parseJson(new TextEncoder().encode("secret invalid json"), "fixture"),
    ).toThrowError("GitHub returned malformed JSON for fixture");
  });
});
