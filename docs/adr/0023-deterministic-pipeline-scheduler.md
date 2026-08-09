# 23. Deterministic pipeline graph scheduler

- Status: accepted
- Date: 2026-08-09
- Issue: davebream/heniek#26 (Q025 — deterministic graph scheduling and the fixed stage
  state machine, T1-foundation, milestone M3, closes it)
- Spec anchors: §14 Pipeline model, §16 Canonical run state and artifacts, §20.2 Task-level DAG,
  §24 Limits, retries, and safeguards, §27.5 cancellation acknowledgement
- Evidence:
  [`evidence/0023-q025-command-results.md`](evidence/0023-q025-command-results.md),
  [`evidence/0023-q025-state-machine.md`](evidence/0023-q025-state-machine.md),
  [`evidence/0023-q025-replay-log.md`](evidence/0023-q025-replay-log.md)

## Context

Q024 gave the repository a pure YAML → `PipelineGraph/v1` reading layer and nothing that could
drive it. Milestone M3's next obligation is the fixed stage state machine and a deterministic
scheduler that computes eligibility, transitions, and durable dispatch intents from canonical
state and explicit time alone.

Runners stay out of scope (Q026). Account/capacity scheduling (migration 10) and the native Claude
bridge (migration 11) remain sibling layers: they admit one backend attempt; this issue
orchestrates a whole graph.

## Decision

### D1 — Pipeline-runtime contracts, not a widened `RunStatus`

The ten stage states (`pending`, `ready`, `queued`, `running`, `waiting`, `retrying`,
`succeeded`, `failed`, `cancelled`, `blocked`) live in the pipeline contract family as
`PipelineStageState`. `RunStatus` and `ExecutionStatus` stay unchanged. Callers still see the
public run vocabulary; the richer graph lifecycle is a separate projection.

`blocked` is a terminal stage state and a terminal pipeline outcome with a typed reason. An
unselected conditional branch is not blocked — it settles as `cancelled` with
`condition_not_selected`.

### D2 — Pure `tickScheduler` in `@heniek/pipeline`, durable apply in `@heniek/state`

The scheduler is a pure function of `PipelineSchedulerInput/v1` → `PipelineSchedulerPlan/v1`.
Decision, attempt, and intent ids are derived from `(runId, graphRevision, stageId, generation,
attemptOrdinal, action)` so duplicate ticks collide on uniqueness constraints. Decisions are
sorted by canonical stage id.

Migration 12 stores immutable graph revisions and attempts, mutable per-stage projections,
append-only decisions, uniquely keyed outbox intents, pending observations, and evaluator
decisions. `applyPipelineSchedulerPlan` writes decision and intent rows first, then projection
patches, under an expected-revision compare-and-swap. Concurrent applies against the same
revision yield exactly one winner; the loser reloads and reticks.

### D3 — Expression evaluation is data-only; evaluators are intents

Compiled expression ASTs evaluate against canonical JSON without executable code. Missing or
incompatible state produces typed `blocked`, never a throw into `eval`. Evaluator conditions
persist as outbox intents and resolve only from recorded evaluator decisions on later ticks.

### D4 — Separate ticks for `running → retrying → ready`

A retryable failure stops at `retrying` on the tick that observes it. The next tick rearms
`retrying → ready` and may queue the next attempt. No backoff policy is invented; time only
enforces declared deadlines and duration limits. Unresolved `maxRepairAttempts` means zero
repairs (one try).

### D5 — Cancellation intent before side effects; optional failure stays local

Cancel requests cancel inactive stages immediately and emit cancel intents for
`queued`/`running`/`waiting` attempts, which remain truthful until settlement. Manual reruns bump
generation on the target and transitive descendants, resetting them to `pending` while prior
attempts and decisions stay immutable.

Optional stage failure leaves the stage `failed` and continues compatible successors; only
successors whose selected dependencies or declared inputs are unsatisfied become `blocked`.
Optional failures do not fail an otherwise successfully completed graph.

## Consequences

- Q026 drains `dispatch` intents; it does not re-decide eligibility.
- Diagram adjacency and the transition table are generated from
  `PERMITTED_TRANSITIONS` — the only place permitted edges are declared.
- Seeded replay after SQLite reopen must byte-match decisions, projections, and outbox rows.

## Commands

See [`evidence/0023-q025-command-results.md`](evidence/0023-q025-command-results.md).
