import type { ArtifactId, SourceWorkItemId, TaskContextV1, TaskSource } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import type { TaskSourceFixtureInput, TaskSourceKindLiteral } from "../cases/fixtures.js";
import type { TaskSourceArrangement } from "../contract/arrangement.js";
import { ConformanceFaultError } from "../contract/fault.js";
import type { TaskSourceHarness } from "../contract/harness.js";
import type { ConformanceContext } from "../kernel/context.js";

type TaskContext = Static<typeof TaskContextV1>;

const SOURCE_KINDS: readonly TaskSourceKindLiteral[] = [
  "parent_conversation",
  "manual_text",
  "github_issue",
  "github_pull_request",
  "local_file",
  "existing_branch_or_pr",
];

function isRetryable(fault: string): boolean {
  return fault === "disconnect" || fault === "rate_limit";
}

function parseInput(input: unknown): TaskSourceFixtureInput {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof (input as Record<string, unknown>).ref !== "string" ||
    !SOURCE_KINDS.includes((input as Record<string, unknown>).sourceKind as TaskSourceKindLiteral)
  ) {
    throw new Error("malformed TaskSource input: expected { ref: string; sourceKind }");
  }
  const record = input as Record<string, unknown>;
  return { ref: record.ref as string, sourceKind: record.sourceKind as TaskSourceKindLiteral };
}

interface KeyState {
  readonly sourceWorkItemId: SourceWorkItemId;
  readonly rawContentRef: ArtifactId;
  revision: number;
}

export interface FakeTaskSource {
  readonly source: TaskSource;
  /** Arranges the behaviour of the next `load()` call. */
  arrange(arrangement: TaskSourceArrangement): void;
}

export function createFakeTaskSource(context: ConformanceContext): FakeTaskSource {
  const keyStates = new Map<string, KeyState>();
  let pendingArrangement: TaskSourceArrangement | undefined;

  function stateFor(key: string): KeyState {
    const existing = keyStates.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: KeyState = {
      sourceWorkItemId: context.ids.next("conformance-work-item") as SourceWorkItemId,
      rawContentRef: context.ids.next("conformance-artifact") as ArtifactId,
      revision: 1,
    };
    keyStates.set(key, created);
    return created;
  }

  const source: TaskSource = {
    async load(input: unknown): Promise<TaskContext> {
      const arrangement = pendingArrangement;
      pendingArrangement = undefined;

      if (arrangement?.kind === "malformed-input") {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: "task-source",
          action: "load",
          outcome: "fault",
          detail: { fault: "malformed-input" },
        });
        throw new Error("task source input is malformed");
      }
      if (arrangement?.kind === "unknown-source-kind") {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: "task-source",
          action: "load",
          outcome: "fault",
          detail: { fault: "unknown-source-kind" },
        });
        throw new Error("task source input declares an unknown sourceKind");
      }
      if (arrangement?.kind === "injects-fault") {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: "task-source",
          action: "load",
          outcome: "fault",
          detail: { fault: arrangement.fault },
        });
        throw new ConformanceFaultError(arrangement.fault, isRetryable(arrangement.fault));
      }

      const parsed = parseInput(input);
      const key = JSON.stringify(parsed);
      const state = stateFor(key);
      if (arrangement?.kind === "revised") {
        state.revision += arrangement.times;
      }

      const payload: TaskContext = {
        schemaVersion: 1,
        sourceWorkItemId: state.sourceWorkItemId,
        sourceKind: parsed.sourceKind,
        objective: "Conformance harness objective.",
        constraints: ["Conformance constraint."],
        decisions: [],
        openQuestions: [],
        repositoryReferences: [parsed.ref],
        rawContentRef: state.rawContentRef,
        revision: state.revision,
      };
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: "task-source",
        action: "load",
        outcome: "ok",
        detail: { sourceWorkItemId: payload.sourceWorkItemId, revision: payload.revision },
      });
      return payload;
    },
  };

  return {
    source,
    arrange(arrangement: TaskSourceArrangement): void {
      pendingArrangement = arrangement;
    },
  };
}

/**
 * Every capability the task-source case catalogue actually requires (see the
 * equivalent note in `fakes/execution-backend.ts` for why this is scoped to
 * the family's own cases rather than the full 10-entry global enum).
 */
export const FAKE_TASK_SOURCE_CAPABILITIES = [
  "lifecycle",
  "fault-rate-limit",
  "fault-conflict",
] as const;

export function createFakeTaskSourceHarness(): TaskSourceHarness {
  return {
    name: "fake-task-source",
    capabilities: FAKE_TASK_SOURCE_CAPABILITIES,
    classifyFault: (error: unknown) =>
      error instanceof ConformanceFaultError ? error.kind : "unknown",
    async createSubject(context: ConformanceContext) {
      const fake = createFakeTaskSource(context);
      return {
        subject: fake.source,
        async arrange(arrangement: TaskSourceArrangement): Promise<void> {
          fake.arrange(arrangement);
        },
        async dispose(): Promise<void> {
          // Nothing to release: fully in-memory.
        },
      };
    },
  };
}
