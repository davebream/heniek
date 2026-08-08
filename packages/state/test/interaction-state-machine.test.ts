/**
 * Q020's fixed-seed interaction state-machine and race coverage.
 *
 * As with replay-properties.test.ts, seeds are committed constants. A failing
 * case therefore names a reproducible seed and interaction index.
 */

import { rm } from "node:fs/promises";
import type { PendingInteractionV2 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle } from "../src/database/open.js";
import {
  acceptInteractionAnswer,
  assignBackendExecution,
  commitStateChange,
  compareInteractionProjectionToJournal,
  createStageExecution,
  listInteractionInbox,
  markExecutionOperationDelivered,
  openStateDatabase,
  readPendingExecutionOperations,
  readRunInteractions,
  readRunProjection,
  requestRunResume,
  runMigrations,
  type StateDatabase,
  synchronizePendingInteractions,
  updateStageExecutionStatus,
} from "../src/index.js";
import {
  createDeterministicIds,
  createDeterministicRandom,
  type DeterministicRandom,
} from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

type BackendInteraction = Static<typeof PendingInteractionV2>;

const HASH = "a".repeat(64);
const SEEDS = [0x20_0001, 0x20_0002, 0x20_0003] as const;

let directory: string;
let db: StateDatabase;
let now = "2026-08-08T10:00:00.000Z";

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  db = openStateDatabase({
    path: temp.path,
    clock: { nowIso: () => now },
    ids: createDeterministicIds(1),
  });
  runMigrations(db);
  commitStateChange(db, {
    type: "codebase.registration_committed",
    payload: {
      registration: {
        codebaseId: "codebase-q020",
        configurationSha256: HASH,
        instructionSnapshot: {},
        name: "q020",
        repositories: [
          {
            defaultBranch: "main",
            defaultRemote: "origin",
            gitCommonDirectory: "/tmp/q020/.git",
            name: "q020",
            path: "/tmp/q020",
            remotes: [],
            repositoryId: "repository-q020",
          },
        ],
        rootPath: "/tmp/q020",
        topologySha256: HASH,
      },
    },
  });
  commitStateChange(db, {
    type: "workspace.registered",
    payload: { workspaceId: "workspace-q020", codebaseId: "codebase-q020" },
  });
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function createRun(
  index: number,
  status: "waiting_on_user" | "recovery_required" = "waiting_on_user",
) {
  const runId = `run-${index}`;
  commitStateChange(db, {
    runId,
    type: "run.created",
    payload: { runId, codebaseId: "codebase-q020" },
  });
  createStageExecution(db, {
    runId,
    stageId: `stage-${index}`,
    codebaseId: "codebase-q020",
    repositoryId: "repository-q020",
    workspaceId: "workspace-q020",
    backendKind: "claudexor-v2",
    prompt: "Ask a durable question.",
    artifactPath: "artifacts/result.md",
    limits: {},
  });
  assignBackendExecution(db, runId, `thread-${index}`);
  updateStageExecutionStatus(db, runId, status);
  return runId;
}

function interaction(
  index: number,
  overrides: Partial<BackendInteraction> = {},
): BackendInteraction {
  return {
    schemaVersion: 2,
    id: `interaction-${index}` as never,
    requestedAt: `2026-08-08T10:00:${String(index).padStart(2, "0")}.000Z`,
    questions: [
      {
        id: `free-${index}` as never,
        prompt: "Explain the choice.",
        options: [],
        multiSelect: false,
      },
      {
        id: `single-${index}` as never,
        prompt: "Choose one.",
        options: [{ label: "A" }, { label: "B" }],
        multiSelect: false,
      },
      {
        id: `multiple-${index}` as never,
        prompt: "Choose one or more.",
        options: [{ label: "X" }, { label: "Y" }],
        multiSelect: true,
      },
    ],
    ...overrides,
  };
}

function validSubmission(index: number, expectedInteractionRevision = 1) {
  return {
    schemaVersion: 2 as const,
    interactionId: `interaction-${index}` as never,
    expectedInteractionRevision,
    answers: [
      { questionId: `free-${index}` as never, kind: "free_text" as const, freeText: "Because." },
      {
        questionId: `single-${index}` as never,
        kind: "single_choice" as const,
        selectedLabels: ["A"],
      },
      {
        questionId: `multiple-${index}` as never,
        kind: "multiple_choice" as const,
        selectedLabels: ["X", "Y"],
      },
    ],
  };
}

describe("Q020 durable interaction validation", () => {
  it("freezes explicit question kinds and accepts exactly one complete authenticated answer", () => {
    const runId = createRun(1);
    synchronizePendingInteractions(db, runId, [interaction(1)]);
    expect(readRunInteractions(db, runId)[0]).toMatchObject({
      status: "pending",
      revision: 1,
      questions: [{ kind: "free_text" }, { kind: "single_choice" }, { kind: "multiple_choice" }],
    });

    expect(() => acceptInteractionAnswer(db, runId, validSubmission(1), "")).toThrow(
      "authenticated key id is required",
    );
    expect(() =>
      acceptInteractionAnswer(
        db,
        runId,
        { ...validSubmission(1), answers: validSubmission(1).answers.slice(0, 2) },
        "key-local-1",
      ),
    ).toThrow("cover every interaction question");
    expect(() =>
      acceptInteractionAnswer(
        db,
        runId,
        {
          ...validSubmission(1),
          answers: validSubmission(1).answers.map((answer) =>
            answer.questionId === "single-1" ? { ...answer, selectedLabels: ["unknown"] } : answer,
          ),
        },
        "key-local-1",
      ),
    ).toThrow("unknown option");
    expect(() =>
      acceptInteractionAnswer(
        db,
        runId,
        {
          ...validSubmission(1),
          answers: validSubmission(1).answers.map((answer) =>
            answer.questionId === "multiple-1" ? { ...answer, selectedLabels: ["X", "X"] } : answer,
          ),
        },
        "key-local-1",
      ),
    ).toThrow("duplicate option");
    expect(() =>
      acceptInteractionAnswer(
        db,
        runId,
        {
          ...validSubmission(1),
          answers: validSubmission(1).answers.map((answer) =>
            answer.questionId === "free-1"
              ? { questionId: answer.questionId, kind: "free_text" as const, freeText: " " }
              : answer,
          ),
        },
        "key-local-1",
      ),
    ).toThrow("free-text answer is empty");

    const accepted = acceptInteractionAnswer(db, runId, validSubmission(1), "key-local-1");
    expect(accepted).toMatchObject({ interactionRevision: 2, runId });
    expect(readRunInteractions(db, runId)[0]).toMatchObject({
      status: "answered",
      revision: 2,
      deliveryState: "pending",
    });
    expect(() => acceptInteractionAnswer(db, runId, validSubmission(1), "key-local-2")).toThrow(
      "interaction is not pending",
    );
    expect(
      internalHandle(db)
        .prepare("SELECT count(*) AS count FROM interaction_answer_record WHERE run_id = ?")
        .get(runId)?.count,
    ).toBe(1);
    expect(
      internalHandle(db)
        .prepare("SELECT answered_by_key_id FROM interaction_answer_record WHERE run_id = ?")
        .get(runId)?.answered_by_key_id,
    ).toBe("key-local-1");

    markExecutionOperationDelivered(db, accepted.operationId);
    expect(readRunInteractions(db, runId)[0]).toMatchObject({
      status: "answered",
      revision: 3,
      deliveryState: "delivered",
    });
    expect(compareInteractionProjectionToJournal(db)).toEqual({
      status: "exact",
      divergences: [],
    });
  });

  it("rejects duplicate labels, immutable prompt changes, stale revisions, and wrong-run ids", () => {
    const firstRun = createRun(1);
    const secondRun = createRun(2);
    const duplicateLabels = interaction(9, {
      questions: [
        {
          id: "duplicate-label-question" as never,
          prompt: "Choose.",
          options: [{ label: "same" }, { label: "same" }],
          multiSelect: false,
        },
      ],
    });
    expect(() => synchronizePendingInteractions(db, firstRun, [duplicateLabels])).toThrow(
      "duplicate option label",
    );

    synchronizePendingInteractions(db, firstRun, [interaction(1)]);
    expect(() =>
      synchronizePendingInteractions(db, firstRun, [
        interaction(1, {
          questions: [
            {
              id: "free-1" as never,
              prompt: "Changed after creation.",
              options: [],
              multiSelect: false,
            },
          ],
        }),
      ]),
    ).toThrow("interaction question is immutable");
    expect(() =>
      acceptInteractionAnswer(db, firstRun, validSubmission(1, 99), "key-local"),
    ).toThrow("interaction revision is stale");
    expect(() => acceptInteractionAnswer(db, secondRun, validSubmission(1), "key-local")).toThrow(
      "interaction does not belong to run",
    );
    expect(readRunInteractions(db, firstRun)[0]).toMatchObject({ status: "pending", revision: 1 });
  });
});

describe("Q020 lifecycle, inbox, and races", () => {
  it("orders the global inbox deterministically and removes withdrawn, timed-out, and terminal items", () => {
    const laterRun = createRun(2);
    const earlierRun = createRun(1);
    synchronizePendingInteractions(db, laterRun, [interaction(2)]);
    synchronizePendingInteractions(db, earlierRun, [interaction(1)]);
    expect(listInteractionInbox(db).map((item) => item.runId)).toEqual([earlierRun, laterRun]);
    expect(listInteractionInbox(db).every((item) => item.runRevision > 0)).toBe(true);

    synchronizePendingInteractions(db, earlierRun, []);
    expect(readRunInteractions(db, earlierRun)[0]).toMatchObject({
      status: "cancelled",
      revision: 2,
      cancellationReason: "withdrawn",
    });
    expect(() => acceptInteractionAnswer(db, earlierRun, validSubmission(1), "key-local")).toThrow(
      "interaction is not pending",
    );

    const timeoutRun = createRun(3);
    synchronizePendingInteractions(db, timeoutRun, [
      interaction(3, { timeoutAt: "2026-08-08T10:00:05.000Z" }),
    ]);
    now = "2026-08-08T10:00:06.000Z";
    synchronizePendingInteractions(db, timeoutRun, [
      interaction(3, { timeoutAt: "2026-08-08T10:00:05.000Z" }),
    ]);
    expect(readRunInteractions(db, timeoutRun)[0]).toMatchObject({
      status: "cancelled",
      cancellationReason: "timed_out",
    });

    updateStageExecutionStatus(db, laterRun, "succeeded");
    synchronizePendingInteractions(db, laterRun, [interaction(2)], "question", "succeeded");
    expect(readRunInteractions(db, laterRun)[0]).toMatchObject({
      status: "cancelled",
      cancellationReason: "run_terminal",
    });
    expect(listInteractionInbox(db)).toEqual([]);
    expect(compareInteractionProjectionToJournal(db).status).toBe("exact");
  });

  it("serializes answer/answer, answer/cancel, cancel/answer, and resume/resume races", () => {
    const answerRun = createRun(1);
    synchronizePendingInteractions(db, answerRun, [interaction(1)]);
    const winner = acceptInteractionAnswer(db, answerRun, validSubmission(1), "key-winner");
    expect(() => acceptInteractionAnswer(db, answerRun, validSubmission(1), "key-loser")).toThrow(
      "interaction is not pending",
    );
    synchronizePendingInteractions(db, answerRun, []);
    expect(readRunInteractions(db, answerRun)[0]).toMatchObject({ status: "answered" });
    expect(readPendingExecutionOperations(db).map((operation) => operation.operationId)).toEqual([
      winner.operationId,
    ]);

    const cancelledRun = createRun(2);
    synchronizePendingInteractions(db, cancelledRun, [interaction(2)]);
    synchronizePendingInteractions(db, cancelledRun, []);
    expect(() =>
      acceptInteractionAnswer(db, cancelledRun, validSubmission(2), "key-loser"),
    ).toThrow("interaction is not pending");

    const recoveryRun = createRun(3, "recovery_required");
    const revision = readRunProjection(db, recoveryRun)?.revision ?? -1;
    const resume = requestRunResume(db, recoveryRun, revision, []);
    expect(() => requestRunResume(db, recoveryRun, revision, [])).toThrow("run revision is stale");
    expect(
      readPendingExecutionOperations(db).filter((operation) => operation.runId === recoveryRun),
    ).toEqual([expect.objectContaining({ operationId: resume.operationId, kind: "resume" })]);
  });
});

describe.each(SEEDS)("Q020 fixed seed %i", (seed) => {
  it("keeps revisions monotonic and the inbox equal to replayed actionable state", () => {
    const random: DeterministicRandom = createDeterministicRandom(seed);
    const expectedPending: string[] = [];
    for (let index = 1; index <= 12; index += 1) {
      const runId = createRun(index);
      synchronizePendingInteractions(db, runId, [interaction(index)]);
      const action = random.nextInt(0, 4);
      if (action === 0) {
        expectedPending.push(runId);
      } else if (action === 1) {
        const accepted = acceptInteractionAnswer(db, runId, validSubmission(index), "key-seeded");
        markExecutionOperationDelivered(db, accepted.operationId);
      } else if (action === 2) {
        synchronizePendingInteractions(db, runId, []);
      } else {
        updateStageExecutionStatus(db, runId, "cancelled");
        synchronizePendingInteractions(db, runId, [], "question", "cancelled");
      }
      const snapshot = readRunInteractions(db, runId)[0];
      expect(snapshot?.revision).toBeGreaterThanOrEqual(1);
      expect(snapshot?.revision).toBeLessThanOrEqual(3);
    }

    expect(listInteractionInbox(db).map((item) => item.runId)).toEqual(expectedPending);
    expect(compareInteractionProjectionToJournal(db)).toEqual({
      status: "exact",
      divergences: [],
    });
  });
});
