/**
 * The scripted `ExecutionBackend` (design C17, plan Task 4).
 *
 * Test infrastructure the reconciliation tests will trust, so its own
 * contract is pinned here — chiefly that the four mutating methods throw,
 * since that throw *is* the IR-16 assertion rather than a convenience.
 */

import { describe, expect, it } from "vitest";
import {
  createScriptedBackend,
  ForbiddenBackendWriteError,
  UnscriptedCallError,
} from "./scripted-backend.js";

describe("createScriptedBackend — status", () => {
  it("returns scripted answers in order, one per call", async () => {
    const backend = createScriptedBackend({
      "run-1": [
        { kind: "status", status: "running" },
        { kind: "status", status: "succeeded" },
      ],
    });

    await expect(backend.status("run-1")).resolves.toBe("running");
    await expect(backend.status("run-1")).resolves.toBe("succeeded");
  });

  it("tracks each run's position independently", async () => {
    const backend = createScriptedBackend({
      "run-1": [{ kind: "status", status: "running" }],
      "run-2": [{ kind: "status", status: "failed" }],
    });

    await expect(backend.status("run-2")).resolves.toBe("failed");
    await expect(backend.status("run-1")).resolves.toBe("running");
  });

  it("rejects when the script models a backend failure", async () => {
    const backend = createScriptedBackend({ "run-1": [{ kind: "throws", message: "boom" }] });

    await expect(backend.status("run-1")).rejects.toThrow("boom");
  });

  it("rejects for an unknown run — the only channel the contract gives a backend", async () => {
    const backend = createScriptedBackend({ "run-1": [{ kind: "unknown-run" }] });

    await expect(backend.status("run-1")).rejects.toThrow(UnscriptedCallError);
  });

  it("rejects when the script is exhausted, naming the shortfall", async () => {
    const backend = createScriptedBackend({ "run-1": [{ kind: "status", status: "running" }] });
    await backend.status("run-1");

    await expect(backend.status("run-1")).rejects.toThrow(/supplied 1 answer/);
  });

  it("rejects for a run the script does not cover at all", async () => {
    const backend = createScriptedBackend({});

    await expect(backend.status("nope")).rejects.toThrow(UnscriptedCallError);
  });
});

describe("createScriptedBackend — the IR-16 assertion", () => {
  it.each(["start", "answer", "resume", "cancel"] as const)(
    "%s throws on invocation, because reconciliation must never call it",
    (method) => {
      const backend = createScriptedBackend({});

      // Synchronous throw, not a rejected promise: a pass that reached for a
      // mutator fails immediately and unmistakably.
      expect(() => (backend[method] as () => unknown)()).toThrow(ForbiddenBackendWriteError);
    },
  );

  it("distinguishes a forbidden write from a merely unscripted read", async () => {
    const backend = createScriptedBackend({});

    expect(() => backend.start({} as never)).toThrow(ForbiddenBackendWriteError);
    await expect(backend.result("run-1")).rejects.toThrow(UnscriptedCallError);
  });

  it("records the forbidden call before throwing, so a test can prove which one was reached", () => {
    const backend = createScriptedBackend({});

    expect(() => backend.cancel("run-1")).toThrow();

    expect(backend.calls.map((call) => call.method)).toEqual(["cancel"]);
  });
});

describe("createScriptedBackend — call recording", () => {
  it("records every call in order", async () => {
    const backend = createScriptedBackend({
      "run-1": [{ kind: "status", status: "running" }],
      "run-2": [{ kind: "status", status: "queued" }],
    });

    await backend.status("run-1");
    await backend.status("run-2");

    expect(backend.calls).toEqual([
      { method: "status", runId: "run-1" },
      { method: "status", runId: "run-2" },
    ]);
  });

  it("counts status calls per run — the idempotence assertion", async () => {
    const backend = createScriptedBackend({
      "run-1": [
        { kind: "status", status: "running" },
        { kind: "status", status: "running" },
      ],
      "run-2": [{ kind: "status", status: "queued" }],
    });

    await backend.status("run-1");
    await backend.status("run-1");
    await backend.status("run-2");

    expect(backend.statusCallsFor("run-1")).toBe(2);
    expect(backend.statusCallsFor("run-2")).toBe(1);
    expect(backend.statusCallsFor("run-3")).toBe(0);
  });

  it("records a rejected probe too — a failed call is still a call", async () => {
    const backend = createScriptedBackend({ "run-1": [{ kind: "throws" }] });

    await expect(backend.status("run-1")).rejects.toThrow();

    expect(backend.statusCallsFor("run-1")).toBe(1);
  });
});
