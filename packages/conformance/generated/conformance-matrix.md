# Conformance matrix

Legend: ✓ covered · ⊘ opt-in (not run by default) · — unsupported

| Case | Fake ExecutionBackend | Fake TaskSource | Fake ForgeBackend | Fake PipelineRuntime | Smoke subprocess ExecutionBackend (opt-in) |
| --- | --- | --- | --- | --- | --- |
| execution/answer-is-rejected-after-terminal | ✓ | — | — | — | ⊘ |
| execution/answer-rejects-unknown-interaction-id | ✓ | — | — | — | ⊘ |
| execution/answer-resolves-the-pending-interaction | ✓ | — | — | — | ⊘ |
| execution/cancel-is-idempotent | ✓ | — | — | — | ⊘ |
| execution/cancel-transitions-to-cancelled-and-result-agrees | ✓ | — | — | — | ⊘ |
| execution/crash-requires-explicit-recovery-then-resumes | ✓ | — | — | — | — |
| execution/disconnect-is-classified-and-retryable | ✓ | — | — | — | — |
| execution/interaction-is-surfaced-as-contract-valid-pending-interaction | ✓ | — | — | — | ⊘ |
| execution/interaction-moves-status-to-waiting-on-user | ✓ | — | — | — | ⊘ |
| execution/interactions-are-empty-when-not-waiting | ✓ | — | — | — | ⊘ |
| execution/malformed-result-is-rejected-not-returned | ✓ | — | — | — | ⊘ |
| execution/rate-limit-is-classified-and-retryable | ✓ | — | — | — | — |
| execution/result-is-rejected-before-terminal | ✓ | — | — | — | ⊘ |
| execution/result-matches-execution-result-contract | ✓ | — | — | — | ⊘ |
| execution/resume-continues-and-records-input-artifacts | ✓ | — | — | — | — |
| execution/resume-rejects-unknown-run-id | ✓ | — | — | — | — |
| execution/start-rejects-contract-invalid-request | ✓ | — | — | — | ⊘ |
| execution/start-returns-opaque-run-id | ✓ | — | — | — | ⊘ |
| execution/start-yields-distinct-run-ids | ✓ | — | — | — | ⊘ |
| execution/status-is-non-terminal-immediately-after-start | ✓ | — | — | — | ⊘ |
| execution/status-is-stable-once-terminal | ✓ | — | — | — | ⊘ |
| execution/status-reaches-declared-terminal-state | ✓ | — | — | — | ⊘ |
| execution/status-rejects-unknown-run-id | ✓ | — | — | — | ⊘ |
| forge/create-pull-request-honours-draft-true | — | — | ✓ | — | — |
| forge/create-pull-request-returns-contract-valid-pull-request | — | — | ✓ | — | — |
| forge/disconnect-is-classified-and-retryable | — | — | ✓ | — | — |
| forge/enable-auto-merge-on-draft-pr-is-a-conflict | — | — | ✓ | — | — |
| forge/enable-auto-merge-with-stale-head-is-a-conflict | — | — | ✓ | — | — |
| forge/get-checks-returns-contract-valid-check-statuses | — | — | ✓ | — | — |
| forge/get-failed-check-logs-returns-only-failed-checks | — | — | ✓ | — | — |
| forge/mark-ready-clears-draft | — | — | ✓ | — | — |
| forge/mark-ready-is-idempotent | — | — | ✓ | — | — |
| forge/mark-ready-rejects-unknown-pull-request-id | — | — | ✓ | — | — |
| forge/rate-limit-is-classified | — | — | ✓ | — | — |
| pipeline/admission-named-and-one-off-both-accept | — | — | — | ✓ | — |
| pipeline/attachment-rejects-when-target-not-quiescent | — | — | — | ✓ | — |
| task-source/load-classifies-conflict-fault-for-stale-revision | — | ✓ | — | — | — |
| task-source/load-classifies-rate-limit-fault | — | ✓ | — | — | — |
| task-source/load-increments-revision-after-re-snapshot | — | ✓ | — | — | — |
| task-source/load-is-deterministic-for-repeated-load-of-same-input | — | ✓ | — | — | — |
| task-source/load-rejects-malformed-input | — | ✓ | — | — | — |
| task-source/load-rejects-unknown-source-kind | — | ✓ | — | — | — |
| task-source/load-returns-contract-valid-task-context | — | ✓ | — | — | — |

## Subject notes

- **Smoke subprocess ExecutionBackend (opt-in)** (auth route: `none`) — Represents only the bundled subprocess adapter. Setting HENIEK_CONFORMANCE_SMOKE_MODULE substitutes a different, externally supplied adapter at runtime whose id, capabilities, and auth route are not reflected here — they cannot be known without executing that external module, which this generator never does. Its auth route is instead reported in the vitest describe title at runtime.
