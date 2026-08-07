import { CLAUDEXOR_ENGINE_SHA, CLAUDEXOR_ENGINE_VERSION } from "@heniek/execution-claudexor";
import { describe, expect, it } from "vitest";
import { createClaudexorCapabilityAdapter } from "../src/index.js";
import { fixtureFetch, OBSERVED_AT, responses } from "./fixtures/claudexor.js";

const expectedEngine = { version: CLAUDEXOR_ENGINE_VERSION, buildSha: CLAUDEXOR_ENGINE_SHA };

describe("Claudexor capability normalization", () => {
  it("normalizes all three engines without leaking credential or provider identity", async () => {
    const adapter = createClaudexorCapabilityAdapter({
      baseUrl: "http://127.0.0.1:9999",
      expectedEngine,
      fetch: fixtureFetch(),
      clock: { now: () => new Date(OBSERVED_AT) },
    });
    const entries = await adapter.discover([
      { engine: "codex", accountId: "codex-work" },
      { engine: "cursor", accountId: "cursor-work" },
    ]);

    expect(entries.map((entry) => entry.engine)).toEqual(["claude", "codex", "cursor"]);
    expect(entries.every((entry) => entry.ready)).toBe(true);
    expect(entries.find((entry) => entry.engine === "claude")?.models[0]?.provenance).toBe(
      "manifest",
    );
    expect(entries.find((entry) => entry.engine === "codex")?.models[0]).toMatchObject({
      provenance: "api",
      efforts: ["medium", "high"],
    });
    expect(
      entries.find((entry) => entry.engine === "cursor")?.features.structuredOutput.support,
    ).toBe("unsupported");
    expect(entries.find((entry) => entry.engine === "codex")?.features.questions.support).toBe(
      "unsupported",
    );
    expect(entries.find((entry) => entry.engine === "claude")?.features.tools).toContainEqual(
      expect.objectContaining({
        name: "browser",
        state: expect.objectContaining({ support: "supported" }),
      }),
    );
    expect(JSON.stringify(entries)).not.toContain("example.invalid");
    expect(JSON.stringify(entries)).not.toContain("identity");
  });

  it("keeps partial endpoint failures explicit and unknown", async () => {
    const adapter = createClaudexorCapabilityAdapter({
      baseUrl: "http://127.0.0.1:9999",
      expectedEngine,
      fetch: fixtureFetch({ "GET /v2/quota": new Error("quota unavailable") }),
      clock: { now: () => new Date(OBSERVED_AT) },
    });
    const entries = await adapter.discover([]);
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.discovery === "partial")).toBe(true);
    expect(entries.every((entry) => entry.capacity === "unknown")).toBe(true);
    expect(entries.every((entry) => entry.features.usage.support === "unknown")).toBe(true);
  });

  it("rejects an incompatible pinned Claudexor identity", async () => {
    const adapter = createClaudexorCapabilityAdapter({
      baseUrl: "http://127.0.0.1:9999",
      expectedEngine: { ...expectedEngine, buildSha: "0".repeat(40) },
      fetch: fixtureFetch(),
    });
    await expect(adapter.discover([])).rejects.toThrow(/build/i);
  });

  it("rejects a malformed required harness inventory", async () => {
    const adapter = createClaudexorCapabilityAdapter({
      baseUrl: "http://127.0.0.1:9999",
      expectedEngine,
      fetch: fixtureFetch({ "GET /v2/harnesses": { unexpected: [] } }),
    });
    await expect(adapter.discover([])).rejects.toThrow(/harness inventory is malformed/i);
  });

  it("always emits unconfigured Codex and Cursor rows", async () => {
    const adapter = createClaudexorCapabilityAdapter({
      baseUrl: "http://127.0.0.1:9999",
      expectedEngine,
      fetch: fixtureFetch(),
      clock: { now: () => new Date(OBSERVED_AT) },
    });
    const entries = await adapter.discover([]);
    expect(entries.map(({ engine, configured }) => ({ engine, configured }))).toEqual([
      { engine: "claude", configured: true },
      { engine: "codex", configured: false },
      { engine: "cursor", configured: false },
    ]);
  });

  it("uses Codex native-session readiness even when no matching credential-profile id exists", async () => {
    const adapter = createClaudexorCapabilityAdapter({
      baseUrl: "http://127.0.0.1:9999",
      expectedEngine,
      fetch: fixtureFetch({
        "GET /v2/credential-profiles": {
          profiles: [
            {
              profile: {
                profile_id: "codex-work-extra",
                harness_id: "codex",
                display_name: "Other account",
                credential_kind: "config_dir_login",
              },
              status: { availability: "available", verification: "passed" },
            },
          ],
          harnessAccounts: [],
        },
      }),
      clock: { now: () => new Date(OBSERVED_AT) },
    });
    const entries = await adapter.discover([{ engine: "codex", accountId: "codex-work" }]);
    expect(entries.find((entry) => entry.engine === "codex")?.authentication).toBe("authenticated");
  });

  it.each([
    ["missing binary", "installed", "fail", "not-installed", "compatible"],
    ["incompatible runtime", "compatibility", "fail", "installed", "incompatible"],
  ] as const)(
    "keeps %s independent from other readiness dimensions",
    async (_name, checkId, checkStatus, installation, compatibility) => {
      const harnesses = structuredClone(responses["GET /v2/harnesses"]) as {
        harnesses: Array<{ id: string; checks: Array<{ id: string; status: string }> }>;
      };
      const codex = harnesses.harnesses.find((harness) => harness.id === "codex");
      if (codex === undefined) throw new Error("fixture is missing codex");
      codex.checks = [
        { id: "installed", status: checkId === "installed" ? checkStatus : "pass" },
        ...(checkId === "compatibility" ? [{ id: checkId, status: checkStatus }] : []),
      ];
      const adapter = createClaudexorCapabilityAdapter({
        baseUrl: "http://127.0.0.1:9999",
        expectedEngine,
        fetch: fixtureFetch({ "GET /v2/harnesses": harnesses }),
        clock: { now: () => new Date(OBSERVED_AT) },
      });
      const entries = await adapter.discover([{ engine: "codex", accountId: "codex-work" }]);
      expect(entries.find((entry) => entry.engine === "codex")).toMatchObject({
        installation,
        compatibility,
        authentication: "authenticated",
        ready: false,
      });
    },
  );

  it("blocks readiness on a known active rate limit but not unknown capacity", async () => {
    const quota = structuredClone(responses["GET /v2/quota"]) as {
      snapshots: Array<{
        subject: { harness: string };
        constraints: Array<Record<string, unknown>>;
      }>;
    };
    const codex = quota.snapshots.find((snapshot) => snapshot.subject.harness === "codex");
    if (codex === undefined) throw new Error("fixture is missing codex quota");
    codex.constraints = [{ id: "window", used_ratio: 1 }];
    const adapter = createClaudexorCapabilityAdapter({
      baseUrl: "http://127.0.0.1:9999",
      expectedEngine,
      fetch: fixtureFetch({ "GET /v2/quota": quota }),
      clock: { now: () => new Date(OBSERVED_AT) },
    });
    const entries = await adapter.discover([
      { engine: "codex", accountId: "codex-work" },
      { engine: "cursor", accountId: "cursor-work" },
    ]);
    expect(entries.find((entry) => entry.engine === "codex")).toMatchObject({
      capacity: "rate-limited",
      ready: false,
    });
    expect(entries.find((entry) => entry.engine === "cursor")).toMatchObject({
      capacity: "unknown",
      ready: true,
    });
  });
});
