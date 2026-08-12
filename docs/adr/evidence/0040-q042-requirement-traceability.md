# Q042 requirement traceability

| Requirement | Implementation | Deterministic evidence |
|---|---|---|
| Run complete independent task pipelines concurrently | `TaskWaveSchedulerService.tick()` starts and ticks selected child runs with `Promise.all` | Fake-driver test observes two overlapping starts and stable task-ID order |
| Persist lifecycle, wave, dispatch, binding, leases, and audit | Migration 23 and `createTaskWaveStateStore()` | Migration/schema pins plus restart state test |
| Make dispatch restart-safe | Parent run, graph revision, and task ID derive immutable dispatch/child/workspace IDs | Repeated tick and recreated service produce one dispatch and one child start |
| Claim the complete capacity set atomically | `dispatchWave()` uses `BEGIN IMMEDIATE` and claims global, account, workspace, and every write-set repository | A two-task wave conflict rolls back the first task's otherwise-valid claims |
| Fence later capacity owners | Each scope/resource claim uses `MAX(fencing_revision) + 1` | Repository reacquisition receives a strictly greater fencing revision |
| Avoid task/stage double counting | The complete dispatch reservation is passed to child launch; external stage usage remains in planning inputs | Driver boundary test sees account/workspace/repository reservation; planner counts external active usage separately |
| Retain allocation through repair and retry | `retrying` increments durable counters without releasing leases | Retry test observes the same child binding and active lease set |
| Release only after terminal acknowledgement | Only `settle()` releases; `cancelling` and `recovery_required` retain | Cancellation and recovery tests inspect active leases before acknowledgement |
| Propagate required-edge failure transitively | Reconciliation blocks only not-started descendants with typed provenance | Failure test preserves root, immediate predecessor, and ordered path while sibling stays active |
| Keep successful dependants gated for Q043 | New projections initialize all completion/integration/combined-verification gates as `pending` | Planning-state assertions keep dependants deferred after pipeline success |
| Preserve public compatibility | V2 planning snapshot references `TaskDagV2`; all runtime records are versioned; V1 stays registered | Contract and generated-schema compatibility tests cover V1 and V2 together |
