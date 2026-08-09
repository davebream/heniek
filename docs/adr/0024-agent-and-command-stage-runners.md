# 24. Agent and command stage runners

- Status: accepted
- Date: 2026-08-09
- Issue: davebream/heniek#27 (Q026 — implement agent and command stage runners,
  T2-capability, milestone M3, closes it)
- Spec anchors: §14.2 First-class stage types, §19.5 Stage completion contract,
  §24 Limits, retries, and safeguards
- Evidence:
  [`evidence/0024-q026-command-results.md`](evidence/0024-q026-command-results.md),
  [`evidence/0024-q026-attempt-exports.md`](evidence/0024-q026-attempt-exports.md),
  [`evidence/0024-q026-cleanup-validation.md`](evidence/0024-q026-cleanup-validation.md)

## Context

Q025 gave the repository a pure deterministic scheduler and durable outbox
intents. Milestone M3's next obligation is to drain `dispatch`/`cancel` intents
for `agent` and `command` stages in isolated managed workspaces, enforce
timeouts and cancellation with descendant cleanup, and refuse success unless
declared outputs and §19.5 evidence validate — exit code or backend status alone
never authorizes completion.

Approval, integration, verify, publish, and evaluator intents remain Q027+.

## Decision

### D1 — Provider-neutral runner contracts, additive only

`StageRunnerAttempt/v1`, `StageRunnerResult/v1`, `StageRunnerEvidence/v1`,
`StageRunnerFailure/v1`, `StageRunnerOutputBinding/v1`,
`StageRunnerCleanupReport/v1`, and `StageRunnerValidationReport/v1` live in the
pipeline contract family. Existing Q025 schemas stay byte-identical; the
manifest grows 118 → 125 by pure addition.

### D2 — Focused `@heniek/runner` package; durable apply in `@heniek/state`

Both runners share `prepare → start → observe → cancel → collect → validate →
finalize`. Command stages spawn with `shell: false`, a validated
workspace-relative cwd, and an allowlisted base environment plus declared `env`.
Agent stages resolve exactly one approved profile and emit one
`ExecutionRequest/v4` through `ExecutionBackendV7`. Pure `@heniek/pipeline`
stays I/O-free.

Migration 13 stores runner attempts, phase transitions, workspace/lease
identity, process or backend handles, collected outputs, evidence, cleanup and
validation reports, and recovery classification. Claiming a dispatch intent
inserts the attempt row before any workspace or process side effect.

### D3 — Daemon coordinator drains intents; scheduler still decides eligibility

`createPipelineRunnerService` ticks the scheduler, claims pending agent/command
intents, provisions one managed worktree and writer lease per attempt, drives
runner phases, and records observations only after validation. Finalization
atomically binds outputs, persists evidence, appends the scheduler observation,
and settles the intent. Duplicate intent delivery and replay-safe finalization
collide on uniqueness constraints.

### D4 — Timeout and cancel prove cleanup; restart never invents success

Command runners send `SIGTERM` to the process group, wait a bounded grace
period, then `SIGKILL`, and record whether descendants remain. Agent runners
call backend cancellation and observe until terminal, or classify
`recovery_required`. Daemon restart resumes observation where a live handle
exists and otherwise records a typed recoverable failure rather than success.

### D5 — Evidence before authority

Validation requires every declared `writes` binding, a contract-valid result
envelope when required, and matching evidence for each completion requirement.
Verdict requirements consume already-recorded verdict evidence only — they do
not launch Q027 verify behavior. An attempt whose only evidence is an exit code
fails with `exitCodeAlone: true`.

## Consequences

- Q027 can add the remaining stage runners behind the same coordinator and
  attempt ledger.
- Repair/retry policy stays Q028; Q026 enforces deadlines and recovery
  classification only.
- Multi-repository composite workspaces remain a later milestone; Q026 uses the
  existing single-repository managed-worktree service.

## Commands

See [`evidence/0024-q026-command-results.md`](evidence/0024-q026-command-results.md).
