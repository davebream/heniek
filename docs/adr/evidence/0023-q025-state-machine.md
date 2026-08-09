# Q025 — state machine table and diagram adjacency

Generated from `packages/pipeline/src/scheduler/transitions.ts` (`PERMITTED_TRANSITIONS`
and `transitionAdjacency()`).

## Stage states

| State | Terminal |
| --- | --- |
| pending | no |
| ready | no |
| queued | no |
| running | no |
| waiting | no |
| retrying | no |
| succeeded | yes |
| failed | yes |
| cancelled | yes |
| blocked | yes |

## Permitted transitions

| From | To | Reasons |
| --- | --- | --- |
| pending | ready | dependencies_satisfied, root_eligible |
| pending | cancelled | condition_not_selected, cancel_requested, pipeline_cancelled, deadline_exceeded |
| pending | blocked | condition_blocked, dependency_unsatisfied |
| ready | queued | dispatch_intent |
| ready | cancelled | cancel_requested, pipeline_cancelled, deadline_exceeded, condition_not_selected |
| ready | blocked | condition_blocked, dependency_unsatisfied, deadline_exceeded |
| queued | running | attempt_started |
| queued | cancelled | cancellation_settled |
| running | waiting | attempt_waiting |
| running | succeeded | attempt_succeeded |
| running | failed | attempt_failed, retry_exhausted |
| running | retrying | retry_scheduled |
| running | cancelled | cancellation_settled |
| waiting | running | attempt_started |
| waiting | succeeded | attempt_succeeded |
| waiting | failed | attempt_failed, retry_exhausted |
| waiting | retrying | retry_scheduled |
| waiting | cancelled | cancellation_settled |
| retrying | ready | retry_scheduled |
| retrying | failed | retry_exhausted |
| retrying | cancelled | cancel_requested, pipeline_cancelled, deadline_exceeded |
| succeeded | pending | manual_rerun |
| failed | pending | manual_rerun |
| cancelled | pending | manual_rerun |
| blocked | pending | manual_rerun |

## Diagram adjacency (machine-readable)

```json
{
  "pending": ["blocked", "cancelled", "ready"],
  "ready": ["blocked", "cancelled", "queued"],
  "queued": ["cancelled", "running"],
  "running": ["cancelled", "failed", "retrying", "succeeded", "waiting"],
  "waiting": ["cancelled", "failed", "retrying", "running", "succeeded"],
  "retrying": ["cancelled", "failed", "ready"],
  "succeeded": ["pending"],
  "failed": ["pending"],
  "cancelled": ["pending"],
  "blocked": ["pending"]
}
```
