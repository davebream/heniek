# Q032 — Attached ad-hoc stage lifecycle trace

Hermetic store-level attachment (no live daemon). Source stage `design` on
`run-source` is treated as already succeeded; target `run-target` starts at
graph revision 1 with stages `design` (succeeded) and `build` (pending).

| Step | Action | Result |
|---|---|---|
| 1 | `createPipelineSchedule(run-target)` | `graph_revision=1`, `schedule_revision=1`, stages pending |
| 2 | Seed quiescent boundary: `design=succeeded`, `build=pending`, attempt_ordinal 0 | Target idle |
| 3 | `upsertCanonicalRunState(run-target, revision=1)` | Optimistic run revision head = 1 |
| 4 | Validate attach request: source succeeded, dependants pending, expected revisions | Accepted |
| 5 | `attachAdHocStage` under `BEGIN IMMEDIATE` | CAS schedule + canonical revision |
| 6 | Insert `pipeline_graph_revision` row 2 with augmented graph | Synthetic stage `adhoc-import` present |
| 7 | Update schedule to `graph_revision=2`, `schedule_revision=2` | Heads advanced |
| 8 | Insert stage projection `adhoc-import` as `succeeded` | Synthetic completion |
| 9 | Link source artifact aliases onto target stage (source lineage) | Aliases only; no `completeStage` terminalization |
| 10 | Append `pipeline_attachment_ledger` lifecycle `committed` | Idempotent key recorded |
| 11 | Identical retry with same `attachmentId` + digest | `idempotent-replay`, prior lifecycle returned |
| 12 | Post-commit scheduler tick | Releases `build` from succeeded predecessor; attachment does not dispatch |

## Lifecycle record (shape)

```json
{
  "schemaVersion": 1,
  "attachmentId": "attach-1",
  "phase": "committed",
  "sourceRunId": "run-source",
  "sourceStageId": "design",
  "targetRunId": "run-target",
  "targetStageId": "adhoc-import",
  "graphRevisionBefore": 1,
  "graphRevisionAfter": 2,
  "scheduleRevisionAfter": 2,
  "runRevisionAfter": 2
}
```

Covered by `packages/state/test/pipeline-admission.test.ts` and
`packages/conformance` PipelineRuntime attachment case.
