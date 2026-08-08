# Q020 sanitized inbox lifecycle trace

This deterministic trace summarizes the tested state transitions. IDs are synthetic; no provider
payload, credential, filesystem path, or real session identifier is included.

## Answer lifecycle

| Step | Durable event | Interaction | Run revision | Outbox | Inbox |
| --- | --- | --- | ---: | --- | --- |
| Backend question observed | `interaction.created` | `pending`, revision 1 | +1 | none | actionable |
| Authenticated answer accepted | `interaction.answer_accepted` | `answered`, revision 2 | +1 | answer pending | removed |
| Backend acknowledges | no local change yet | `answered`, revision 2 | unchanged | answer pending | removed |
| Delivery committed | `interaction.answer_delivered` | `answered`, revision 3 | +1 | answer delivered | removed |

Acceptance validates full question coverage, answer kind, non-blank free text, valid unique option
labels, run ownership, non-terminal run state, expected interaction revision, and authenticated key
provenance. A second answer at revision 1 loses the compare-and-set race and creates no second answer
or operation.

## Cancellation lifecycle

| Observation | Durable event | Final state | Provenance |
| --- | --- | --- | --- |
| Backend omits a previously pending item | `interaction.cancelled` | revision 2 | `withdrawn` |
| Clock passes the frozen timeout | `interaction.cancelled` | revision 2 | `timed_out` |
| Run becomes succeeded, failed, or cancelled | `interaction.cancelled` | revision 2 | `run_terminal` |
| v8 row was non-pending with no answer | migration journal fact | revision 2 | `migration_unresolved` |

Cancelled interactions remain in `run.status.v2` history and cannot be answered. They are excluded
from `inbox.list.v1`.

## Crash boundaries

```text
before delivery crash:
accepted + pending operation → restart → one backend request → delivered

after acknowledgement crash:
accepted + pending operation + backend effect → restart → retry same operation
answer: natural backend deduplication → one answer effect
resume: same durable turn key → one turn effect
```

The fixed-seed state-machine suite uses seeds `0x200001`, `0x200002`, and `0x200003`. Across each
12-run sequence, revisions stay monotonic and journal replay exactly matches every stored interaction
projection and actionable inbox item.
