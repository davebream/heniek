# 26. Deterministic recovery policy

- Status: accepted
- Date: 2026-08-09
- Issue: davebream/heniek#29 (Q028 — implement conditions, retry/session policy,
  limits and bounded repair, T2-capability, milestone M3, closes it)
- Spec anchors: §14.4 Conditional transitions, §19.6 Validation failure policy,
  §24 Limits, retries, and safeguards
- Evidence:
  [`evidence/0026-q028-command-results.md`](evidence/0026-q028-command-results.md),
  [`evidence/0026-q028-retry-decision-trace.md`](evidence/0026-q028-retry-decision-trace.md),
  [`evidence/0026-q028-bounded-repair-exhaustion.md`](evidence/0026-q028-bounded-repair-exhaustion.md),
  [`evidence/0026-q028-classification-coverage.md`](evidence/0026-q028-classification-coverage.md)

## Context

Q025 shipped a pure deterministic scheduler with expression conditions and a
minimal `retryable` boolean repair path. Q026/Q027 added durable stage runners
that classify failures and set `retryable`, but left validation strategies,
session policy, layered limits, failure signatures, and HITL recovery approval
unapplied. Milestone M3 still required auditable, bounded recovery decisions
that cannot loop on unchanged evidence and never fall back for security or
contract violations.

## Decision

### D1 — Additive contracts; prior digests frozen

`PipelineScheduler*/v1` and `StageRunner*/v1`/`v2` stay byte-identical. Q028 adds
`PipelineFailure/v1`, `PipelineFailureSignature/v1`, `PipelineRetryDirective/v1`,
`PipelineRecoveryDecision/v1`, and scheduler observation/intent/attempt/
decision/input/plan **v2** envelopes that carry normalized failures, recovery
proposals, effective limits, session policy, delegated profile, and prior-attempt
linkage. V2-only transition vocabulary covers `recovery_proposed`,
`recovery_approved`, `recovery_rejected`, `repair_exhausted`, and
`unchanged_failure_exhausted`. The manifest grows 142 → 152 by pure addition.

### D2 — Six failure categories with retryable as an upper bound

Runner classifications map into `transient`, `provider`, `validation`,
`conflict`, `security`, and `terminal`. The runner’s `retryable` flag is an
upper bound only: security, terminal, and policy-disallowed failures never
retry or fall back. Failure signatures hash stable evidence (category,
classification, phase, code, backend class, validation failures) and exclude
messages, timestamps, and ids.

### D3 — Strictest hard limit wins; one repair budget

Effective repair budget is the minimum of configured/pipeline/stage/
validation/`effectiveLimits` values. That same bound is the unchanged-signature
ceiling. Manual rerun starts a new generation and resets counters. Missing
validation policy fails safely; missing session policy defaults to fresh.

### D4 — Validation strategies and session posture

`pause` blocks, `fail` fails, `repair` resumes, `repair_fresh` starts fresh, and
`delegate` starts fresh with `delegate_to`. Other retryable categories use stage
session policy for agent stages and fresh execution for non-session runners. A
requested resume without a resumable backend attempt is a typed blocker.

### D5 — HITL propose/approve; autonomous dispatch

HITL persists the complete recovery proposal and waits for
`recovery_approved`/`recovery_rejected` before dispatch. Autonomous mode
dispatches an allowed proposal immediately. Agent resumed repairs call backend
`resume`; fresh and delegated repairs create new executions.

### D6 — Durable recovery ledger (migration 15)

Append-only recovery decisions and retry directives, mutable per-generation
recovery counters, and revisioned canonical run state persist beside the
scheduler. Plan apply remains transactional with observation consumption and
outbox settlement.

## Consequences

- Q029 can assume recovery decisions and signatures exist when fusing segments.
- Bundled pipelines (Q030) can declare `on_validation_failure` knowing the
  runtime will honor strategy, session, and budgets.
- Operators can audit every retry input from the recovery decision ledger.

## Commands

See [`evidence/0026-q028-command-results.md`](evidence/0026-q028-command-results.md).
