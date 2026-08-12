# 38. Task DAG validation and wave eligibility

- Status: accepted
- Date: 2026-08-12
- Issue: davebream/heniek#49 (Q040, T1-foundation)
- Spec anchors: §20.2 task-level DAG, §20.4 wave eligibility, §24 limits
- Evidence:
  [`evidence/0038-q040-dag-wave-plan.json`](evidence/0038-q040-dag-wave-plan.json),
  [`evidence/0038-q040-requirement-traceability.md`](evidence/0038-q040-requirement-traceability.md),
  [`evidence/0038-q040-command-results.md`](evidence/0038-q040-command-results.md)

## Context

Q039 made task-source observations and execution-task revisions durable, but no provider-neutral contract
could express a whole-task scheduling graph or the exact state used to decide a wave. Reusing the pipeline
stage scheduler would violate the product boundary: an execution task, not one of its internal stages, is an
epic scheduling node.

## Decision

`TaskDagV1` binds immutable `ExecutionTaskRevisionV1` nodes to explicit profiles and optional subscription
accounts. Validation canonicalizes tasks by codepoint order and rejects missing, duplicate, self-referential,
or cyclic dependencies. Two unordered tasks may not write the same repository; the analyzer must add a
dependency or change their write sets before the graph can be scheduled.

`TaskWavePlanningSnapshotV1` contains every fact consumed by eligibility: task outcomes, predecessor gates,
graph-revision state, profile availability, account counters, writer leases, and the run worker limit.
`planTaskWave()` is pure over that snapshot. It selects the next wave in canonical topological order and
records a typed blocking reason for every deferred task. Failed and cancelled prerequisites propagate their
original task identity through pending descendants.

The planner treats missing profile, capacity, and lease observations as unavailable and fails closed. It does
not consult wall-clock time, configuration files, SQLite, a backend, or a registered repository.

## Boundaries

Q040 defines validation and decision artifacts only. Q041 may propose and commit new graph revisions, while
Q042 will persist task lifecycle projections and dispatch selected waves. This change does not execute tasks,
select fallback accounts, mutate graph state, or introduce a daemon/state migration.

