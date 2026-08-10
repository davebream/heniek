import { describe, expect, it } from "vitest";
import { classifySubscriptionStdout, diagnoseSubscriptionRoute } from "../src/diagnostics.js";

describe("classifySubscriptionStdout", () => {
  it("treats malformed and incomplete envelopes as read failures", () => {
    expect(classifySubscriptionStdout("not-json")).toEqual({ kind: "malformed" });
    expect(classifySubscriptionStdout(JSON.stringify({ loggedIn: true }))).toEqual({
      kind: "incomplete",
    });
  });

  it("treats a complete negative envelope as negative", () => {
    expect(
      classifySubscriptionStdout(
        JSON.stringify({
          loggedIn: false,
          authMethod: "api_key",
          apiProvider: "firstParty",
        }),
      ),
    ).toEqual({ kind: "negative" });
  });

  it("attests a complete positive envelope", () => {
    expect(
      classifySubscriptionStdout(
        JSON.stringify({
          loggedIn: true,
          authMethod: "oauth_token",
          apiProvider: "firstParty",
        }),
      ),
    ).toEqual({ kind: "attested" });
  });
});

describe("diagnoseSubscriptionRoute read provenance", () => {
  it("reports spawn failure as not-read", async () => {
    await expect(
      diagnoseSubscriptionRoute({
        ambient: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        run: async () => ({
          exitCode: null,
          spawnFailure: true,
          stdout: "",
          stderr: "ENOENT",
        }),
      }),
    ).resolves.toMatchObject({
      readState: "not-read",
      code: "SUBSCRIPTION_ROUTE_UNATTESTED",
    });
  });

  it("reports non-zero exit as read failed", async () => {
    await expect(
      diagnoseSubscriptionRoute({
        ambient: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        run: async () => ({
          exitCode: 2,
          spawnFailure: false,
          stdout: "",
          stderr: "refused",
        }),
      }),
    ).resolves.toMatchObject({
      readState: "failed",
      code: "SUBSCRIPTION_ROUTE_UNATTESTED",
    });
  });

  it("reports malformed JSON as read failed", async () => {
    await expect(
      diagnoseSubscriptionRoute({
        ambient: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        run: async () => ({
          exitCode: 0,
          spawnFailure: false,
          stdout: "{",
          stderr: "",
        }),
      }),
    ).resolves.toMatchObject({
      readState: "failed",
      code: "SUBSCRIPTION_ROUTE_UNATTESTED",
    });
  });

  it("reports a complete negative envelope as ok fail", async () => {
    await expect(
      diagnoseSubscriptionRoute({
        ambient: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        run: async () => ({
          exitCode: 0,
          spawnFailure: false,
          stdout: JSON.stringify({
            loggedIn: false,
            authMethod: "oauth_token",
            apiProvider: "firstParty",
          }),
          stderr: "",
        }),
      }),
    ).resolves.toMatchObject({
      readState: "ok",
      verdict: "fail",
      code: "SUBSCRIPTION_ROUTE_UNATTESTED",
    });
  });

  it("reports successful attestation as ok pass", async () => {
    await expect(
      diagnoseSubscriptionRoute({
        ambient: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
        run: async () => ({
          exitCode: 0,
          spawnFailure: false,
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "oauth_token",
            apiProvider: "firstParty",
          }),
          stderr: "",
        }),
      }),
    ).resolves.toMatchObject({
      readState: "ok",
      verdict: "pass",
      code: "SUBSCRIPTION_ROUTE_ATTESTED",
    });
  });
});
