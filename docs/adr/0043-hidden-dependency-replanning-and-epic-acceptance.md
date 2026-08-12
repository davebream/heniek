# 43. Hidden-dependency replanning and epic acceptance

- Status: accepted
- Date: 2026-08-12
- Issue: davebream/heniek#59 (Q045, T3-acceptance)
- Spec anchors: §13.6 autonomous graph revision, §20.7 hidden dependency discovery, §29 v1 end-to-end acceptance scenario
- Evidence:
  [`evidence/0043-q045-run-export.json`](evidence/0043-q045-run-export.json),
  [`evidence/0043-q045-task-timeline.json`](evidence/0043-q045-task-timeline.json),
  [`evidence/0043-q045-before-after-graph.json`](evidence/0043-q045-before-after-graph.json),
  [`evidence/0043-q045-requirement-traceability.md`](evidence/0043-q045-requirement-traceability.md),
  [`evidence/0043-q045-command-results.md`](evidence/0043-q045-command-results.md)

## Context

An active epic can reveal a dependency that was absent from its accepted task graph. Continuing the affected
task can produce invalid work, but discarding the attempt would also discard useful evidence and make restart
recovery ambiguous. Graph revision already protects started tasks in V1, while durable wave scheduling and
serialized integration already preserve capacity and repository ordering. Hidden-dependency recovery needs to
coordinate those services without weakening their existing invariants.

## Decision

Migration 26 persists an immutable hidden-dependency finding before any cancellation side effect and creates
one causal replanning projection. Its lifecycle is:

```text
quiescing --affected attempts cancelled and predecessor safe--> revising --V2 revision accepted--> resumed
         \--missing child, failed prerequisite, reconciliation, missing evidence, or rejection--> blocked
```

The epic runtime coordinator closes scheduling for an unresolved revision, requests cancellation of only the
affected active attempts, and retains their leases until acknowledgement. Safe siblings remain eligible to
finish and integrate. The stored proposal is submitted only after affected work is quiescent and the newly
declared predecessor has terminal integration evidence.

V2 revision proposals link their `supersede` operations to one persisted finding. They may remove only tasks
cancelled by that finding and must provide an explicit one-to-one replacement. V1 proposals retain the
original rule: every mutation of a started task is rejected. Accepted proposals still revalidate requirement
mappings, dependency topology, repository write conflicts, structural waves, and current worker, account, and
repository capacity.

The active DAG feeds future planning. Superseded task lifecycle rows, attempts, dispatches, artifacts, and
audit events remain queryable as historical evidence. Replacement tasks receive identities derived from the
new graph revision; the cancelled attempt is never resumed as if its graph had not changed.

## Consequences

- Crash/restart can replay both cancellation and revision commit without duplicating durable state.
- Missing evidence, incomplete cancellation, reconciliation, and revision rejection become typed blockers;
  the runtime never invents a continuation.
- Capacity cannot be reused while an affected cancellation is unacknowledged.
- The public change is additive: V1 schemas remain registered and byte-compatible, while V2 graph revision
  records carry the evidence-linked trigger.
- The canonical acceptance run proves T1 integration precedes a valid four-task wave across exactly three
  repositories, including retry, question/resume, serialized integration, and combined verification.

## Boundaries

Affected attempts use cancellation because execution backends do not expose a provider-neutral pause
primitive. Provider payloads remain inside execution-backend adapters. This decision does not add Windmill,
Kombajn, TAKT, or any registered-repository runtime state to Heniek.
