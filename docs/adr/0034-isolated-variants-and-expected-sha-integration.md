# 34. Isolated composite variants and expected-SHA integration

- Status: accepted
- Date: 2026-08-10
- Issue: davebream/heniek#40 (Q036, T2-capability)
- Spec anchors: §12.7 writer isolation, §12.8 variant integration, §21 Git branch and delivery model
- Evidence:
  [`evidence/0034-q036-variant-lease-inventory.json`](evidence/0034-q036-variant-lease-inventory.json),
  [`evidence/0034-q036-integration-trace.json`](evidence/0034-q036-integration-trace.json),
  [`evidence/0034-q036-command-results.md`](evidence/0034-q036-command-results.md)

## Context

Q035 provisions one composite integration view, but parallel writers cannot safely share its concrete
checkouts. Q027 already supplies repository-scoped merge preparation and compare-and-swap ref updates;
Q036 must compose those primitives across a variant without claiming a Git transaction across repositories.

## Decision

Each variant is a non-Git root at `workspaces/<workspace-id>/variants/<variant-id>`. Every repository
receives an isolated detached checkout at the recorded integration SHA. Heniek-managed repositories use
linked worktrees; adopted current, existing, and custom repositories use local clones so variant creation
does not add worktree administration state to the adopted repository.

Only declared write repositories receive durable, renewable leases. All write leases are acquired before
the first checkout is materialized, and every later write-side observation validates lease identity, fence,
and expected HEAD. Read-only repositories persist a complete Git baseline (HEAD, index tree, tracked diff,
and untracked hashes), which is checked before integration.

Integration is an explicit `select-best`, `synthesize`, or `manual` operation. It first imports isolated
clone objects when necessary and prepares every merge commit without moving a target. Publication then
updates refs in repository-ID order using `git update-ref <ref> <candidate> <expected>`. Intent, observations,
preparation, CAS attempts, and outcomes are append-only trace entries.

Replay observes external state: an exact installed candidate is adopted, an unchanged expected ref may be
retried, and any third value stops. If an earlier repository moved before a later repository stops, the
result is `partial-progress`; no rollback or cross-repository atomicity is claimed.

## Compatibility and boundaries

Four public v1 schemas are added and all pre-Q036 generated schemas remain byte-identical. Migration 20
adds a revisioned variant projection and append-only integration trace. The existing writer-lease and Q027
integration contracts remain unchanged.

Q036 does not schedule task waves, create epic branches, run combined verification, clean variants, or
choose compensating actions. Those remain Q038, Q043, and Q044 scope.
