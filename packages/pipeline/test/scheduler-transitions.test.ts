/**
 * Table-tests for the fixed pipeline stage state machine.
 */

import { PipelineStageState } from "@heniek/contracts";
import { describe, expect, it } from "vitest";
import {
  assertPermittedTransition,
  isPermittedTransition,
  isTerminalStageState,
  PERMITTED_TRANSITIONS,
  transitionAdjacency,
} from "../src/scheduler/transitions.js";

describe("pipeline stage transitions", () => {
  it("covers every declared stage state in the adjacency list", () => {
    const adjacency = transitionAdjacency();
    expect(Object.keys(adjacency).sort()).toEqual([...PipelineStageState.values].sort());
  });

  it("accepts every permitted transition and its listed reasons", () => {
    for (const entry of PERMITTED_TRANSITIONS) {
      for (const reason of entry.reasons) {
        expect(isPermittedTransition(entry.from, entry.to, reason)).toBe(true);
        expect(() => assertPermittedTransition(entry.from, entry.to, reason)).not.toThrow();
      }
    }
  });

  it("rejects every undeclared from→to pair", () => {
    for (const from of PipelineStageState.values) {
      for (const to of PipelineStageState.values) {
        if (PERMITTED_TRANSITIONS.some((entry) => entry.from === from && entry.to === to)) {
          continue;
        }
        expect(isPermittedTransition(from, to, "attempt_started")).toBe(false);
        expect(() => assertPermittedTransition(from, to, "attempt_started")).toThrow(
          /undeclared transition/,
        );
      }
    }
  });

  it("treats terminal states as immutable except manual_rerun", () => {
    for (const state of PipelineStageState.values) {
      if (!isTerminalStageState(state)) {
        continue;
      }
      for (const to of PipelineStageState.values) {
        if (to === "pending") {
          expect(isPermittedTransition(state, to, "manual_rerun")).toBe(true);
          expect(isPermittedTransition(state, to, "attempt_started")).toBe(false);
        } else {
          expect(isPermittedTransition(state, to, "manual_rerun")).toBe(false);
        }
      }
    }
  });

  it("exports machine-readable diagram adjacency data", () => {
    const adjacency = transitionAdjacency();
    expect(adjacency.pending).toEqual(["blocked", "cancelled", "ready"]);
    expect(adjacency.ready).toEqual(["blocked", "cancelled", "queued"]);
    expect(adjacency.queued).toEqual(["cancelled", "running"]);
    expect(adjacency.running).toEqual([
      "blocked",
      "cancelled",
      "failed",
      "retrying",
      "succeeded",
      "waiting",
    ]);
    expect(adjacency.waiting).toEqual([
      "blocked",
      "cancelled",
      "failed",
      "retrying",
      "running",
      "succeeded",
      "waiting",
    ]);
    expect(adjacency.retrying).toEqual(["cancelled", "failed", "ready"]);
    expect(adjacency.succeeded).toEqual(["pending"]);
    expect(adjacency.failed).toEqual(["pending"]);
    expect(adjacency.cancelled).toEqual(["pending"]);
    expect(adjacency.blocked).toEqual(["pending"]);
  });
});
