import assert from "node:assert/strict";
import type { TaskSource } from "@heniek/contracts";
import { TaskContextV1 } from "@heniek/contracts";
import type { TaskSourceArrangement } from "../contract/arrangement.js";
import type { ConformanceCase } from "../contract/case.js";
import { assertValid } from "../contract/validation.js";
import { taskSourceInput } from "./fixtures.js";

type TaskSourceCase = ConformanceCase<TaskSource, TaskSourceArrangement>;

export const TASK_SOURCE_CASES: readonly TaskSourceCase[] = [
  {
    id: "task-source/load-returns-contract-valid-task-context",
    title: "load() returns a contract-valid TaskContextV1",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle", "§13.1"],
    async run({ subject, arrange }) {
      await arrange({ kind: "resolves" });
      const context = await subject.load(taskSourceInput());
      assertValid(TaskContextV1, context, "TaskContextV1");
    },
  },
  {
    id: "task-source/load-is-deterministic-for-repeated-load-of-same-input",
    title: "repeated load() of the same input is byte-identical",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle", "RT1", "§13.3"],
    async run({ subject, arrange }) {
      const input = taskSourceInput();
      await arrange({ kind: "resolves" });
      const first = await subject.load(input);
      await arrange({ kind: "resolves" });
      const second = await subject.load(input);
      assert.deepEqual(first, second);
    },
  },
  {
    id: "task-source/load-rejects-malformed-input",
    title: "load() rejects malformed input",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle"],
    async run({ subject, arrange, expectRejection }) {
      await arrange({ kind: "malformed-input" });
      await expectRejection(() => subject.load(taskSourceInput()));
    },
  },
  {
    id: "task-source/load-rejects-unknown-source-kind",
    title: "load() rejects an unknown sourceKind",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle", "§13.1"],
    async run({ subject, arrange, expectRejection }) {
      await arrange({ kind: "unknown-source-kind" });
      await expectRejection(() => subject.load(taskSourceInput()));
    },
  },
  {
    id: "task-source/load-increments-revision-after-re-snapshot",
    title: "re-snapshotting the same source increments revision",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle", "§13.3"],
    async run({ subject, arrange }) {
      const input = taskSourceInput();
      await arrange({ kind: "resolves" });
      const first = await subject.load(input);
      await arrange({ kind: "revised", times: 1 });
      const second = await subject.load(input);
      assert.equal(second.revision, first.revision + 1);
    },
  },
  {
    id: "task-source/load-classifies-rate-limit-fault",
    title: "load() classifies a rate_limit fault",
    requires: ["fault-rate-limit"],
    covers: ["AC2:rate-limit", "rate limits"],
    async run({ subject, arrange, expectFault }) {
      await arrange({ kind: "injects-fault", fault: "rate_limit", occurrences: 1 });
      await expectFault(() => subject.load(taskSourceInput()), "rate_limit");
    },
  },
  {
    id: "task-source/load-classifies-conflict-fault-for-stale-revision",
    title: "load() classifies a conflict fault for a stale revision",
    requires: ["fault-conflict"],
    covers: ["AC2:conflict", "conflicts"],
    async run({ subject, arrange, expectFault }) {
      await arrange({ kind: "injects-fault", fault: "conflict", occurrences: 1 });
      await expectFault(() => subject.load(taskSourceInput()), "conflict");
    },
  },
];
