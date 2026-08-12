# 39. Autonomous task-graph revision and provenance

- Status: accepted
- Date: 2026-08-12
- Issue: davebream/heniek#51 (Q041, T2-capability)
- Spec anchors: §4.10 provenance, §13.6 autonomous graph revision, §20.7 hidden dependency discovery
- Evidence:
  [`evidence/0039-q041-before-after-graph.json`](evidence/0039-q041-before-after-graph.json),
  [`evidence/0039-q041-validation-decision.json`](evidence/0039-q041-validation-decision.json),
  [`evidence/0039-q041-requirement-traceability.md`](evidence/0039-q041-requirement-traceability.md),
  [`evidence/0039-q041-command-results.md`](evidence/0039-q041-command-results.md)

## Context

Q040 made whole-task DAG validation and wave selection deterministic, but it deliberately did not let
analysis revise canonical graph state. The V1 DAG also had no pipeline binding, so it could not represent
§13.6's task-preset changes. A model-authored graph cannot become authority directly: stale analysis,
requirement loss, or mutation of already-started work must fail without partially changing the active graph.

## Decision

`TaskDagV2` adds one provider-neutral `pipelineId` per task while V1 remains registered and schedulable.
Analysis submits `TaskGraphRevisionProposalV1`; deterministic validation derives the actual diff, validates
typed add/split/merge/reorder/supersede operations, freezes all non-`not_started` nodes, checks exact task
revision chains, and proves every frozen source requirement still maps to an active task.

Revision and proposal hashes use canonical JSON with sorted object keys and normalized set-like graph fields.
Structural waves are dependency layers, independent of runtime account or worker capacity. The decision records
both wave layouts, affected tasks and ordinals, the authoritative task-state snapshot, policy limit, evidence,
requirement mapping, and every diagnostic.

Migration 22 stores immutable decisions and graph revisions plus one causal active projection. The state store
runs the injected validator inside `BEGIN IMMEDIATE`. An accepted proposal inserts its decision and successor
and advances the projection in one transaction. A rejection inserts only its decision. Concurrent proposals
therefore serialize, and a loser is durably rejected as stale rather than overwriting canonical state.

## Boundaries

Q041 exposes a daemon application service but no model-facing mutation API. Q042 owns durable task lifecycle,
dispatch, capacity, and failure propagation. Q045 owns pausing attempts and resuming after a hidden dependency.
GitHub issue synchronization remains an external projection and is not introduced here.
