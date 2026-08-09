# Q025 — seeded scheduler replay log

Fake clock epoch: `2026-08-09T12:00:00.000Z`. Run id `run-1`, pipeline `linear`
(`design → build`), `maxRepairAttempts: 1`.

## Sequence

1. `createPipelineSchedule` — both stages `pending`, `schedule_revision = 1`.
2. Tick at `T+0s` — release `design`, persist dispatch intent
   `pi:run-1:1:dispatch:design:1:1`, attempt `pa:run-1:1:design:1:1`,
   `design → queued`. `build` stays `pending`.
3. Record observations `attempt_started` then `attempt_succeeded` for the
   design attempt.
4. Tick at `T+3s` — consume observations, `design → succeeded`, release and
   queue `build` with a new dispatch intent. Schedule revision advances.
5. Close SQLite, reopen the same file, reload projections/decisions/intents.
6. Assert byte-identical JSON for decisions, projections, and outbox rows.
7. Idle tick after reopen — no additional intent for the existing design
   attempt (deterministic ids + uniqueness constraints).

## Concurrent CAS

Two `tickScheduler` calls on identical input produce identical intent ids.
Applying both against `expectedScheduleRevision = 1` yields one `applied` and
one `conflict`; exactly one dispatch intent row remains.

## Duplicate-tick / restart property

Covered by `packages/state/test/pipeline-scheduler.test.ts` and the property
suite in `packages/pipeline/test/scheduler-properties.test.ts` (40 seeded
acyclic graphs, byte-identical plans).
