import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitStateChange,
  openStateDatabase,
  readEvents,
  readIdentity,
  runMigrations,
  type StateDatabase,
} from "@heniek/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertRunInstructionReadiness,
  type CodebaseError,
  createNodeHashPort,
  createRegistrationStatePort,
  discoverAndSnapshotRunInstructions,
  type InstructionSnapshot,
  type RegisteredCodebase,
  snapshotRunInstructions,
} from "../src/index.js";

const HASH = "a".repeat(64);
let directory: string;
let db: StateDatabase;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "heniek-codebase-state-"));
  let id = 0;
  db = openStateDatabase({
    path: join(directory, "state.sqlite3"),
    clock: { nowIso: () => "2026-08-06T10:00:00.000Z" },
    ids: { next: (prefix) => `${prefix}-${++id}` },
  });
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function snapshot(readiness: "ready" | "blocked" = "ready"): InstructionSnapshot {
  return {
    schemaVersion: 1,
    snapshotSha256: HASH,
    capturedAt: "2026-08-06T10:00:00.000Z",
    readiness,
    sources: [],
    diagnostics:
      readiness === "ready"
        ? []
        : [
            {
              schemaVersion: 1,
              code: "INSTRUCTION_CONFLICT",
              classification: "incompatible",
              message: "Requirements conflict.",
              topic: "package manager",
              anchors: [
                { sourceId: "one", startLine: 1, endLine: 1 },
                { sourceId: "two", startLine: 2, endLine: 2 },
              ],
            },
          ],
  };
}

function registration(): RegisteredCodebase {
  return {
    schemaVersion: 1,
    codebaseId: "cb-1" as RegisteredCodebase["codebaseId"],
    name: "fixture",
    rootPath: "/fixture",
    sourceRepositoryPath: null,
    topologySha256: HASH,
    configurationSha256: "b".repeat(64),
    instructionSnapshot: snapshot(),
    diagnostics: [],
    readiness: "ready",
    registeredAt: "2026-08-06T10:00:00.000Z",
    repositories: [
      {
        repositoryId: "repo-1" as RegisteredCodebase["repositories"][number]["repositoryId"],
        name: "fixture",
        path: "/fixture",
        gitCommonDirectory: "/fixture/.git",
        remotes: [],
        defaultRemote: null,
        defaultBranch: null,
      },
    ],
  };
}

function createRun(runId: string): void {
  commitStateChange(db, {
    runId,
    type: "run.created",
    payload: { runId, codebaseId: "cb-1" },
  });
}

describe("registration and run instruction state", () => {
  it("commits the whole registration as one aggregate event and retries idempotently", async () => {
    const state = createRegistrationStatePort(db);
    await state.commitRegistration(registration());
    await state.commitRegistration(registration());

    expect(readEvents(db)).toHaveLength(1);
    expect(readIdentity(db, "codebase", "cb-1")).toMatchObject({
      configurationSha256: "b".repeat(64),
    });
    expect(readIdentity(db, "repository", "repo-1")).toMatchObject({
      codebaseId: "cb-1",
      repositoryPath: "/fixture",
    });
  });

  it("blocks legacy and conflicted runs while accepting one immutable ready snapshot", () => {
    commitStateChange(db, { type: "codebase.registered", payload: { codebaseId: "cb-1" } });
    createRun("run-legacy");
    expect(() => assertRunInstructionReadiness(db, "run-legacy")).toThrowError(
      expect.objectContaining<Partial<CodebaseError>>({ code: "RUN_INSTRUCTIONS_MISSING" }),
    );

    createRun("run-ready");
    snapshotRunInstructions(db, "run-ready", snapshot());
    expect(assertRunInstructionReadiness(db, "run-ready")).toMatchObject({ readiness: "ready" });
    expect(() => snapshotRunInstructions(db, "run-ready", snapshot())).toThrow(
      /instruction snapshot is immutable/,
    );

    createRun("run-blocked");
    snapshotRunInstructions(db, "run-blocked", snapshot("blocked"));
    expect(() => assertRunInstructionReadiness(db, "run-blocked")).toThrowError(
      expect.objectContaining<Partial<CodebaseError>>({ code: "RUN_INSTRUCTIONS_BLOCKED" }),
    );

    createRun("run-inconsistent");
    snapshotRunInstructions(db, "run-inconsistent", {
      ...snapshot("blocked"),
      readiness: "ready",
    });
    expect(() => assertRunInstructionReadiness(db, "run-inconsistent")).toThrowError(
      expect.objectContaining<Partial<CodebaseError>>({ code: "RUN_INSTRUCTIONS_BLOCKED" }),
    );
  });

  it("re-discovers current instruction content before snapshotting a run", async () => {
    const registered = registration();
    await createRegistrationStatePort(db).commitRegistration(registered);
    createRun("run-fresh");
    const currentContent = "Use the current run instructions.\n";
    const current = await discoverAndSnapshotRunInstructions(
      db,
      "run-fresh",
      {
        fs: {
          realpath: async (path) => path,
          readText: async () => currentContent,
          list: async () => [],
          mkdir: async () => undefined,
          exists: async () => true,
          writeTextAtomic: async () => undefined,
        },
        git: {
          inspect: async () => ({
            path: "/fixture",
            gitCommonDirectory: "/fixture/.git",
            remotes: [],
            defaultRemote: null,
            defaultBranch: null,
            visibleFiles: ["AGENTS.md"],
          }),
        },
        hash: createNodeHashPort(),
        clock: { nowIso: () => "2026-08-06T11:00:00.000Z" },
        registrations: [registered],
      },
      { roots: ["/fixture"] },
    );
    expect(current.sources).toEqual([
      expect.objectContaining({
        location: expect.objectContaining({ path: "AGENTS.md", repositoryId: "repo-1" }),
        contentSha256: createHash("sha256").update(currentContent).digest("hex"),
      }),
    ]);
    expect(assertRunInstructionReadiness(db, "run-fresh").capturedAt).toBe(
      "2026-08-06T11:00:00.000Z",
    );
  });
});
