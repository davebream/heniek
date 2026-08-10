import { describeCoverage } from "./cases/catalogue.js";
import type { ConformanceCapability } from "./contract/capability.js";
import { CONFORMANCE_CAPABILITIES, missingCapabilities } from "./contract/capability.js";
import { FAKE_EXECUTION_BACKEND_CAPABILITIES } from "./fakes/execution-backend.js";
import { FAKE_FORGE_BACKEND_CAPABILITIES } from "./fakes/forge-backend.js";
import { FAKE_PIPELINE_RUNTIME_CAPABILITIES } from "./fakes/pipeline-runtime.js";
import { FAKE_TASK_SOURCE_CAPABILITIES } from "./fakes/task-source.js";
import { SMOKE_SUBPROCESS_CAPABILITIES } from "./smoke/subprocess-execution-backend.js";

export type ConformanceFamily =
  | "ExecutionBackend"
  | "TaskSource"
  | "ForgeBackend"
  | "PipelineRuntime";

export interface SubjectDeclaration {
  readonly id: string;
  readonly label: string;
  readonly family: ConformanceFamily;
  readonly availability: "always" | "opt-in";
  readonly capabilities: readonly ConformanceCapability[];
  /** The auth route this subject uses, when statically knowable (C2). */
  readonly authRoute?: string;
  /** A caveat surfaced in the rendered markdown, e.g. scope limitations. */
  readonly note?: string;
}

/**
 * The full roster of subjects the matrix reports on, declared statically so
 * the matrix generator never has to execute the suite to know the shape of
 * the coverage grid (design §8 — "the matrix is derived, not observed").
 * The smoke subprocess adapter's capability list is imported from the same
 * module constant `src/smoke/harness.ts` builds its harness from, so the two
 * can never disagree (plan Phase 8.1).
 */
export const SUBJECT_DECLARATIONS: readonly SubjectDeclaration[] = [
  {
    id: "fake-execution-backend",
    label: "Fake ExecutionBackend",
    family: "ExecutionBackend",
    availability: "always",
    capabilities: FAKE_EXECUTION_BACKEND_CAPABILITIES,
  },
  {
    id: "fake-task-source",
    label: "Fake TaskSource",
    family: "TaskSource",
    availability: "always",
    capabilities: FAKE_TASK_SOURCE_CAPABILITIES,
  },
  {
    id: "fake-forge-backend",
    label: "Fake ForgeBackend",
    family: "ForgeBackend",
    availability: "always",
    capabilities: FAKE_FORGE_BACKEND_CAPABILITIES,
  },
  {
    id: "fake-pipeline-runtime",
    label: "Fake PipelineRuntime",
    family: "PipelineRuntime",
    availability: "always",
    capabilities: FAKE_PIPELINE_RUNTIME_CAPABILITIES,
  },
  {
    id: "smoke-subprocess-execution-backend",
    label: "Smoke subprocess ExecutionBackend (opt-in)",
    family: "ExecutionBackend",
    availability: "opt-in",
    capabilities: SMOKE_SUBPROCESS_CAPABILITIES,
    authRoute: "none",
    // This matrix is a pure function of committed source (design §8) and
    // is generated without executing any code, so it can only describe the
    // bundled adapter — it cannot know what `HENIEK_CONFORMANCE_SMOKE_MODULE`
    // will substitute at runtime without running (and trusting) that
    // external module. Reporting the bundled row's id/capabilities/auth
    // route as if they described whatever actually ran would be dishonest
    // (NEW-4): the external module's auth route is instead reported in its
    // own vitest describe title at runtime (see `src/smoke/harness.ts`).
    note:
      "Represents only the bundled subprocess adapter. Setting " +
      "HENIEK_CONFORMANCE_SMOKE_MODULE substitutes a different, externally " +
      "supplied adapter at runtime whose id, capabilities, and auth route " +
      "are not reflected here — they cannot be known without executing " +
      "that external module, which this generator never does. Its auth " +
      "route is instead reported in the vitest describe title at runtime.",
  },
];

/** Maps a case id's family prefix (`execution/…`, `task-source/…`, `forge/…`, `pipeline/…`) to a `ConformanceFamily`. */
function familyOf(caseId: string): ConformanceFamily {
  if (caseId.startsWith("execution/")) {
    return "ExecutionBackend";
  }
  if (caseId.startsWith("task-source/")) {
    return "TaskSource";
  }
  if (caseId.startsWith("forge/")) {
    return "ForgeBackend";
  }
  if (caseId.startsWith("pipeline/")) {
    return "PipelineRuntime";
  }
  throw new Error(`Cannot determine conformance family for case id: ${caseId}`);
}

export type ConformanceMatrixCell = "covered" | "opt-in" | "unsupported";

export interface ConformanceMatrixCase {
  readonly caseId: string;
  readonly family: ConformanceFamily;
  readonly requires: readonly ConformanceCapability[];
  readonly covers: readonly string[];
}

export interface ConformanceMatrix {
  readonly schemaVersion: "heniek.conformance-matrix.v1";
  readonly capabilities: readonly ConformanceCapability[];
  readonly subjects: readonly SubjectDeclaration[];
  readonly cases: readonly ConformanceMatrixCase[];
  /** `cells[caseIndex][subjectIndex]`, aligned to `cases` and `subjects`. */
  readonly cells: readonly (readonly ConformanceMatrixCell[])[];
}

function cellFor(
  subject: SubjectDeclaration,
  testCase: ConformanceMatrixCase,
): ConformanceMatrixCell {
  if (subject.family !== testCase.family) {
    return "unsupported";
  }
  if (missingCapabilities(subject.capabilities, testCase.requires).length > 0) {
    return "unsupported";
  }
  return subject.availability === "opt-in" ? "opt-in" : "covered";
}

/**
 * Derives the full conformance matrix from the committed catalogue and the
 * statically declared subject roster — a pure function of source, so it is
 * reproducible under `--check` without ever executing the suite (RE1).
 */
export function buildConformanceMatrix(): ConformanceMatrix {
  const cases: ConformanceMatrixCase[] = describeCoverage().map((entry) => ({
    caseId: entry.caseId,
    family: familyOf(entry.caseId),
    requires: entry.requires as readonly ConformanceCapability[],
    covers: entry.covers,
  }));

  const cells = cases.map((testCase) =>
    SUBJECT_DECLARATIONS.map((subject) => cellFor(subject, testCase)),
  );

  return {
    schemaVersion: "heniek.conformance-matrix.v1",
    capabilities: CONFORMANCE_CAPABILITIES,
    subjects: SUBJECT_DECLARATIONS,
    cases,
    cells,
  };
}

const CELL_SYMBOLS: Record<ConformanceMatrixCell, string> = {
  covered: "✓",
  "opt-in": "⊘",
  unsupported: "—",
};

/** Renders a deterministic, human-readable markdown table for the matrix (RE1). */
export function renderConformanceMatrixMarkdown(matrix: ConformanceMatrix): string {
  const header = ["Case", ...matrix.subjects.map((subject) => subject.label)];
  const separator = header.map(() => "---");
  const rows = matrix.cases.map((testCase, caseIndex) => {
    const row = matrix.cells[caseIndex] ?? [];
    return [
      testCase.caseId,
      ...matrix.subjects.map(
        (_subject, subjectIndex) => CELL_SYMBOLS[row[subjectIndex] ?? "unsupported"],
      ),
    ];
  });

  const subjectNotes = matrix.subjects
    .filter((subject) => subject.authRoute !== undefined || subject.note !== undefined)
    .map((subject) => {
      const authRoute =
        subject.authRoute === undefined ? "" : ` (auth route: \`${subject.authRoute}\`)`;
      const note = subject.note === undefined ? "" : ` ${subject.note}`;
      return `- **${subject.label}**${authRoute} —${note}`;
    });

  const lines = [
    "# Conformance matrix",
    "",
    "Legend: ✓ covered · ⊘ opt-in (not run by default) · — unsupported",
    "",
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
    ...(subjectNotes.length > 0 ? ["## Subject notes", "", ...subjectNotes, ""] : []),
  ];
  return lines.join("\n");
}
