# 41. Repository epic branches and serialized task integration

- Status: accepted
- Date: 2026-08-12
- Issue: davebream/heniek#55 (Q043, T2-capability)
- Spec anchors: §20.6 wave integration, §21.1 single-repository epic, §21.2 multi-repository epic
- Evidence:
  [`evidence/0041-q043-repository-integration-ledger.json`](evidence/0041-q043-repository-integration-ledger.json),
  [`evidence/0041-q043-expected-sha-verification-trace.json`](evidence/0041-q043-expected-sha-verification-trace.json),
  [`evidence/0041-q043-requirement-traceability.md`](evidence/0041-q043-requirement-traceability.md),
  [`evidence/0041-q043-command-results.md`](evidence/0041-q043-command-results.md)

## Context

Q036 prepares and publishes repository-scoped merge candidates with expected-SHA compare-and-swap.
Q038 supplies combined verification, while Q042 durably runs complete task pipelines and deliberately
leaves successor integration gates pending. Those primitives do not define one canonical epic branch per
repository or a deterministic order when parallel tasks finish in different orders.

## Decision

The repository-to-branch map supplied to composite provisioning is authoritative. Migration 24 records one
causal epic-branch projection per run and repository, a deterministic task-integration ledger, and immutable
expected-SHA and verification traces. Branch replay adopts only the exact recorded local SHA; a remote epic
ref must be absent or equal. Any third value enters reconciliation without overwrite.

Integration order is the durable wave ordinal followed by canonical task order, never completion time. The
first non-terminal ledger entry is the only entry allowed to progress. A successful task inventories its
bound variant, prepares every repository candidate, verifies a temporary combined candidate state, and only
then publishes in repository order through the existing expected-SHA integration boundary. Ledger state,
epic expected SHAs, and task completion/integration/verification gates advance in one SQLite transaction.

Restart adopts immutable prepared candidates, verification reports, and already-installed candidates when
their identities and SHAs match. Conflict, undeclared write, failed verification, stale ref, or partial
multi-repository publication preserves all evidence and stops later integrations. Cross-repository updates
remain explicitly non-atomic.

## Compatibility and boundaries

Three additive V1 contracts are registered: `EpicRepositoryBranch`, `TaskIntegrationLedgerEntry`, and
`TaskIntegrationTrace`. Existing contracts remain byte-identical. The daemon service uses a provider-neutral
driver over the Q036–Q038 workspace operations; provider DTOs do not cross the boundary.

Q043 does not push epic branches, publish final pull requests, synchronize GitHub tasks, or choose a
reconciliation action. Those remain later delivery and reconciliation scope.
