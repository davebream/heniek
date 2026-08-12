# 42. Partial multi-repository reconciliation

- Status: accepted
- Date: 2026-08-12
- Issue: davebream/heniek#57 (Q044, T0-evidence)
- Spec anchors: §21.2 multi-repository epic, §21.7 cross-repository delivery, §34 multi-repository integration cannot be atomic
- Evidence:
  [`evidence/0042-q044-partial-state-traces.json`](evidence/0042-q044-partial-state-traces.json),
  [`evidence/0042-q044-requirement-traceability.md`](evidence/0042-q044-requirement-traceability.md),
  [`evidence/0042-q044-command-results.md`](evidence/0042-q044-command-results.md)

## Context

Q043 persists prepared candidates, verifies their combined state, and publishes repository epic refs in
canonical order with expected-SHA guards. It deliberately stops after a partial update because Git cannot
atomically update refs in separate repositories. Remembering which update was attempted is insufficient:
the process may stop after Git changes a ref but before SQLite records the result.

## Decision

Migration 25 adds one reconciliation projection per task integration and an immutable observation stream.
Every pass observes all affected repositories in canonical order and persists every result, including an
unchanged result seen on a later pass, before choosing an action.

| Observed repository state | Classification | Automatic action |
|---|---|---|
| ref equals persisted expected target | pending | publish the persisted candidate with expected-SHA CAS |
| ref equals persisted candidate | applied | adopt the already-applied candidate |
| candidate evidence is absent | missing evidence | block |
| ref is absent or cannot be read | observation failure | block |
| repository identity changed | identity mismatch | block |
| ref equals any third SHA, including a candidate descendant | external mutation | block |

The service performs no ref mutation until the complete observation set is classified. If every repository
is pending or applied, it publishes only pending repositories, observes the complete set again, and resolves
only when every ref equals its persisted candidate. The ledger, epic-branch projections, task gates, and
terminal reconciliation state then advance in one SQLite transaction.

Interrupted preparation retries from `queued`; interrupted verification retries from `prepared`. Interrupted
or partial publication enters durable reconciliation. Repeated passes are state-idempotent while their
external observations remain append-only audit evidence. Later task ordinals remain gated until resolution.

There is no destructive rollback. An exact candidate may be adopted or safely completed forward. Any other
state is a typed blocker requiring an explicit later decision; ancestry alone is not proof because additional
content was not covered by the combined verification report.

## Compatibility and boundaries

`TaskIntegrationReconciliationV1` and `TaskIntegrationReconciliationObservationV1` are additive public
contracts. All Q043 schemas remain byte-identical. The daemon driver exposes provider-neutral observation
and selected expected-SHA publication; Git details remain in workspace adapters.

This decision covers local epic integration refs. Remote pushes, linked pull requests, and delivery recovery
remain Q049 scope.
