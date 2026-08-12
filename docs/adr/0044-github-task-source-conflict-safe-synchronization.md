# 44. GitHub TaskSource and conflict-safe synchronization

- Status: accepted
- Date: 2026-08-12
- Issue: davebream/heniek#61 (Q046, T2-capability)
- Spec anchors: §13.1 TaskSource abstraction, §13.7 GitHub synchronization, §13.8 external materialization policy
- Evidence:
  [`evidence/0044-q046-task-source-conformance.md`](evidence/0044-q046-task-source-conformance.md),
  [`evidence/0044-q046-requirement-traceability.md`](evidence/0044-q046-requirement-traceability.md),
  [`evidence/0044-q046-synchronization-audit.json`](evidence/0044-q046-synchronization-audit.json),
  [`evidence/0044-q046-command-results.md`](evidence/0044-q046-command-results.md)

## Context

Q039 established immutable source snapshots and accepted task revisions, but it deliberately left provider
fetching and mutation to Q046. A GitHub issue is not one document: its body, comments, hierarchy,
attachments, labels, and state are observed through several paginated resources with independent versions.
Treating only the issue body or its `updated_at` value as the source version would miss contractual input.

GitHub documents conditional requests for safe reads but does not support conditional `PATCH` or `POST`
unless an endpoint explicitly opts in. The issue-update endpoint has no such atomic precondition. A client-side
ETag check followed by a body update therefore has a race in which a human edit can be overwritten.

## Decision

`@heniek/task-source-github` is an anti-corruption adapter over an injected HTTP transport. GitHub DTOs stay
inside the package. The adapter emits `TaskSourceSnapshot/v2`, whose normalized title, state, labels,
comments, attachments, component versions, and hierarchy remain provider-neutral. A composite observed
version hashes every normalized component; root-issue ETags are retained and reused for conditional GETs.

The initial observation creates the accepted revision. A later external observation publishes immutable
artifacts and a pending `TaskSourceUpdateProposal/v1`, while the accepted revision remains unchanged. Managed
Heniek synchronization comments are discoverable for recovery but excluded from the source version, so the
adapter does not react to its own projection.

Outbound synchronization is append-only. An approved graph revision becomes a deterministic issue comment
with a hidden marker derived from the idempotency key and proposal digest. A durable claim is written before
the request. Duplicate calls return the immutable audit; a restart after an uncertain POST lists comments and
adopts the marker. A stale source produces an explicit merge proposal and typed `stale_source` conflict rather
than overwriting title, body, labels, state, or hierarchy.

The default fetch transport sends credentials only to configured API origins. Attachment redirects are
bounded and must remain on allowlisted GitHub attachment hosts. Response sizes, page counts, attachment counts,
and redirects are bounded; rate limits and malformed responses are typed without retaining response bodies.

## Compatibility and boundaries

V1 TaskSource schemas remain unchanged. Four additive schemas are generated: `TaskSourceSnapshot/v2`,
`TaskContext/v2`, `TaskSourceUpdateProposal/v1`, and `TaskSourceSynchronizationAudit/v1`. The base
`TaskSource.load()` contract returns the versioned context union, allowing existing V1 implementations to
remain valid.

Q046 does not create issues, update issue fields, ingest pull requests, create branches or pull requests, or
choose external materialization policy. Generic GitHub mutation primitives remain Q047 scope; modes `none`,
`selected`, and `all` plus bidirectional external identity remain Q048 scope.
