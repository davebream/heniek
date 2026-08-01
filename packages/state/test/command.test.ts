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
import { commitStateChange } from "../src/command/commit.js";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import {
  CausalityViolationError,
  PayloadTooLargeError,
  ReducerError,
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
