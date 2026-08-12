# 40. Durable whole-task wave scheduling and failure propagation

- Status: accepted
- Date: 2026-08-12
- Issue: davebream/heniek#53 (Q042, T2-capability)
- Spec anchors: §13.6 task execution, §17.3 bounded parallelism, §18 durable scheduling
- Evidence:
  [`evidence/0040-q042-parallel-wave-timeline.json`](evidence/0040-q042-parallel-wave-timeline.json),
  [`evidence/0040-q042-capacity-propagation-audit.json`](evidence/0040-q042-capacity-propagation-audit.json),
  [`evidence/0040-q042-requirement-traceability.md`](evidence/0040-q042-requirement-traceability.md),
  [`evidence/0040-q042-command-results.md`](evidence/0040-q042-command-results.md)

## Context

Q040 selected deterministic task waves and Q041 made the graph revisionable, but neither owned execution.
Launching individual internal stages as independent scheduler work would allow one task to lose its account or
workspace between repair stages, double-count a reservation, and expose dependants to a partially completed
pipeline. A daemon crash between capacity acquisition and child launch could also duplicate work unless the
dispatch identity and ownership were durable before the launch side effect.

## Decision

One selected task is one scheduler allocation for its complete child pipeline. Migration 23 stores a causal
task lifecycle projection, immutable wave plans and dispatches, task-to-child-run bindings, fenced capacity
leases, and immutable audit events. A wave dispatch runs inside `BEGIN IMMEDIATE`: either every selected task
gets its global slot, account reservation, isolated workspace, and full repository write set, or no new claim
or dispatch remains.

Dispatch, child-run, and workspace identities derive from parent run, graph revision, and task identity.
Uniqueness constraints make replay adopt the recorded child instead of starting a second pipeline. Each new
owner of a capacity resource receives a strictly increasing fencing revision. Global and account limits are
counted transactionally; existing non-task stage usage enters the planning snapshot as external active usage.
The child launch receives the complete dispatch record, so its admission layer can reuse the task's account
and workspace reservation for matching stages while retaining normal accounting for unrelated stage leases.

Each daemon scheduler tick reconciles child observations first, propagates terminal dependency failures,
builds a V2 planning snapshot from durable state, atomically records the next wave, starts selected children
concurrently, and ticks all active children concurrently. Retries and cancellation requests remain within the
same child binding and retain every lease. Confirmed success, failure, or cancellation settles the projection
and releases the full capacity set; missing or unconfirmed children enter `recovery_required` and stay fenced.

All dependency edges are required. Failure, cancellation, or an existing block marks only `not_started`
descendants `blocked`. The reason records the immediate predecessor, original failed/cancelled root, and the
ordered root-to-descendant path. Independent siblings continue. A successful task still has pending
completion/integration/combined-verification gates, so dependants remain ineligible.

## Boundaries

Q043 owns repository integration and advancing integration and combined-verification gates. Q045 owns hidden
dependency pause, graph revision, and resume. This service is daemon-internal: no model-facing graph mutation
surface or provider DTO crosses the execution-backend boundary.
