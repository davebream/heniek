# A logical stage is not a model session

Design note. Explains why Heniek separates the durable boundary of a pipeline
stage from the live provider session that executes it, what the separation buys,
and what it costs.

Normative scope lives in
[Product Specification v0.2 §15](../product/product-spec-v0.2.md); the accepted
decision and its evidence live in
[ADR 27](../adr/0027-segment-fusion-and-smart-continuation.md). This note is
explanatory and carries no authority over either.

## The problem

A pipeline that runs understanding, design, planning, building, and verification
has an obvious implementation: one stage, one session. Start a provider session,
run the stage, tear the session down, persist the artifact, repeat.

That implementation is wrong in both directions at once.

It is too coarse where stages are cheap and related. `understand`, `design`, and
`plan` executed by the same worker against the same workspace share almost all
of their working context. Cold-starting each one pays to rebuild that context
three times, and the reconstruction is lossy: the second session sees the first
session's artifact, not the reasoning that produced it.

It is too fine where a single stage is expensive. A long `build` stage will
exhaust its context window before the stage is complete. If the stage boundary
is also the session boundary, there is nowhere to put the handoff, and the
options are to fail the stage or to let the session degrade as its context
fills.

The two failures pull in opposite directions, so no single choice of stage
granularity fixes both. The stage boundary is the wrong knob.

## The decision

Heniek treats four things as separate:

```text
logical stage       = semantic and durable boundary
worker profile      = engine, model, account, and role
execution segment   = one live provider session
artifact boundary   = durable output checkpoint
```

A stage still completes and persists its artifacts before any successor joins.
What changes is that the mapping between stages and segments is computed rather
than assumed: several stages may share one segment, and one stage may span
several segments.

Two mechanisms follow. **Fusion** collapses adjacent stages into one segment.
**Smart continuation** splits one stage across segments. They are governed
separately because they answer different questions.

## Fusion, and why it defaults to no

Fusion applies only to a direct, serialized transition between two agent stages,
and only when every one of the following holds: resolved profile fingerprints
match; canonical permissions digests match; workspace and lease are unchanged;
the backend supports continuation; neither stage requires a fresh review
context; and measured context pressure is available and below the soft
threshold.

Anything else records a typed split reason. The vocabulary is closed and
enumerated in `packages/pipeline/src/fusion/evaluate.ts`:

```text
explicit_fresh          profile_mismatch        fingerprint_mismatch
permissions_mismatch    workspace_mismatch      lease_mismatch
backend_no_continuation fresh_review_required   retry_requires_fresh
delegated_recovery      branching_ambiguity     pressure_unavailable
pressure_contradictory  pressure_soft_threshold pressure_hard_threshold
capacity_exhausted      non_agent_stage         not_adjacent
```

Three of those deserve comment.

`fresh_review_required` exists because fusion is an optimization that a reviewer
must never receive. A critic that inherits the session which produced the work
is not reviewing it; it is continuing it. Roles that carry review semantics, and
any stage declaring `session.policy: fresh`, are excluded from fusion by
construction rather than by convention.

`pressure_unavailable` and `pressure_contradictory` encode the conservative
posture: **missing telemetry forbids fusion.** A backend that cannot report
context utilization, or reports it inconsistently, gets cold starts. The
alternative — assume there is room and find out otherwise mid-stage — trades
a recoverable cost for an unrecoverable one.

The asymmetry is deliberate. A wrong split wastes a cold start. A wrong fuse
corrupts a stage that has already been reported as durable.

## Continuation, and where the seam goes

Defaults are `0.65` soft and `0.80` hard, and pipeline overrides are
authoritative:

```yaml
context:
  handoff_soft_threshold: 0.65
  handoff_hard_threshold: 0.80
```

At the soft threshold the runtime finishes the current backend turn and starts
no further turn in that session. At the hard threshold, or on capacity
exhaustion, it checkpoints at that turn boundary and continues the unfinished
stage work in a fresh segment.

The load-bearing choice is that **a backend turn is the smallest safely
checkpointable unit.** Not a token, not a tool call, not a file write. A turn is
the smallest interval at which the runtime can assert that the worker is not
halfway through an edit it believes it has completed. Everything about the seam
follows from picking that unit.

## The capsule is a claim, not a summary

Context compaction summarizes a conversation so a successor can keep talking.
That is not what a continuation capsule is for. A capsule is a **verifiable
claim about the state of the world** that the successor is required to check
before it is allowed to continue.

It records exact run, stage, attempt, and segment coordinates; plan state as
completed, active, and remaining items; the next action; repository HEADs and a
sorted dirty-file witness; artifact and context-file references with content
hashes; decision, question, and risk references; the telemetry cursor; and the
outgoing session identity. The payload is canonicalized and SHA-256 digested.

A redacted example is checked in at
[`0027-q029-validated-capsule.md`](../adr/evidence/0027-q029-validated-capsule.md).
The shape matters more than the values:

```json
{
  "activePlanItem": "wire daemon dispatch",
  "repositoryHeads": [{ "repositoryId": "heniek", "head": "8f31c2a" }],
  "dirtyFiles": ["packages/pipeline/src/fusion/evaluate.ts"],
  "artifactRefs": [{ "artifactId": "art-plan", "contentHash": "…" }],
  "digest": "ce561f243b8d0281ee7e697d295bc8daf9756923172b8ed5eea2f5b624199cb2"
}
```

A separate narrative document carries what the machine record cannot: rejected
alternatives, implicit assumptions, fragile areas, and warnings. It truncates at
32 KiB and reports the omitted byte count. Required artifact references and
exact continuation state are never dropped to fit — a reference set that
overflows is a typed blocker, not a silent truncation. Losing the narrative
costs context. Losing a required reference would let a successor proceed on a
capsule that no longer describes the work, which is the failure the whole
mechanism exists to prevent.

## Verification is the part that makes it safe

Before any capsule-backed segment starts, `verifyIncomingContinuation`
(`packages/pipeline/src/fusion/verify.ts`) checks the capsule digest, artifact
presence and hashes, context files, repository HEAD and dirty set, completion
claims, and a set of cheap checks. Its blockers are enumerated:

| Blocker | Meaning |
|---|---|
| `stale_head` | a repository moved since the capsule was written |
| `dirty_set_mismatch` | the working tree is not what the capsule claims |
| `missing_artifact`, `artifact_hash_mismatch` | a referenced artifact is gone or changed |
| `missing_context_file` | a named context file no longer exists |
| `contradictory_completion` | the capsule claims work the repository does not show |
| `cheap_check_failed` | a fast pre-flight check did not pass |
| `digest_mismatch`, `tampered_capsule` | the capsule is not the one that was written |

**A failed verification blocks without automatic repository mutation.** The
runtime does not reset, stash, or reconcile on the worker's behalf. Silently
repairing a mismatch would mean the successor continues against a state nobody
declared, which is exactly the class of failure that made the seam necessary.

## What it costs

The separation is not free, and the costs are structural rather than incidental.

There is more state. ADR 27 adds a durable, append-only segment ledger holding
fusion decisions, capsules, pressure observations, and verification verdicts,
alongside mutable segment status and per-run metrics. That is a migration and an
ongoing retention obligation in exchange for being able to audit every fuse,
split, and handoff after the fact.

There is more contract surface. Fusion needs `PipelineExecutionSegment/v1`,
`PipelineFusionDecision/v1`, `PipelineContinuationCapsule/v1`,
`PipelineIncomingVerification/v1`, and a resume request able to carry a capsule
reference. These were added without altering existing contracts, and the
manifest grew 152 → 157 by pure addition — but the surface a future
implementation must honor is now larger.

And fusion depends on telemetry the backends do not uniformly provide. Where
context utilization is unavailable or inconsistent, Heniek falls back to cold
starts, so the optimization is unevenly realized across engines. That is the
correct failure direction, but it is a real limit rather than a temporary one.

## Where to look

| Concern | Location |
|---|---|
| Normative model | [spec §15](../product/product-spec-v0.2.md) |
| Accepted decision, D1–D5 | [ADR 27](../adr/0027-segment-fusion-and-smart-continuation.md) |
| Fuse/split traces | [`0027-q029-fused-versus-split-trace.md`](../adr/evidence/0027-q029-fused-versus-split-trace.md) |
| Capsule example | [`0027-q029-validated-capsule.md`](../adr/evidence/0027-q029-validated-capsule.md) |
| Verification verdicts | [`0027-q029-incoming-verification.md`](../adr/evidence/0027-q029-incoming-verification.md) |
| Implementation | `packages/pipeline/src/fusion/` |
