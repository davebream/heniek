import type { InstructionSnapshotV1 } from "@heniek/contracts";
import {
  commitStateChange,
  readIdentity,
  readRunProjection,
  type StateDatabase,
} from "@heniek/state";
import type { Static } from "@sinclair/typebox";
import { type DetectCodebaseDeps, type DetectCodebaseInput, detectCodebase } from "./detect.js";
import { CodebaseError } from "./errors.js";
import { buildInstructionSnapshot } from "./instructions.js";
import type { RegistrationStatePort } from "./registration.js";
import type { AdditionalInstructionSource, RegisteredCodebase } from "./types.js";

type InstructionSnapshot = Static<typeof InstructionSnapshotV1>;

function jsonPayload(value: unknown): Record<string, never> {
  return JSON.parse(JSON.stringify(value)) as Record<string, never>;
}

export function createRegistrationStatePort(db: StateDatabase): RegistrationStatePort {
  return {
    async commitRegistration(registration: RegisteredCodebase): Promise<void> {
      const existing = readIdentity(db, "codebase", registration.codebaseId);
      if (existing?.configurationSha256 === registration.configurationSha256) return;
      commitStateChange(db, {
        type: "codebase.registration_committed",
        payload: jsonPayload({ registration }),
      });
    },
  };
}

export function snapshotRunInstructions(
  db: StateDatabase,
  runId: string,
  instructionSnapshot: InstructionSnapshot,
): void {
  commitStateChange(db, {
    runId,
    type: "run.instructions_snapshotted",
    payload: jsonPayload({ runId, instructionSnapshot }),
  });
}

/** Re-discovers repository-visible sources before creating the immutable run snapshot. */
export async function discoverAndSnapshotRunInstructions(
  db: StateDatabase,
  runId: string,
  deps: DetectCodebaseDeps,
  input: DetectCodebaseInput,
  additional: readonly AdditionalInstructionSource[] = [],
): Promise<InstructionSnapshot> {
  const detection = await detectCodebase(deps, input);
  const repositories = await Promise.all(
    detection.repositories.map(async (repository) => {
      const observation = await deps.git.inspect(repository.path);
      if (observation === null) {
        throw new CodebaseError(
          "NO_REPOSITORIES",
          `Repository disappeared while snapshotting instructions: ${repository.path}`,
          true,
        );
      }
      return { ...observation, repositoryId: repository.repositoryId };
    }),
  );
  const snapshot = await buildInstructionSnapshot(
    deps.fs,
    deps.hash,
    deps.clock.nowIso(),
    repositories,
    additional,
  );
  snapshotRunInstructions(db, runId, snapshot);
  return snapshot;
}

export function assertRunInstructionReadiness(
  db: StateDatabase,
  runId: string,
): InstructionSnapshot {
  const run = readRunProjection(db, runId);
  if (run === undefined || run.instructionSnapshotJson === null) {
    throw new CodebaseError(
      "RUN_INSTRUCTIONS_MISSING",
      `Run ${runId} has no immutable instruction snapshot.`,
    );
  }
  const snapshot = JSON.parse(run.instructionSnapshotJson) as InstructionSnapshot;
  if (
    snapshot.readiness !== "ready" ||
    snapshot.diagnostics.some(
      (diagnostic) =>
        diagnostic.classification === "incompatible" ||
        diagnostic.classification === "indeterminate",
    )
  ) {
    throw new CodebaseError(
      "RUN_INSTRUCTIONS_BLOCKED",
      `Run ${runId} has unresolved instruction diagnostics.`,
    );
  }
  return snapshot;
}
