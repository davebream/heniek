# Q028 failure classification coverage

Mapping from `StageRunnerFailureClassV2` (+ `ExecutionFailureClass` backend
classes on `backend_failed`) to `PipelineFailureCategory`, with the §24
upper-bound retry rule from `packages/pipeline/src/recovery/classify.ts`.
Table cases align with `packages/pipeline/test/recovery-classify.test.ts`.

**Upper-bound rule:** `retryable = runnerRetryable && category !== "security" && category !== "terminal"`.
Security and terminal never retry, even when the runner flagged `retryable: true`.
For other categories, the runner flag is preserved as an upper bound.

## Six categories

| Category | Retryable after upper-bound | Source classifications / backends |
| --- | --- | --- |
| `transient` | iff `runnerRetryable` | `timeout`, `process_failed`, `prepare_failed`, `start_failed`, `workspace_failed`, `recovery_required`, `operation_failed`; `backend_failed` without provider/security backend (incl. `workspace_failed` / `artifact_failed` backends, or no backend) |
| `provider` | iff `runnerRetryable` | `profile_failed`, `forge_failed`; `backend_failed` + provider backends below |
| `validation` | iff `runnerRetryable` | `validation_failed`, `collection_failed`, `finalize_failed` |
| `conflict` | iff `runnerRetryable` | `stale_revision`, `stale_sha`, `merge_conflict`, `reconciliation_required` |
| `security` | **never** | `backend_failed` + `authentication_failed` / `permission_denied` |
| `terminal` | **never** | `cancelled`, `rejected`, `unknown`, `malformed_contract`; `backend_failed` + terminal backends below |

## StageRunnerFailureClassV2 → category

| Classification | Backend class | Category | Retryable after upper-bound |
| --- | --- | --- | --- |
| `prepare_failed` | — | `transient` | runner flag |
| `start_failed` | — | `transient` | runner flag |
| `timeout` | — | `transient` | runner flag |
| `process_failed` | — | `transient` | runner flag |
| `workspace_failed` | — | `transient` | runner flag |
| `recovery_required` | — | `transient` | runner flag |
| `operation_failed` | — | `transient` | runner flag |
| `collection_failed` | — | `validation` | runner flag |
| `validation_failed` | — | `validation` | runner flag |
| `finalize_failed` | — | `validation` | runner flag |
| `profile_failed` | — | `provider` | runner flag |
| `forge_failed` | — | `provider` | runner flag |
| `stale_revision` | — | `conflict` | runner flag |
| `stale_sha` | — | `conflict` | runner flag |
| `merge_conflict` | — | `conflict` | runner flag |
| `reconciliation_required` | — | `conflict` | runner flag |
| `cancelled` | — | `terminal` | never |
| `rejected` | — | `terminal` | never |
| `unknown` | — | `terminal` | never |
| `malformed_contract` | — | `terminal` | never |
| `backend_failed` | _(none)_ | `transient` | runner flag |
| `backend_failed` | `account_unavailable` | `provider` | runner flag |
| `backend_failed` | `profile_unavailable` | `provider` | runner flag |
| `backend_failed` | `model_unavailable` | `provider` | runner flag |
| `backend_failed` | `engine_unavailable` | `provider` | runner flag |
| `backend_failed` | `provider_throttled` | `provider` | runner flag |
| `backend_failed` | `context_capacity_exhausted` | `provider` | runner flag |
| `backend_failed` | `authentication_failed` | `security` | never |
| `backend_failed` | `permission_denied` | `security` | never |
| `backend_failed` | `hard_limit_exceeded` | `terminal` | never |
| `backend_failed` | `cancelled` | `terminal` | never |
| `backend_failed` | `invalid_request` | `terminal` | never |
| `backend_failed` | `ambiguous` | `terminal` | never |
| `backend_failed` | `unknown` | `terminal` | never |
| `backend_failed` | `workspace_failed` | `transient` | runner flag |
| `backend_failed` | `artifact_failed` | `transient` | runner flag |

## Representative test expectations

From `recovery-classify.test.ts` (runner `retryable: true` unless noted):

| Case | Category | `retryable` | `runnerRetryable` |
| --- | --- | --- | --- |
| `backend_failed` + `authentication_failed` | `security` | `false` | `true` |
| `backend_failed` + `permission_denied` | `security` | `false` | `true` |
| `stale_revision` | `conflict` | `true` | `true` |
| `merge_conflict` (`retryable: false`) | `conflict` | `false` | `false` |
| `validation_failed` | `validation` | `true` | `true` |
| `malformed_contract` | `terminal` | `false` | `true` |
| `profile_failed` | `provider` | `true` | `true` |
| `backend_failed` + `provider_throttled` | `provider` | `true` | `true` |
| `timeout` | `transient` | `true` | `true` |
| `backend_failed` (no backend) | `transient` | `true` | `true` |
| `cancelled` | `terminal` | `false` | `false` |
| `backend_failed` + `hard_limit_exceeded` | `terminal` | `false` | `true` |
| `unknown` | `terminal` | `false` | `true` |
