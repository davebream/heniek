import type {
  HiddenDependencyFinding,
  RunId,
  TaskDagV2,
  TaskGraphRevisionProposal,
  TaskGraphRevisionRecord,
  TaskPlanningState,
  TaskRequirementMapping,
} from "@heniek/contracts";
import { createInitialTaskGraphRevision, validateTaskGraphRevision } from "@heniek/pipeline";
import {
  type Clock,
  createTaskGraphRevisionStateStore,
  type IdGenerator,
  type StateDatabase,
  type TaskGraphRevisionStateStore,
} from "@heniek/state";

export interface TaskGraphRevisionServiceOptions {
  readonly stateDatabase: StateDatabase;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface InitializeTaskGraphInput {
  readonly runId: RunId;
  readonly dag: TaskDagV2;
  readonly requirementMappings: readonly TaskRequirementMapping[];
  readonly rationale: string;
  readonly evidenceArtifactIds: TaskGraphRevisionRecord["evidenceArtifactIds"];
}

export interface SubmitTaskGraphRevisionInput {
  readonly proposal: TaskGraphRevisionProposal;
  readonly taskStates: readonly TaskPlanningState[];
  readonly maxGraphRevisions: number;
  readonly hiddenDependencyFinding?: HiddenDependencyFinding;
}

export interface TaskGraphRevisionService {
  initialize(input: InitializeTaskGraphInput): TaskGraphRevisionRecord;
  submit(input: SubmitTaskGraphRevisionInput): ReturnType<TaskGraphRevisionStateStore["propose"]>;
  active(runId: RunId): TaskGraphRevisionRecord | undefined;
}

/** Application boundary: analysis can propose, while deterministic code alone validates and commits. */
export function createTaskGraphRevisionService(
  options: TaskGraphRevisionServiceOptions,
): TaskGraphRevisionService {
  const store = createTaskGraphRevisionStateStore(options.stateDatabase, validateTaskGraphRevision);
  return {
    initialize(input) {
      return store.initialize(
        createInitialTaskGraphRevision({
          ...input,
          committedAt: options.clock.nowIso(),
        }),
      );
    },
    submit(input) {
      return store.propose({
        ...input,
        decisionId: options.ids.next("task-graph-revision-decision"),
        decidedAt: options.clock.nowIso(),
      });
    },
    active(runId) {
      return store.active(runId);
    },
  };
}

export const taskGraphRevisionValidator = validateTaskGraphRevision;
