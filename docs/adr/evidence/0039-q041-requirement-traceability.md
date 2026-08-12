# Q041 requirement traceability

| Source requirement | Before | After | Deterministic enforcement |
|---|---|---|---|
| Models propose; deterministic code validates and commits | Q040 validation only | Daemon service accepts proposals; the state transaction invokes the pure validator | No state API accepts a model-authored canonical record |
| Add, split, merge, reorder, or supersede unstarted tasks | Not available | Closed typed change union with cardinality and exact-diff checks | Every changed task ID must be accounted for exactly once |
| Preserve source requirements | Task-source requirements were durable | Each frozen requirement has exact before/after active-task mappings | Missing, duplicate, unknown, baseline-mismatched, or missing-target mappings reject |
| Preserve started/settled history | Planning state existed for wave selection | Every outcome other than `not_started` freezes the complete graph node | Changed or removed frozen nodes reject with `task-graph-revision.started-task` |
| Reject stale or invalid revisions without partial mutation | No revision commit path | `BEGIN IMMEDIATE` validates against the active revision/hash | Rejections append only a decision; accepted revision and projection commit atomically |
| Record complete provenance and affected waves | DAG validation recorded topology | Decisions include rationale, evidence, mappings, task states, diagnostics, and before/after waves | Canonical ordering makes equivalent input byte-identical |
| Preserve public compatibility | `TaskDagV1` | V1 remains registered; `TaskDagV2` adds `pipelineId`; planner accepts both | Contract and generated-schema tests cover both versions |
