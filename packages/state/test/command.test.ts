/**
 * `commitStateChange` behaviour (plan Task 4.6, design D6, D7, D10).
 *
 * Everything here goes through the public command API — this is the suite
 * that proves the *unit* keeps the promises the schema alone cannot make:
 * correlation propagation, the payload cap, the M6 input guards, and
 * all-or-nothing writes.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitStateChange,
  commitStateChangeInternal,
  MAX_ARTIFACTS_PER_COMMAND,
  type StageArtifactAssertion,
} from "../src/command/commit.js";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import {
  ArtifactCountExceededError,
  CausalityViolationError,
  PayloadTooLargeError,
  ReducerError,
  StageAssertionFailedError,
  StateStoreError,
} from "../src/errors.js";
import type { CausationEventId } from "../src/journal/event.js";
import { readEventById, readEvents } from "../src/journal/read.js";
import { stringifyCanonical, utf8ByteLength } from "../src/json.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { readIdentity } from "../src/projection/identity.js";
import { readRunProjection } from "../src/projection/run.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

let directory: string;
let db: StateDatabase;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  db = openStateDatabase({
    path: temp.path,
    clock: createFakeClock(),
    ids: createDeterministicIds(1),
  });
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

/** Registers a codebase and returns its commit report — the parent most cases need. */
function registerCodebase(codebaseId = "cb-1") {
  return commitStateChange(db, {
    type: "codebase.registered",
    payload: { codebaseId },
  });
}

function createRun(runId = "run-1", codebaseId = "cb-1") {
  return commitStateChange(db, {
    runId,
    type: "run.created",
    payload: { runId, codebaseId },
  });
}

function countRows(table: string): number {
  const row = internalHandle(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.n ?? -1);
}

describe("correlation and causation propagation (design D6)", () => {
  it("a root command mints a fresh correlation id and has a null causation", () => {
    const report = registerCodebase();
    const event = readEventById(db, report.eventId);
    expect(event?.correlationId).toBe(report.correlationId);
    expect(event?.causationEventId).toBeNull();
  });

  it("a child command copies the parent's correlation id rather than minting one", () => {
    const parent = registerCodebase();
    const child = commitStateChange(db, {
      runId: "run-1",
      type: "run.created",
      payload: { runId: "run-1", codebaseId: "cb-1" },
      causationEventId: parent.eventId as unknown as CausationEventId,
    });
    // Asserted against the parent, not against a value the caller supplied —
    // there is no parameter for a caller to supply one.
    expect(child.correlationId).toBe(parent.correlationId);
    const childEvent = readEventById(db, child.eventId);
    expect(childEvent?.causationEventId).toBe(parent.eventId);
  });

  it("a three-deep chain shares one correlation id; only the root's causation is null", () => {
    const root = registerCodebase();
    const second = commitStateChange(db, {
      runId: "run-1",
      type: "run.created",
      payload: { runId: "run-1", codebaseId: "cb-1" },
      causationEventId: root.eventId as unknown as CausationEventId,
    });
    const third = commitStateChange(db, {
      runId: "run-1",
      type: "run.status_changed",
      payload: { runId: "run-1", status: "running" },
      causationEventId: second.eventId as unknown as CausationEventId,
    });

    expect(second.correlationId).toBe(root.correlationId);
    expect(third.correlationId).toBe(root.correlationId);

    const events = readEvents(db);
    expect(events.map((event) => event.causationEventId)).toEqual([
      null,
      root.eventId,
      second.eventId,
    ]);
  });

  it("a causation id naming a non-existent event raises CausalityViolationError and writes nothing", () => {
    expect(() =>
      commitStateChange(db, {
        type: "codebase.registered",
        payload: { codebaseId: "cb-1" },
        causationEventId: "evt-does-not-exist" as unknown as CausationEventId,
      }),
    ).toThrow(CausalityViolationError);
    expect(countRows("state_event")).toBe(0);
    expect(countRows("codebase")).toBe(0);
  });
});

describe("projection advancement", () => {
  it("run.created then two run.status_changed advance revision 1, 2, 3 with strictly increasing sequences", () => {
    registerCodebase();
    createRun();
    commitStateChange(db, {
      runId: "run-1",
      type: "run.status_changed",
      payload: { runId: "run-1", status: "running" },
    });
    const last = commitStateChange(db, {
      runId: "run-1",
      type: "run.status_changed",
      payload: { runId: "run-1", status: "succeeded" },
    });

    const row = readRunProjection(db, "run-1");
    expect(row?.revision).toBe(3);
    expect(row?.status).toBe("succeeded");
    expect(row?.lastEventSequence).toBe(last.sequence);

    const sequences = readEvents(db).map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("registers a repository against an existing codebase", () => {
    registerCodebase();
    commitStateChange(db, {
      type: "repository.registered",
      payload: { repositoryId: "repo-1", codebaseId: "cb-1" },
    });
    expect(readIdentity(db, "repository", "repo-1")?.codebaseId).toBe("cb-1");
  });

  it("assigns a workspace to a run once the workspace is registered", () => {
    registerCodebase();
    createRun();
    commitStateChange(db, {
      type: "workspace.registered",
      payload: { workspaceId: "ws-1", codebaseId: "cb-1" },
    });
    commitStateChange(db, {
      runId: "run-1",
      type: "run.workspace_assigned",
      payload: { runId: "run-1", workspaceId: "ws-1" },
    });
    const row = readRunProjection(db, "run-1");
    expect(row?.workspaceId).toBe("ws-1");
    expect(row?.revision).toBe(2);
  });
});

describe("payload cap (design D7, X1)", () => {
  /**
   * Builds a payload whose canonical JSON is *exactly* `target` UTF-8 bytes,
   * measured with the same two functions the production path uses rather than
   * by hand-counting braces. The filler is ASCII, so one character is one
   * byte and the length solves directly once the structural overhead is
   * measured.
   */
  function payloadOfExactlyBytes(target: number): {
    readonly codebaseId: string;
    readonly filler: string;
  } {
    const overhead = utf8ByteLength(stringifyCanonical({ codebaseId: "cb-1", filler: "" }));
    const payload = { codebaseId: "cb-1", filler: "a".repeat(target - overhead) };
    const actual = utf8ByteLength(stringifyCanonical(payload));
    if (actual !== target) {
      throw new Error(`payloadOfExactlyBytes built ${actual} bytes, expected ${target}`);
    }
    return payload;
  }

  it("a payload of exactly 65 536 bytes succeeds — the cap is inclusive", () => {
    const report = commitStateChange(db, {
      type: "codebase.registered",
      payload: payloadOfExactlyBytes(65_536),
    });
    expect(report.sequence).toBeGreaterThan(0);
    expect(countRows("state_event")).toBe(1);
  });

  it("a payload of exactly 65 537 bytes — one byte over — raises PayloadTooLargeError", () => {
    let caught: unknown;
    try {
      commitStateChange(db, {
        type: "codebase.registered",
        payload: payloadOfExactlyBytes(65_537),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PayloadTooLargeError);
    expect((caught as PayloadTooLargeError).byteLength).toBe(65_537);
    expect(countRows("state_event")).toBe(0);
  });

  it("the error names the type and byte count but never the payload itself", () => {
    const sentinel = "SENTINEL_PAYLOAD_MARKER";
    let caught: unknown;
    try {
      commitStateChange(db, {
        type: "codebase.registered",
        payload: { codebaseId: "cb-1", filler: `${sentinel}${"a".repeat(65_600)}` },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PayloadTooLargeError);
    const message = (caught as Error).message;
    expect(message).toContain("codebase.registered");
    expect(message).toMatch(/\d{5,}/);
    // The whole point of the error carrying only a byte count: no payload
    // bytes may cross this boundary into a log line.
    expect(message).not.toContain(sentinel);
    expect(countRows("state_event")).toBe(0);
  });

  it("rejects a payload whose String.length is under the cap but whose UTF-8 byte length is over it", () => {
    // Each astral-plane character is 4 UTF-8 bytes but 2 UTF-16 code units,
    // so `.length` here is ~33 000 while the byte length is ~66 000. A cap
    // written against String.length would let this through.
    const emoji = "\u{1F600}".repeat(16_500);
    expect(emoji.length).toBeLessThan(65_536);
    expect(() =>
      commitStateChange(db, {
        type: "codebase.registered",
        payload: { codebaseId: "cb-1", filler: emoji },
      }),
    ).toThrow(PayloadTooLargeError);
    expect(countRows("state_event")).toBe(0);
  });
});

describe("M6 input guards (plan Task 4.3 step 2)", () => {
  it.each(["Run.Created", "run", "run..created", "run.", ".created", "run.Created"])(
    "refuses malformed event type %s and writes nothing",
    (type) => {
      expect(() => commitStateChange(db, { type, payload: {} })).toThrow(StateStoreError);
      expect(countRows("state_event")).toBe(0);
    },
  );

  it("refuses an empty runId", () => {
    expect(() =>
      commitStateChange(db, { runId: "", type: "run.created", payload: { runId: "" } }),
    ).toThrow(StateStoreError);
    expect(countRows("state_event")).toBe(0);
  });

  it("refuses an over-long runId, naming the field and length but never echoing the value", () => {
    const runId = "r".repeat(257);
    let caught: unknown;
    try {
      commitStateChange(db, { runId, type: "run.created", payload: { runId, codebaseId: "cb-1" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateStoreError);
    const message = (caught as Error).message;
    expect(message).toContain("runId");
    expect(message).toContain("257");
    expect(message).not.toContain(runId);
    expect(countRows("state_event")).toBe(0);
  });
});

describe("run-scoped vs identity events (finding C5)", () => {
  it("codebase.registered with runId omitted succeeds and stores run_id as NULL", () => {
    const report = registerCodebase();
    expect(readEventById(db, report.eventId)?.runId).toBeNull();
    expect(readEvents(db)[0]?.runId).toBeNull();
  });

  it("run.created with runId omitted is refused by appendEvent's guard, not silently treated as an identity event", () => {
    // `run.*` with no runId is a caller bug. The reducer's own guard would
    // also catch it, but the point is that it never reaches storage.
    expect(() =>
      commitStateChange(db, {
        type: "run.created",
        payload: { runId: "run-1", codebaseId: "cb-1" },
      }),
    ).toThrow(StateStoreError);
    expect(countRows("state_event")).toBe(0);
  });
});

describe("reducer refusals roll the whole unit back", () => {
  it("an unknown type raises ReducerError naming the event id and writes nothing", () => {
    let caught: unknown;
    try {
      commitStateChange(db, { type: "run.exploded", payload: { runId: "run-1" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReducerError);
    expect((caught as ReducerError).eventType).toBe("run.exploded");
    expect((caught as ReducerError).eventId.length).toBeGreaterThan(0);
    expect(countRows("state_event")).toBe(0);
    expect(countRows("run_projection")).toBe(0);
  });

  it("repository.registered for an unregistered codebase raises ReducerError and writes nothing", () => {
    expect(() =>
      commitStateChange(db, {
        type: "repository.registered",
        payload: { repositoryId: "repo-1", codebaseId: "cb-missing" },
      }),
    ).toThrow(ReducerError);
    expect(countRows("state_event")).toBe(0);
    expect(countRows("repository")).toBe(0);
  });

  it("a payload.runId disagreeing with the event's run_id is refused", () => {
    registerCodebase();
    expect(() =>
      commitStateChange(db, {
        runId: "run-1",
        type: "run.created",
        payload: { runId: "run-2", codebaseId: "cb-1" },
      }),
    ).toThrow(ReducerError);
    expect(countRows("run_projection")).toBe(0);
  });

  /**
   * `artifact.run_id REFERENCES run_projection(run_id)` (issue #8, Phase 2
   * fix cycle G1, finding F4): mirrors `repository.registered`'s
   * `codebase is not registered` precedent above — the FK is genuinely
   * enforced at the database layer (`PRAGMA foreign_keys = ON`), but
   * `eventScope` loads the referenced `run_projection` row and `applyEvent`
   * raises a typed `ReducerError` before `commitStateChange` ever reaches a
   * raw INSERT, so a missing run surfaces at the API boundary rather than as
   * `SQLITE_CONSTRAINT_FOREIGNKEY`.
   */
  it("artifact.published for a run that does not exist raises ReducerError and writes nothing", () => {
    expect(() =>
      commitStateChange(db, {
        runId: "run-missing",
        type: "artifact.published",
        payload: {
          runId: "run-missing",
          stageId: "stage-1",
          artifactId: "artifact-1",
          name: "plan.md",
          contentHash: "a".repeat(64),
          byteLength: 1,
          mediaType: "text/markdown",
          contentSchemaId: "heniek://contract/Plan/v1",
          producer: "planner",
          sourceLineage: [],
          path: `blobs/sha256/${"a".repeat(64)}`,
        },
      }),
    ).toThrow(ReducerError);
    expect(countRows("state_event")).toBe(0);
    expect(countRows("artifact")).toBe(0);
  });

  /** Same F4 rationale as the `artifact.published` case above. */
  it("stage.completed for a run that does not exist raises ReducerError and writes nothing", () => {
    expect(() =>
      commitStateChange(db, {
        runId: "run-missing",
        type: "stage.completed",
        payload: {
          runId: "run-missing",
          stageId: "stage-1",
          artifacts: [
            {
              artifactId: "artifact-1",
              name: "report.md",
              contentHash: "b".repeat(64),
              byteLength: 1,
              mediaType: "text/markdown",
              contentSchemaId: "heniek://contract/Report/v1",
              producer: "reviewer",
              sourceLineage: [],
              path: `blobs/sha256/${"b".repeat(64)}`,
            },
          ],
        },
      }),
    ).toThrow(ReducerError);
    expect(countRows("state_event")).toBe(0);
    expect(countRows("artifact")).toBe(0);
    expect(countRows("stage_artifact_alias")).toBe(0);
  });
});

/** A minimal, valid `ArtifactRefPayload`-shaped object (`projection/reducer.ts`), field-overridable. */
function artifactRef(
  overrides: Partial<{
    artifactId: string;
    name: string;
    contentHash: string;
    byteLength: number;
    mediaType: string;
    contentSchemaId: string;
    producer: string;
    sourceLineage: readonly string[];
    path: string;
  }> = {},
) {
  const contentHash = overrides.contentHash ?? "a".repeat(64);
  return {
    artifactId: overrides.artifactId ?? "art-1",
    name: overrides.name ?? "report.md",
    contentHash,
    byteLength: overrides.byteLength ?? 1,
    mediaType: overrides.mediaType ?? "text/markdown",
    contentSchemaId: overrides.contentSchemaId ?? "heniek://contract/Report/v1",
    producer: overrides.producer ?? "reviewer",
    sourceLineage: overrides.sourceLineage ?? [],
    path: overrides.path ?? `blobs/sha256/${contentHash}`,
  };
}

/** An assertion that always succeeds, for tests exercising the S3/I6 machinery without real filesystem receipts. */
function noopAssertion(relativePath: string): StageArtifactAssertion {
  return { relativePath, assert: () => {} };
}

describe("commitStateChangeInternal — primaryTable (plan Task 4.1)", () => {
  it("a stage.completed command whose primary table is stage_artifact_alias reports THAT row's revision, not artifact's", () => {
    registerCodebase();
    createRun();

    const first = artifactRef({
      artifactId: "art-1",
      name: "report.md",
      contentHash: "a".repeat(64),
    });
    commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "stage.completed",
        payload: { runId: "run-1", stageId: "stage-1", artifacts: [first] },
      },
      {
        primaryTable: "stage_artifact_alias",
        artifactRelativePaths: [first.path],
        assertions: [noopAssertion(first.path)],
      },
    );

    // A second completion of the SAME (run, stage, name) re-points the
    // alias at a brand-new artifact: the artifact row it inserts is fresh
    // (revision 1, always), while the alias row it updates advances to
    // revision 2 — the two tables' revisions genuinely differ, which is
    // what makes this scenario distinguish the fix from the pre-Q007
    // `reported[0]` (`TABLE_ORDER`-first, i.e. always `artifact`) default.
    const second = artifactRef({
      artifactId: "art-2",
      name: "report.md",
      contentHash: "b".repeat(64),
    });
    const report = commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "stage.completed",
        payload: { runId: "run-1", stageId: "stage-1", artifacts: [second] },
      },
      {
        primaryTable: "stage_artifact_alias",
        artifactRelativePaths: [second.path],
        assertions: [noopAssertion(second.path)],
      },
    );

    const artifactWrite = report.writes.find((write) => write.table === "artifact");
    const aliasWrite = report.writes.find((write) => write.table === "stage_artifact_alias");
    expect(artifactWrite?.revision).toBe(1);
    expect(aliasWrite?.revision).toBe(2);
    expect(report.revision).toBe(2);
  });

  it("omitting primaryTable preserves the pre-Q007 default (reported[0], TABLE_ORDER-first)", () => {
    registerCodebase();
    createRun();
    const first = artifactRef({ artifactId: "art-1", contentHash: "a".repeat(64) });
    commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "stage.completed",
        payload: { runId: "run-1", stageId: "stage-1", artifacts: [first] },
      },
      { artifactRelativePaths: [first.path], assertions: [noopAssertion(first.path)] },
    );
    const second = artifactRef({ artifactId: "art-2", contentHash: "b".repeat(64) });
    const report = commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "stage.completed",
        payload: { runId: "run-1", stageId: "stage-1", artifacts: [second] },
      },
      { artifactRelativePaths: [second.path], assertions: [noopAssertion(second.path)] },
    );
    // TABLE_ORDER sorts "artifact" before "stage_artifact_alias" — the
    // no-primaryTable default reports the artifact row's revision (1), not
    // the alias's (2), exactly matching pre-Q007 behaviour.
    expect(report.revision).toBe(1);
  });
});

describe("commitStateChangeInternal — S3 pre-lock bijection (plan Task 4.2)", () => {
  it("assertions reordered relative to the payload still succeed — matching is by relativePath, never array position", () => {
    registerCodebase();
    createRun();
    const a = artifactRef({ artifactId: "art-a", name: "a.md", contentHash: "a".repeat(64) });
    const b = artifactRef({ artifactId: "art-b", name: "b.md", contentHash: "b".repeat(64) });

    const report = commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "stage.completed",
        payload: { runId: "run-1", stageId: "stage-1", artifacts: [a, b] },
      },
      {
        artifactRelativePaths: [a.path, b.path],
        // Deliberately swapped relative to [a, b] — a naive index-based
        // pairing would validate the wrong row for each artifact; matching
        // by relativePath makes the order irrelevant.
        assertions: [noopAssertion(b.path), noopAssertion(a.path)],
      },
    );
    expect(report.writes.filter((write) => write.table === "artifact")).toHaveLength(2);
    expect(countRows("artifact")).toBe(2);
  });

  it("an assertion whose relativePath matches no payload artifact is refused before BEGIN IMMEDIATE — nothing is written", () => {
    registerCodebase();
    createRun();
    const a = artifactRef({ artifactId: "art-a", name: "a.md", contentHash: "a".repeat(64) });

    let caught: unknown;
    try {
      commitStateChangeInternal(
        db,
        {
          runId: "run-1",
          type: "stage.completed",
          payload: { runId: "run-1", stageId: "stage-1", artifacts: [a] },
        },
        {
          artifactRelativePaths: [a.path],
          // Names a relativePath the payload never cites.
          assertions: [noopAssertion(`blobs/sha256/${"c".repeat(64)}`)],
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StageAssertionFailedError);
    // registerCodebase + createRun already wrote 2 event rows; the refused
    // attempt above must not add a third.
    expect(countRows("state_event")).toBe(2);
    expect(countRows("artifact")).toBe(0);
  });

  it("a payload/assertions length mismatch is refused before BEGIN IMMEDIATE", () => {
    registerCodebase();
    createRun();
    const a = artifactRef({ artifactId: "art-a", contentHash: "a".repeat(64) });
    expect(() =>
      commitStateChangeInternal(
        db,
        {
          runId: "run-1",
          type: "stage.completed",
          payload: { runId: "run-1", stageId: "stage-1", artifacts: [a] },
        },
        { artifactRelativePaths: [a.path], assertions: [] },
      ),
    ).toThrow(StageAssertionFailedError);
    expect(countRows("state_event")).toBe(2);
  });
});

describe("commitStateChangeInternal — I6 artifact-count cap (plan Task 4.2)", () => {
  it("a payload one artifact over the 64-artifact cap, minimal ref shape, is refused by ArtifactCountExceededError", () => {
    registerCodebase();
    createRun();
    const refs = Array.from({ length: MAX_ARTIFACTS_PER_COMMAND + 1 }, (_unused, index) =>
      artifactRef({
        artifactId: `art-${index}`,
        name: `n${index}`,
        contentHash: index.toString(16).padStart(64, "0"),
      }),
    );
    let caught: unknown;
    try {
      commitStateChangeInternal(
        db,
        {
          runId: "run-1",
          type: "stage.completed",
          payload: { runId: "run-1", stageId: "stage-1", artifacts: refs },
        },
        {
          artifactRelativePaths: refs.map((ref) => ref.path),
          assertions: refs.map((ref) => noopAssertion(ref.path)),
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ArtifactCountExceededError);
    expect((caught as ArtifactCountExceededError).count).toBe(MAX_ARTIFACTS_PER_COMMAND + 1);
    expect((caught as ArtifactCountExceededError).limit).toBe(MAX_ARTIFACTS_PER_COMMAND);
    // registerCodebase + createRun already wrote 2 event rows.
    expect(countRows("state_event")).toBe(2);
  });

  it("exactly 64 artifacts, minimal ref shape, is under the cap and succeeds", () => {
    registerCodebase();
    createRun();
    const refs = Array.from({ length: MAX_ARTIFACTS_PER_COMMAND }, (_unused, index) =>
      artifactRef({
        artifactId: `art-${index}`,
        name: `n${index}`,
        contentHash: index.toString(16).padStart(64, "0"),
      }),
    );
    const report = commitStateChangeInternal(
      db,
      {
        runId: "run-1",
        type: "stage.completed",
        payload: { runId: "run-1", stageId: "stage-1", artifacts: refs },
      },
      {
        artifactRelativePaths: refs.map((ref) => ref.path),
        assertions: refs.map((ref) => noopAssertion(ref.path)),
      },
    );
    expect(report.writes.filter((write) => write.table === "artifact")).toHaveLength(64);
  });

  /**
   * I6's boundary reconciliation against `journal/append.ts`'s 64 KiB
   * event-payload cap: for a *realistic* `ArtifactRefV1` shape (every field
   * populated at a representative length, per the plan's own estimate —
   * `relativePath` ~77 bytes, `contentHash` 64 bytes, plus id/name/media
   * type/schema id/producer), the byte cap binds well before 64 artifacts,
   * so the count one over that computed maximum must be refused by
   * `PayloadTooLargeError`, never `ArtifactCountExceededError` — which
   * fires first is a tested, deliberate fact.
   */
  it("a realistic ref shape hits PayloadTooLargeError, not ArtifactCountExceededError, before 64 artifacts", () => {
    registerCodebase();
    createRun();
    // A "realistic" ref includes recorded source lineage — a real derived
    // artifact plausibly cites several upstream ancestors (25, here — well
    // under the reducer's own 64-entry cap, `MAX_SOURCE_LINEAGE_ITEMS`).
    // Without any lineage, this ref shape is small enough that all 64
    // artifacts fit comfortably under the byte cap, which would falsify
    // this test's premise and I6's own reconciliation claim.
    const LINEAGE_ITEMS = 25;
    function realisticRef(index: number) {
      const contentHash = index.toString(16).padStart(64, "0");
      return artifactRef({
        artifactId: `artifact-run-1-stage-1-${index.toString().padStart(6, "0")}`,
        name: `outputs/report-${index.toString().padStart(6, "0")}.md`,
        contentHash,
        byteLength: 123_456,
        mediaType: "text/markdown; charset=utf-8",
        contentSchemaId: "heniek://contract/Report/v1",
        producer: "reviewer-agent",
        sourceLineage: Array.from({ length: LINEAGE_ITEMS }, (_unused, lineageIndex) =>
          `art-${index}-ancestor-${lineageIndex}`.padStart(24, "0"),
        ),
      });
    }
    // Binary-search-free: grow until the payload crosses MAX_PAYLOAD_BYTES
    // (mirrored from journal/append.ts, not re-imported, to keep this test
    // an independent check on the production constant).
    const MAX_PAYLOAD_BYTES = 65_536;
    let refs: ReturnType<typeof realisticRef>[] = [];
    let lastGoodCount = 0;
    for (let count = 1; count <= MAX_ARTIFACTS_PER_COMMAND + 1; count += 1) {
      refs = Array.from({ length: count }, (_unused, index) => realisticRef(index));
      const bytes = new TextEncoder().encode(
        JSON.stringify({ runId: "run-1", stageId: "stage-1", artifacts: refs }),
      ).length;
      if (bytes > MAX_PAYLOAD_BYTES) {
        break;
      }
      lastGoodCount = count;
    }
    // A realistic ref must make the byte cap bind before the count cap —
    // otherwise this test's premise (and I6's own reconciliation claim) is
    // false for this ref shape.
    expect(lastGoodCount).toBeLessThan(MAX_ARTIFACTS_PER_COMMAND);

    const overCount = lastGoodCount + 1;
    const overRefs = Array.from({ length: overCount }, (_unused, index) => realisticRef(index));
    let caught: unknown;
    try {
      commitStateChangeInternal(
        db,
        {
          runId: "run-1",
          type: "stage.completed",
          payload: { runId: "run-1", stageId: "stage-1", artifacts: overRefs },
        },
        {
          artifactRelativePaths: overRefs.map((ref) => ref.path),
          assertions: overRefs.map((ref) => noopAssertion(ref.path)),
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PayloadTooLargeError);
    // registerCodebase + createRun already wrote 2 event rows.
    expect(countRows("state_event")).toBe(2);
  });
});

/**
 * AC-1 unbypassability (dispatch requirement 1b): every event type the
 * reducer accepts, attempted through the **public** `commitStateChange`
 * entry point with no assertions. The six original types must succeed
 * unaffected; the two Q007 types must be refused by `StageAssertionFailedError`
 * — never silently written — regardless of the fact that nothing here checks
 * `event.type`: the refusal is derived purely from which *table* the write
 * would land in (`commit.ts`'s `ARTIFACT_GUARDED_TABLES`), so a future
 * seventh event type that happens to write into `artifact`/
 * `stage_artifact_alias` is caught the same way, automatically.
 */
describe("AC-1 — the public commitStateChange path cannot write artifact/stage_artifact_alias for ANY event type", () => {
  it("enumerates every event type the reducer accepts", () => {
    registerCodebase("cb-guard");
    commitStateChange(db, {
      runId: "run-guard",
      type: "run.created",
      payload: { runId: "run-guard", codebaseId: "cb-guard" },
    });
    commitStateChange(db, {
      type: "workspace.registered",
      payload: { workspaceId: "ws-guard", codebaseId: "cb-guard" },
    });

    // The six original types (P3's vocabulary) are unaffected by the guard
    // — each succeeds normally.
    expect(() =>
      commitStateChange(db, {
        type: "repository.registered",
        payload: { repositoryId: "repo-guard", codebaseId: "cb-guard" },
      }),
    ).not.toThrow();
    expect(() =>
      commitStateChange(db, {
        runId: "run-guard",
        type: "run.status_changed",
        payload: { runId: "run-guard", status: "running" },
      }),
    ).not.toThrow();
    expect(() =>
      commitStateChange(db, {
        runId: "run-guard",
        type: "run.workspace_assigned",
        payload: { runId: "run-guard", workspaceId: "ws-guard" },
      }),
    ).not.toThrow();

    // The two Q007 types: a run now genuinely exists (`run-guard`), so each
    // payload below clears the reducer's own FK check and reaches the
    // structural guard — proving the refusal is the guard, not an
    // incidental ReducerError.
    const publishedRef = artifactRef({ artifactId: "art-guard-1", contentHash: "1".repeat(64) });
    let publishCaught: unknown;
    try {
      commitStateChange(db, {
        runId: "run-guard",
        type: "artifact.published",
        payload: { runId: "run-guard", stageId: "stage-guard", ...publishedRef },
      });
    } catch (error) {
      publishCaught = error;
    }
    expect(publishCaught).toBeInstanceOf(StageAssertionFailedError);

    const completedRef = artifactRef({ artifactId: "art-guard-2", contentHash: "2".repeat(64) });
    let completeCaught: unknown;
    try {
      commitStateChange(db, {
        runId: "run-guard",
        type: "stage.completed",
        payload: { runId: "run-guard", stageId: "stage-guard", artifacts: [completedRef] },
      });
    } catch (error) {
      completeCaught = error;
    }
    expect(completeCaught).toBeInstanceOf(StageAssertionFailedError);

    // Neither guarded table gained a row from either attempt.
    expect(countRows("artifact")).toBe(0);
    expect(countRows("stage_artifact_alias")).toBe(0);
    // Every event type that actually succeeded still wrote its own event row
    // (6 successes: codebase.registered, run.created, workspace.registered,
    // repository.registered, run.status_changed, run.workspace_assigned);
    // the two refused Q007 attempts contribute none.
    expect(countRows("state_event")).toBe(6);
  });
});
