import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClaudexorCapabilityAdapter } from "@heniek/capability";
import { CLAUDEXOR_ENGINE_SHA, CLAUDEXOR_ENGINE_VERSION } from "@heniek/execution-claudexor";
import { describe, expect, it } from "vitest";
import { fixtureFetch, OBSERVED_AT } from "../../capability/test/fixtures/claudexor.js";
import { appendCapabilityDoctorChecks } from "../src/capability/doctor.js";

const matrixPath = fileURLToPath(
  new URL("../../../docs/adr/evidence/0014-q015-capability-matrix.json", import.meta.url),
);
const doctorPath = fileURLToPath(
  new URL("../../../docs/adr/evidence/0014-q015-doctor-report.json", import.meta.url),
);

async function catalogueEntries() {
  return createClaudexorCapabilityAdapter({
    baseUrl: "http://127.0.0.1:9999",
    expectedEngine: { version: CLAUDEXOR_ENGINE_VERSION, buildSha: CLAUDEXOR_ENGINE_SHA },
    fetch: fixtureFetch(),
    clock: { now: () => new Date(OBSERVED_AT) },
  }).discover([
    { engine: "codex", accountId: "codex-work" },
    { engine: "cursor", accountId: "cursor-work" },
  ]);
}

describe("Q015 generated evidence drift", () => {
  it("matches the committed cross-engine capability matrix", async () => {
    const entries = await catalogueEntries();
    const expected = {
      schemaVersion: 1,
      generatedAt: OBSERVED_AT,
      entries: entries.map((entry) => ({
        engine: entry.engine,
        accountId: entry.accountId,
        engineVersion: entry.engineVersion,
        claudexorVersion: entry.claudexorVersion,
        discovery: entry.discovery,
        configured: entry.configured,
        installation: entry.installation,
        authentication: entry.authentication,
        compatibility: entry.compatibility,
        capacity: entry.capacity,
        ready: entry.ready,
        models: entry.models.map(({ id, provenance, efforts, executionModes }) => ({
          id,
          provenance,
          efforts,
          executionModes,
        })),
        features: {
          questions: entry.features.questions.support,
          resume: entry.features.resume.support,
          usage: entry.features.usage.support,
          structuredOutput: entry.features.structuredOutput.support,
          cancellation: entry.features.cancellation.support,
          tools: entry.features.tools.map(({ name, state }) => ({ name, support: state.support })),
        },
      })),
    };
    expect(JSON.parse(await readFile(matrixPath, "utf8"))).toEqual(expected);
  });

  it("matches the committed all-three-engine doctor report", async () => {
    const entries = await catalogueEntries();
    const report = appendCapabilityDoctorChecks(
      {
        schemaVersion: 2,
        health: "healthy",
        checks: [
          {
            category: "runtime",
            readState: "ok",
            verdict: "pass",
            code: "CLAUDEXOR_RUNTIME_OK",
            message: "Pinned Claudexor runtime is available.",
          },
          {
            category: "auth-route",
            readState: "ok",
            verdict: "pass",
            code: "AUTH_ROUTE_OK",
            message: "Subscription route is available.",
          },
          {
            category: "compatibility",
            readState: "ok",
            verdict: "pass",
            code: "COMPATIBILITY_OK",
            message: "Pinned API is compatible.",
          },
          {
            category: "cleanup",
            readState: "ok",
            verdict: "pass",
            code: "CLEANUP_OK",
            message: "No cleanup issues.",
          },
        ],
      },
      { schemaVersion: 1, generatedAt: OBSERVED_AT, entries },
    );
    expect(JSON.parse(await readFile(doctorPath, "utf8"))).toEqual(report);
  });
});
