/**
 * Seeded property suite (design D16; plan Task 5.4).
 *
 * Hand-rolled on the splitmix32 generator in `test/helpers/determinism.ts`.
 * **The seeds are fixed constants in this file, never chosen at run time** — a
 * property test that picks its own seed is a flaky test with extra steps.
 *
 * *Rejected (D16), do not add:* `fast-check`. Shrinking earns its keep when
 * counterexamples are large and opaque; here a failure is "this seed, at
 * command N" with a readable command list, and the cost is a workspace catalog
 * entry, a lockfile delta, and the supply-chain review ADR 0004 D1 sets as the
 * bar. **Named revisit trigger:** if a replay counterexample ever exceeds
 * ~20 commands, reopen the decision.
 */

import { rm } from "node:fs/promises";
import { RunStatus } from "@heniek/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitStateChange, type StateCommand } from "../src/command/commit.js";
import { openStateDatabase, type StateDatabase } from "../src/database/open.js";
import type { CausationEventId, StateEvent } from "../src/journal/event.js";
import { latestSequence, readEvents } from "../src/journal/read.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { applyEvent } from "../src/projection/reducer.js";
import {
  loadStoredProjectionState,
  type ProjectionState,
  projectionDigest,
} from "../src/projection/state.js";
import { compareProjectionToReplay } from "../src/replay/compare.js";
import { replayJournal } from "../src/replay/replay.js";
import {
  createDeterministicIds,
  createDeterministicRandom,
  createFakeClock,
  type DeterministicRandom,
} from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

/** Fixed, hand-chosen, and never regenerated — see this file's header. */
const SEEDS: readonly number[] = [0x5eed_0001, 0x5eed_0002, 0x5eed_0003];
const COMMAND_COUNT = 40;

/**
 * A command plus whether it should chain to a previously emitted event. The
 * causation id itself cannot be generated ahead of time — it is minted by the
 * store — so the generator emits the *intent* to chain and the driver resolves
 * it against the events actually committed so far.
 */
interface GeneratedCommand {
  readonly command: StateCommand;
  readonly chain: boolean;
}

/**
 * Produces a well-formed command list: codebases first, then repositories and
 * workspaces referencing them, then runs, then status changes and workspace
 * assignments. Only ever references entities it has already created, so every
 * command is one the reducer accepts — this suite tests replay, not the
 * reducer's refusals (those are `command.test.ts`'s job).
 *
 * `runId` is **omitted** on every identity command and **present** on every
 * `run.*` command (finding C5): the generator respects the same optionality
 * `StateCommand.runId` declares rather than synthesising a placeholder id.
 */
function generateCommandSequence(
  random: DeterministicRandom,
  length: number,
): readonly GeneratedCommand[] {
  const codebases: string[] = [];
  const workspaces: string[] = [];
  const runs: string[] = [];
  const generated: GeneratedCommand[] = [];

  for (let index = 0; index < length; index += 1) {
    const chain = random.nextInt(0, 4) > 0 && index > 0;
    // Always seed a codebase first; afterwards pick among whatever the
    // already-generated prefix makes legal.
    const choices: string[] = ["codebase"];
    if (codebases.length > 0) {
      choices.push("repository", "workspace", "run");
    }
    if (runs.length > 0) {
      choices.push("status");
    }
    if (runs.length > 0 && workspaces.length > 0) {
      choices.push("assign");
    }
    const kind = index === 0 ? "codebase" : random.pick(choices);

    switch (kind) {
      case "codebase": {
        const codebaseId = `cb-${index}`;
        codebases.push(codebaseId);
        generated.push({
          command: { type: "codebase.registered", payload: { codebaseId } },
          chain,
        });
        break;
      }
      case "repository": {
        const repositoryId = `repo-${index}`;
        generated.push({
          command: {
            type: "repository.registered",
            payload: { repositoryId, codebaseId: random.pick(codebases) },
          },
          chain,
        });
        break;
      }
      case "workspace": {
        const workspaceId = `ws-${index}`;
        workspaces.push(workspaceId);
        generated.push({
          command: {
            type: "workspace.registered",
            payload: { workspaceId, codebaseId: random.pick(codebases) },
          },
          chain,
        });
        break;
      }
      case "run": {
        const runId = `run-${index}`;
        runs.push(runId);
        generated.push({
          command: {
            runId,
            type: "run.created",
            payload: { runId, codebaseId: random.pick(codebases) },
          },
          chain,
        });
        break;
      }
      case "status": {
        const runId = random.pick(runs);
        generated.push({
          command: {
            runId,
            type: "run.status_changed",
            payload: { runId, status: random.pick(RunStatus.values) },
          },
          chain,
        });
        break;
      }
      default: {
        const runId = random.pick(runs);
        generated.push({
          command: {
            runId,
            type: "run.workspace_assigned",
            payload: { runId, workspaceId: random.pick(workspaces) },
          },
          chain,
        });
        break;
      }
    }
  }

  return generated;
}

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

/** Commits the generated list, resolving `chain` against the events already committed. */
function driveSequence(seed: number, length: number): void {
  const random = createDeterministicRandom(seed);
  const emitted: string[] = [];
  for (const { command, chain } of generateCommandSequence(random.fork("commands"), length)) {
    const causation = chain && emitted.length > 0 ? random.pick(emitted) : undefined;
    const report = commitStateChange(db, {
      ...command,
      ...(causation !== undefined
        ? { causationEventId: causation as unknown as CausationEventId }
        : {}),
    });
    emitted.push(report.eventId);
  }
}

describe.each(SEEDS)("seed %i", (seed) => {
  it("replay reproduces the stored projection exactly", () => {
    driveSequence(seed, COMMAND_COUNT);
    const report = compareProjectionToReplay(db);
    expect(report.divergences).toEqual([]);
    expect(report.status).toBe("converged");
  });

  it("sequences are strictly ascending with no gaps, starting at 1", () => {
    driveSequence(seed, COMMAND_COUNT);
    const sequences = readEvents(db).map((event) => event.sequence);
    expect(sequences).toEqual(Array.from({ length: COMMAND_COUNT }, (_, index) => index + 1));
    expect(latestSequence(db)).toBe(COMMAND_COUNT);
  });

  it("every last_event_sequence names a real event, and every revision equals the number of events that touched its key", () => {
    driveSequence(seed, COMMAND_COUNT);
    const events = readEvents(db);
    // Widened to plain `number` on purpose: `event.sequence` is the branded
    // `EventSequence`, while a projection row's `lastEventSequence` is an
    // ordinary number, and the whole point here is to check one against the
    // other.
    const knownSequences = new Set<number>(events.map((event) => event.sequence));
    const stored = loadStoredProjectionState(db);

    /** How many events wrote this run's row: every `run.*` event naming it. */
    function runWriteCount(runId: string): number {
      return events.filter((event) => event.runId === runId).length;
    }

    for (const row of Object.values(stored.runs)) {
      expect(knownSequences.has(row.lastEventSequence)).toBe(true);
      expect(row.revision).toBe(runWriteCount(row.runId));
    }
    // The three identity tables are written exactly once each, at
    // registration — nothing in the vocabulary updates them afterwards.
    for (const row of [
      ...Object.values(stored.codebases),
      ...Object.values(stored.repositories),
      ...Object.values(stored.workspaces),
    ]) {
      expect(knownSequences.has(row.lastEventSequence)).toBe(true);
      expect(row.revision).toBe(1);
    }
  });

  it("a prefix replay folded over the remaining events equals a whole replay", () => {
    driveSequence(seed, COMMAND_COUNT);
    const latest = latestSequence(db);
    const cut = Math.floor(latest / 2);

    const prefix = replayJournal(db, { throughSequence: cut });
    let combined: ProjectionState = prefix.state;
    for (const event of readEvents(db, { afterSequence: cut })) {
      combined = applyEvent(combined, event);
    }

    const whole = replayJournal(db);
    expect(projectionDigest(combined)).toBe(projectionDigest(whole.state));
  });

  it("correlation ids are constant along every causal chain, and no chain cycles", () => {
    driveSequence(seed, COMMAND_COUNT);
    const events = readEvents(db);
    const byId = new Map<string, StateEvent>(events.map((event) => [event.eventId, event]));

    for (const event of events) {
      let current = event;
      let steps = 0;
      while (current.causationEventId !== null) {
        const parent = byId.get(current.causationEventId);
        expect(parent).toBeDefined();
        if (parent === undefined) {
          break;
        }
        current = parent;
        steps += 1;
        // A cycle would spin here forever; the journal length is a hard upper
        // bound on any acyclic chain.
        expect(steps).toBeLessThanOrEqual(events.length);
      }
      // `current` is now the chain root, and every event on the way shares
      // its correlation id — the propagation rule, checked end to end.
      expect(current.causationEventId).toBeNull();
      expect(event.correlationId).toBe(current.correlationId);
    }
  });
});
