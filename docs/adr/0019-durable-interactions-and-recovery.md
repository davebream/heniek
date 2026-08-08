# 19. Durable interactions and recovery-only resume

- Status: accepted
- Date: 2026-08-08
- Issue: davebream/heniek#21 (Q020, T0-evidence, milestone M2)
- Spec anchors: §17 human-in-the-loop interactions, §18.1–18.2 inbox and answer flow,
  §25 durability and recovery
- Evidence: [`evidence/0019-q020-inbox-lifecycle-trace.md`](evidence/0019-q020-inbox-lifecycle-trace.md),
  [`evidence/0019-q020-run-export.json`](evidence/0019-q020-run-export.json),
  [`evidence/0019-q020-command-results.md`](evidence/0019-q020-command-results.md)

## Context

The first Claudexor vertical slice stored the backend's latest pending-question response in a mutable
polling table. A later poll could replace that row, answer acceptance contacted the backend before
the local answer was durable, and callers had no revision with which to reject a stale mutation.
There was also no cross-run actionable inbox. Explicit resume used the backend execution ID alone,
so retrying after a crash could create a second provider turn.

Questions and approvals are run facts, not transient polling responses. A user must be able to read
a question, answer exactly the version they saw, restart Heniek at any delivery boundary, and still
get either one accepted answer or a clear stale/conflict error. Ordinary answers must continue the
existing backend run. Explicit resume remains a separate recovery operation.

## Decisions

### D1 — interactions and answers are immutable facts with revisioned projections

`InteractionV2` contains an explicit purpose, a non-empty question list, lifecycle status, revision,
timestamps, cancellation provenance, and delivery state. Each question is exactly one of free text,
single choice, or multiple choice. `InteractionAnswerV2` is an immutable accepted answer with its
durable operation ID and the authenticated local credential key ID that submitted it.

Migration 9 replaces `execution_interaction` with:

- `interaction_record` for immutable source and canonical question facts;
- `interaction_answer_record` for one immutable answer per run interaction;
- `pending_interaction_projection` for revisioned actionable state; and
- `execution_operation_outbox` for answer and resume delivery.

Database triggers reject updates or deletion of facts and require every projection update to advance
both its revision and journal sequence. The outbox's answer rows have a composite foreign key to the
interaction they deliver.

### D2 — answer acceptance is compare-and-set, then delivery

An answer is accepted only when all of these remain true inside one immediate transaction:

- the run exists, owns the interaction, and is not terminal;
- the interaction is pending at the caller's expected revision;
- every question is answered exactly once with the matching answer kind;
- free text is non-blank and choice labels are unique members of the frozen option set; and
- dispatch supplied an authenticated local credential key ID.

The transaction appends `interaction.answer_accepted`, inserts the immutable answer, advances the
interaction and run revisions, and inserts the pending delivery operation. Only after commit may the
daemon contact Claudexor. Duplicate, stale, wrong-run, cancelled, timed-out, withdrawn, and
post-terminal answers are rejected without changing state.

### D3 — the journal is authoritative and the inbox is a projection

The journal records creation, answer acceptance, cancellation, answer delivery, resume request, and
resume delivery. Interaction replay reconstructs the stored projection and reports any divergence.
Backend polling may discover a new interaction or observe its withdrawal, but it cannot rewrite a
question or answer already recorded.

`inbox.list.v1` reads pending projections across all runs ordered by request time, run ID, and
interaction ID. Each item carries the run revision and interaction revision needed by subsequent
compare-and-set mutations. Answered and cancelled interactions remain in run status history but are
not actionable inbox items.

### D4 — answer and resume have different continuation semantics

An ordinary answer calls Claudexor's natural-idempotency answer route on the same run. It does not
create a thread turn. Heniek refuses a runtime whose operation catalogue does not advertise
`answer = natural` and `thread turn = key_required`.

Explicit resume is legal only while the run is `recovery_required`. It requires the expected run
revision and atomically records `run.resume_requested` plus an outbox operation before delivery. The
Claudexor turn idempotency key is derived from that durable operation ID, so retry after an
acknowledgement-boundary crash reuses the same key.

### D5 — delivery is recoverable at both crash boundaries

The daemon drains pending operations before polling active runs and whenever answer or resume commits.

```text
accept locally → commit fact + operation → call backend → mark delivered → observe run
```

A crash before the backend call leaves one pending operation. A crash after backend acknowledgement
but before the local delivery mark leaves that same operation pending. Restart sends it again: the
answer route deduplicates naturally, while resume reuses its durable turn key. Delivery failures keep
the operation pending with a bounded generic diagnostic; they do not undo the accepted answer.

### D6 — the daemon protocol evolves additively

Q020 adds `inbox.list.v1`, `run.status.v2`, `run.answer.v2`, and `run.resume.v2`. Negotiation selects
the highest mutually supported method version whose result schema hash matches. Existing v1 wire
methods and every pre-Q020 generated schema byte/hash remain unchanged. V1 answer requests adapt to
the canonical compare-and-set path; v1 resume snapshots the current revision but is still restricted
to recovery state.

## Consequences and boundaries

- A question remains inspectable after it is answered, withdrawn, timed out, or cancelled by a
  terminal run.
- Concurrent answer/answer, answer/cancel, and resume/resume attempts have one transaction winner;
  later contenders receive a state or revision conflict.
- Migration preserves the exact v8 question and answer JSON. Answered rows gain
  `legacy-migration` provenance; unresolved non-pending rows without an answer become cancelled with
  `migration_unresolved` provenance.
- The inbox contains actionable questions and approvals only. Notification read/ack/dismiss state,
  delivery channels, and macOS notifications remain Q054.
- There is no automatic or model-authored answer path. Approval-stage execution remains Q027, and
  the complete user-facing CLI remains Q051.
