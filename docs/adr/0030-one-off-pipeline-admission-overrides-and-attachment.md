# 30. One-off pipeline admission, overrides, and ad-hoc attachment

- Status: accepted
- Date: 2026-08-10
- Issue: davebream/heniek#33 (Q032)
- Spec anchors: §14.1 one-off graphs, §8.2 configuration layers, §16.1 canonical run state
- Evidence:
  [`evidence/0030-q032-effective-graph-snapshot.json`](evidence/0030-q032-effective-graph-snapshot.json),
  [`evidence/0030-q032-attachment-lifecycle-trace.md`](evidence/0030-q032-attachment-lifecycle-trace.md),
  [`evidence/0030-q032-command-results.md`](evidence/0030-q032-command-results.md)

## Context

Q031 completed the careful DAG runtime. Operators still needed a single admission
door for named and one-off graphs, closed invocation overrides with provenance,
and a way to attach a completed ad-hoc stage into a live run without mutating
templates or bypassing canonical state.

## Decision

### D1 — One admission door

Named and one-off definitions enter through the same `PipelineDefinition/v1`
parser, normalizer, and conformance checks. Named resolution precedence is
bundled → global (`config/pipelines`) → codebase copy-on-write override. One-offs
receive a deterministic `oneoff.<content-digest>` id derived from the canonical
graph with `pipelineId` held constant. Caller-asserted “validated” graph JSON is
never accepted.

### D2 — Closed invocation-override contract

Unknown, sensitive, unsupported, or forbidden fields reject admission; nothing is
silently dropped. Pipeline hard limits use existing configuration policy with
strictest-wins. Stage `mode` requires the stage allowlist. Profile-shaped fields
require the intersection of stage and profile `overridable` declarations.

### D3 — Immutable run snapshot

Every admitted run persists `PipelineRunSnapshot/v1` with source kind/identity/
digest, base and effective graphs, resolved profile digests, requested/applied
overrides (redacted), effective limits, and canonical digests.

### D4 — Attachment as graph revision N+1

Ad-hoc attachment imports a succeeded source stage into an active target run as a
new synthetic succeeded stage. It runs under one SQLite write transaction with
optimistic CAS on run, graph, and schedule revisions, quiescence checks, dependant
pending-only guards, artifact alias linkage with source lineage, and an immutable
attachment ledger for identical-retry idempotency. After commit, the normal
scheduler tick releases dependants; attachment never dispatches them directly.

### D5 — Negotiated RPC and PipelineRuntime conformance

`pipeline.validate.v1`, `pipeline.run.v1`, and `pipeline.attach.v1` are additive
negotiated methods. Conformance gains a `PipelineRuntime` subject so named/one-off
admission and attachment behavior are independently testable.

## Consequences

- Bundled templates remain immutable after install.
- Public contracts grow by pure addition (169 → 181 schemas).
- Migration 18 adds snapshot and attachment ledger tables only.
- Promotion of one-off graphs into named templates remains out of scope.
