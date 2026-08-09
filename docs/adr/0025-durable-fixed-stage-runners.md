# 25. Durable fixed stage runners

- Status: accepted
- Date: 2026-08-09
- Issue: davebream/heniek#28 (Q027 — implement approval, integration, verify and
  publish stage runners, T2-capability, milestone M3, closes it)
- Spec anchors: §14.2 First-class stage types, §19 Review and verification,
  §21 Git branch and delivery model
- Evidence:
  [`evidence/0025-q027-command-results.md`](evidence/0025-q027-command-results.md),
  [`evidence/0025-q027-runner-conformance.md`](evidence/0025-q027-runner-conformance.md),
  [`evidence/0025-q027-reconciliation-traces.md`](evidence/0025-q027-reconciliation-traces.md)

## Context

Q026 drained `dispatch`/`cancel` intents for `agent` and `command` stages behind
a shared prepare → start → observe → cancel → collect → validate → finalize
surface and a durable attempt ledger. Milestone M3 still required durable human
gates, expected-SHA integration, independent verification, and provider-neutral
publication — without GitHub DTOs, auto-approved HITL gates, or false atomicity
claims across repositories.

## Decision

### D1 — Additive contracts; Q026 digests frozen

`StageRunnerAttempt/Result/Failure/v1` stay byte-identical. Q027 adds
`StageRunnerAttempt/Result/Failure/v2` (all six stage types plus extended
failure/recovery classes) and explicit operation contracts:
`ApprovalRequest/Decision`, `IntegrationRequest/Result`, `VerifyRequest/Result`,
`PublishRequest/Result`, plus append-only external-observation and
reconciliation-trace envelopes. The manifest grows 125 → 142 by pure addition.

`ForgeBackendV2 extends ForgeBackend` with provider-neutral
`findPullRequests(repositoryId, sourceBranch, targetBranch)` so publish can
adopt a unique PR after an acknowledgement-boundary crash without changing the
existing forge interface.

### D2 — Four runners behind the Q026 phase surface

Approval, integration, verify, and publish implement the same runner interface.
Approval creates a durable InteractionV2-shaped gate, appears in the existing
inbox, and waits until a compare-and-set answer arrives — never auto-answered in
HITL. Rejection is a typed non-retryable failure.

Integration prepares a conflict-free candidate without moving the target ref,
rechecks expected SHAs, then publishes through compare-and-swap. Conflict or
stale refs move nothing; an already-applied candidate is adopted.

Verify runs an explicit argv-based check contract with `shell: false` and
succeeds only when every required check and completion requirement passes.

Publish discovers an exact PR before creating one, validates head SHA, adopts a
unique match, and applies ready/auto-merge only when requested. Ambiguous or
mismatched resources enter typed reconciliation.

### D3 — Operation ledger beside the attempt ledger

Migration 14 rebuilds `pipeline_runner_attempt` with wider stage-type and
recovery CHECKs (preserving Q026 rows) and adds immutable operation requests,
revisioned operation state, approval answers, and append-only
external-observation/reconciliation traces. Operation intent is persisted before
every Git or Forge side effect.

### D4 — Coordinator: selective workspace, non-blocking wait, reconstruct

The daemon provisions managed workspaces only for stages that need a checkout.
Waiting runners (approval, and agent `waiting_on_user`) persist and return so
intent draining continues. After restart, approval/integration/verify/publish
runners reconstruct from durable operation state when possible; interrupted
agent/command behavior stays typed `recovery_required` rather than inventing
success.

### D5 — Local Git adapter; publish depends only on ForgeBackendV2

Integration uses a workspace-bounded local Git adapter (`rev-parse`, merge-tree
candidate preparation, `update-ref` CAS). Publish depends only on
`ForgeBackendV2`. No GitHub credentials, CI watching, multi-repository delivery,
or repair policy land in Q027.

## Consequences

- Q028 can layer retry/session/repair policy on validated runner outcomes.
- Q047 can implement the real GitHub forge adapter behind `ForgeBackendV2`
  without changing publication reconciliation.
- Epic sequencing and partial multi-repository reconciliation remain later
  issues (Q043/Q044/Q049).

## Commands

See [`evidence/0025-q027-command-results.md`](evidence/0025-q027-command-results.md).
