import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXECUTION_BACKEND_CASES } from "../src/cases/catalogue.js";
import { createFakeExecutionBackendHarness } from "../src/fakes/index.js";
import { DEFAULT_SEED, seed } from "../src/kernel/seed.js";
import { recordFailureReplay } from "../src/replay.js";
import { runConformanceCase } from "../src/runner/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("seed-replay determinism (RT1)", () => {
  it("two independent recordFailureReplay(DEFAULT_SEED) runs produce deep-equal traces", async () => {
    const first = await recordFailureReplay(DEFAULT_SEED);
    const second = await recordFailureReplay(DEFAULT_SEED);
    expect(second).toEqual(first);
  });

  it("a different seed produces a different trace", async () => {
    // Compare `events` only, not the whole `FailureReplay` payload: the
    // payload also embeds the `seed` field itself, which trivially differs
    // between DEFAULT_SEED and seed(1) regardless of whether a single
    // downstream byte of the actual trace changes — that made the original
    // version of this assertion a tautology (NEW-2).
    const atDefault = await recordFailureReplay(DEFAULT_SEED);
    const atOne = await recordFailureReplay(seed(1));
    expect(atOne.events).not.toEqual(atDefault.events);
  });

  it("the committed generated/failure-replay.json reproduces exactly", async () => {
    const committed = JSON.parse(
      await readFile(resolve(packageRoot, "generated/failure-replay.json"), "utf8"),
    );
    const fresh = await recordFailureReplay(DEFAULT_SEED);
    expect(fresh).toEqual(committed);
  });

  it("running the full execution catalogue twice at the same seed produces identical trace sequences", async () => {
    // Digest the full canonicalized event (NEW-3): the original version
    // digested only `id:step:actor:action:outcome`, excluding `atMs` and
    // `detail` — i.e. every generated id, timestamp, and payload. A
    // regression that made ids or the clock non-deterministic (while
    // leaving step/actor/action/outcome unchanged) would have passed this
    // test green despite genuinely breaking RT1.
    async function runCatalogueOnce(): Promise<string[]> {
      const digest: string[] = [];
      for (const testCase of EXECUTION_BACKEND_CASES) {
        const harness = createFakeExecutionBackendHarness();
        const events = await runConformanceCase(harness, testCase, DEFAULT_SEED);
        for (const event of events) {
          digest.push(`${testCase.id}:${JSON.stringify(event)}`);
        }
      }
      return digest;
    }

    const passOne = await runCatalogueOnce();
    const passTwo = await runCatalogueOnce();
    expect(passTwo).toEqual(passOne);
  });
});
