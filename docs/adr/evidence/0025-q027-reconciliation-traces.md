# Q027 integration and publication reconciliation traces

Synthetic traces from runner unit suites. SHAs and forge ids are fixtures.

## Integration

| Step | External observation | Classification | Target ref moved |
| --- | --- | --- | --- |
| Read source/target SHAs match expected | `git_ref_read` | `none` (proceed) | no |
| Source SHA ≠ expected | `git_ref_read` | `stale_source` | no |
| Target SHA ≠ expected | `git_ref_read` | `stale_target` | no |
| `merge-tree` conflict | `git_merge_prepared` | `merge_conflict` | no |
| Candidate already contained | `git_merge_prepared` | `already_applied` | no (adopt) |
| CAS `update-ref` succeeds | `git_ref_updated` | `none` / success | yes → candidate |
| CAS `update-ref` stale | `git_ref_updated` | `irreconcilable_external` or stale | no |
| Duplicate dispatch after success | replay stored result | `already_applied` | no |

## Publish

| Step | External observation | Classification | Forge create |
| --- | --- | --- | --- |
| `findPullRequests` → 0 | `forge_pr_listed` | proceed create | yes |
| Unique match + expected head | `forge_pr_adopted` | `adopted` | no |
| Unique match + mismatched head | reconciliation trace | `mismatched_head` | no |
| Multiple matches | reconciliation trace | `ambiguous` | no |
| Create then markReady/auto-merge | `forge_pr_created` (+ ready/auto-merge) | `created` | yes |
| Injected forge fault | `forge_fault` | `forge_failed` | depends |
| Crash after create, before ack | restart `findPullRequests` | `adopted` | no second create |
