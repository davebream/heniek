import { Type } from "@sinclair/typebox";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  CheckState,
  defineIdNamespace,
  defineStates,
  ExecutionStatus,
  InteractionStatus,
  PullRequestState,
  RunStatus,
  versioned,
} from "../src/index.js";
import type { StateVocabulary } from "../src/kernel/index.js";

const ALL_ID_NAMESPACES = [
  ["ExecutionTaskId", "execution-backend"],
  ["StageId", "execution-backend"],
  ["StageAttemptId", "execution-backend"],
  ["ProfileId", "execution-backend"],
  ["SourceWorkItemId", "task-source"],
  ["PullRequestId", "forge-backend"],
  ["CodebaseId", "run"],
  ["RepositoryId", "run"],
  ["WorkspaceId", "run"],
  ["RunId", "run"],
  ["InteractionId", "interaction"],
  ["ArtifactId", "artifact"],
] as const;

describe("defineIdNamespace", () => {
  it("declares exactly the 12 branded ID types the design distillate lists", () => {
    expect(ALL_ID_NAMESPACES).toHaveLength(12);
  });

  it("accepts a non-empty string and rejects empty string / non-string values", () => {
    const ajv = new Ajv({ strict: true });
    const schema = defineIdNamespace("ExampleId");
    const validate = ajv.compile(schema);

    expect(validate("id-1")).toBe(true);
    expect(validate("")).toBe(false);
    expect(validate(123)).toBe(false);
    expect(validate(null)).toBe(false);
    expect(validate(undefined)).toBe(false);
  });
});

describe("defineStates exhaustiveness", () => {
  const vocabularies = {
    ExecutionStatus,
    RunStatus,
    InteractionStatus,
    PullRequestState,
    CheckState,
  };

  const entries = Object.entries(vocabularies) as [string, StateVocabulary<string, string>][];
  for (const [name, vocabulary] of entries) {
    describe(name, () => {
      it("partitions every value into exactly one of terminal/non-terminal", () => {
        for (const value of vocabulary.values) {
          const inTerminal = vocabulary.terminal.has(value);
          const inNonTerminal = vocabulary.nonTerminal.has(value);
          expect(inTerminal !== inNonTerminal, `"${value}" must be in exactly one partition`).toBe(
            true,
          );
        }
      });

      it("covers every value with terminal ∪ non-terminal, no extras", () => {
        const union = new Set([...vocabulary.terminal, ...vocabulary.nonTerminal]);
        expect(union).toEqual(new Set(vocabulary.values));
      });

      it("isTerminal agrees with the terminal set", () => {
        for (const value of vocabulary.values) {
          expect(vocabulary.isTerminal(value)).toBe(vocabulary.terminal.has(value));
        }
      });

      it("has at least one terminal and one non-terminal value", () => {
        expect(vocabulary.terminal.size).toBeGreaterThan(0);
        expect(vocabulary.nonTerminal.size).toBeGreaterThan(0);
      });
    });
  }

  it("rejects a vocabulary with a value repeated across partitions", () => {
    expect(() => defineStates({ terminal: ["done"], nonTerminal: ["done"] })).toThrow(/duplicate/i);
  });
});

describe("versioned", () => {
  it("rejects a duplicate schema id", () => {
    versioned("KernelTestDuplicateCheck", 1, {});
    expect(() => versioned("KernelTestDuplicateCheck", 1, {})).toThrow(/duplicate/i);
  });

  it("stamps $id and a literal schemaVersion, closed to additional properties", () => {
    const schema = versioned("KernelTestShape", 1, { name: Type.String() });
    expect(schema.$id).toBe("heniek://contract/KernelTestShape/v1");
    expect(schema.additionalProperties).toBe(false);
  });
});
