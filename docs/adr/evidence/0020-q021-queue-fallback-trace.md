# Q021 sanitized queue and fallback trace

This deterministic trace uses synthetic IDs and fixed timestamps. It contains no provider payload,
credential value, repository path, or real session identifier.

## Capacity and fairness

| Step | Run/candidate | Effective priority | Durable result |
| --- | --- | ---: | --- |
| enqueue | `run-old/primary/account-a` | 0 | queue sequence 1 |
| wait nine minutes | `run-old/primary/account-a` | 9 | remains queue head on FIFO tie |
| enqueue | `run-new/primary/account-a` | 9 | queue sequence 2 |
| atomic claim | `run-old/primary/account-a` | 9 | sibling memberships removed; fenced lease revision 1 |
| competing claim | `run-new/primary/account-a` | 9 | capacity rejected while the first lease is active |
| terminal release | `run-old/primary/account-a` | — | lease released; `run-new` becomes claimable |

The tested account-capacity reduction changes the durable account cap from two to one while one
attempt is active. Already queued work remains queued until active lease count falls below one.
Queues for another account remain independently claimable.

## Typed fallback

| Step | Candidate | Workspace | Decision |
| --- | --- | --- | --- |
| claim | `primary/account-a` | fresh attempt 1 at original SHA | selected primary |
| backend start | `primary/account-a` | preserved | terminal typed `provider_throttled` |
| classify | `primary/account-a` | preserved | fallback eligible; account lease released |
| claim | `fallback/account-b` | distinct fresh attempt 2 at the same original SHA | configured fallback selected |
| terminal result | `fallback/account-b` | read-only Git state unchanged | success; lease released |
| artifact import | `fallback/account-b` | declared artifact length/digest verified | winner imported |

The failed attempt remains in the attempt history with its own workspace ID. Its artifacts are not
listed, read, or imported. Authentication, permission, invalid-request, workspace/artifact,
hard-limit, cancellation, ambiguous, and unknown classifications follow the terminal fail-closed
path instead of the second claim.

## Capacity approval

```text
primary full → durable approval revision 1
              ├── Wait for primary → enqueue candidate 0
              ├── Use fallback N  → enqueue exactly candidate N
              └── Cancel run      → terminal cancelled local attempt

accepted revision 1 → approval revision 2 → duplicate revision 1 is stale
```

The approval survives a database close/reopen both before and after the answer. Acceptance and the
queue/cancel decision share one `BEGIN IMMEDIATE` transaction; no provider answer method is called.
