# 27. Segment fusion and smart continuation

- Status: accepted
- Date: 2026-08-09
- Issue: davebream/heniek#30 (Q029 — implement segment fusion, smart
  continuation, capsules and incoming verification, T2-capability, milestone
  M3, closes it)
- Spec anchors: §15 Logical stages and execution segments, §19.3 Fresh review
  context, §31 Product metrics and local evaluation
- Evidence:
  [`evidence/0027-q029-command-results.md`](evidence/0027-q029-command-results.md),
  [`evidence/0027-q029-fused-versus-split-trace.md`](evidence/0027-q029-fused-versus-split-trace.md),
  [`evidence/0027-q029-validated-capsule.md`](evidence/0027-q029-validated-capsule.md),
  [`evidence/0027-q029-incoming-verification.md`](evidence/0027-q029-incoming-verification.md)

## Context

Q028 shipped auditable recovery decisions and retry directives. Milestone M3
still required compatible adjacent agent stages to share a provider session,
context pressure to trigger a validated continuation capsule, and fresh
segments to verify repository and artifact reality before continuing. Existing
runners always cold-started successors and never consumed backend telemetry
cursors for handoff thresholds.

## Decision

### D1 — Additive contracts; prior digests frozen

`ExecutionResumeRequest/v1` and `ExecutionBackendV1`–`V7` stay byte-identical.
Q029 adds `PipelineExecutionSegment/v1`, `PipelineFusionDecision/v1`,
`PipelineContinuationCapsule/v1`, `PipelineIncomingVerification/v1`, and
`ExecutionResumeRequest/v2` plus `ExecutionBackendV8` whose `resume` accepts
v2 (bounded next-stage instruction, artifact refs, optional capsule ref). The
manifest grows 152 → 157 by pure addition.

### D2 — Conservative fusion eligibility

Fusion permits only direct, serialized agent-stage transitions when resolved
profile fingerprints, canonical permissions digests, workspace/lease, and
retry/session posture match; the backend supports continuation; neither stage
requires fresh review (`session.policy: fresh` or critic/reviewer roles); and
context pressure is available below the soft threshold. Explicit fresh,
delegated/fresh recovery, branching ambiguity, unavailable/contradictory
telemetry, profile changes, or workspace changes record a typed split reason.
Missing telemetry forbids fusion — never optimistic reuse.

### D3 — Soft/hard thresholds and safe turn boundaries

Defaults remain 0.65 soft / 0.80 hard; pipeline overrides are authoritative. At
soft: finish the current backend turn, start no further same-session turn. At
hard or capacity exhaustion: checkpoint at that turn boundary and continue
unfinished stage work in a fresh segment via a capsule. A backend turn is the
smallest safely checkpointable unit.

### D4 — Capsules and incoming verification

Capsules carry exact run/stage/attempt/segment coordinates, plan state, next
action, repository HEADs and sorted dirty-file witnesses, artifact/context
refs with hashes, decision/question/risk refs, telemetry cursor, and outgoing
session identity. Payloads are canonicalized and SHA-256 digested. Narrative
text truncates at 32 KiB with omitted counts; required artifact refs and exact
continuation state never drop — overflow is a typed blocker. Before any
capsule-backed start, verification checks digest, artifacts, context files,
HEAD/dirty set, completion claims, and cheap checks; failures block without
automatic repository mutation.

### D5 — Durable segment ledger (migration 16)

Append-only fusion decisions, capsules, pressure observations, and verification
verdicts, plus mutable segment status and per-run metrics (session, cold-start,
fused-stage, smart-continuation), persist beside the scheduler. Segments own
workspace and backend execution identity; each logical stage still completes
and persists artifacts before a successor joins the segment.

## Consequences

- Bundled pipelines (Q030) can rely on fusion and continuation semantics.
- Operators can audit every fuse/split and every capsule handoff.
- Claudexor `/v2` resume uses the v2 instruction for fused successors.

## Commands

See [`evidence/0027-q029-command-results.md`](evidence/0027-q029-command-results.md).
