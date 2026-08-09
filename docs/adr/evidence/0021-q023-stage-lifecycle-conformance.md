# Q023 stage lifecycle conformance evidence

`packages/conformance/src/stage-lifecycle/` adds a declarative `STAGE_LIFECYCLE_TRANSITIONS` table
(every `(trigger, from, to)` triple the native bridge's store functions can produce, derived from
`RunStatus`) and a pure `checkStageLifecycleTrace()` that checks a recorded event sequence against
it. It is deliberately **not** a fourth conformance family — the three existing ones are
provider-adapter contracts (`cases/`/`fakes/`/`runner/`); the bridge is not an adapter. It follows
`matrix.ts`'s own shape instead: a pure function over statically-declared data, so it produces no
generated artifact and `conformance:check` is untouched.

## The declared transition table

| Trigger | From | To |
| --- | --- | --- |
| `stage_start_admitted_waiting` | *(new run)* | `waiting_for_parent_session` |
| `stage_start_admitted_dispatched` | *(new run)* | `running` |
| `poll_claim` | `waiting_for_parent_session` | `running` |
| `raise_question` | `running` | `waiting_on_user` |
| `answer_question` | `waiting_on_user` | `running` |
| `submit_succeeded` | `running` | `succeeded` |
| `submit_failed` | `running` | `failed` |
| `graceful_detach_corroborated` | `running` | `waiting_for_parent_session` |
| `expiry_dead_or_unknown` | `running` | `recovery_required` |
| `expiry_alive` | `running` | `running` *(self-loop — CR6: the session is stalled, not expired; nothing else changes)* |
| `resume` | `recovery_required` | `waiting_for_parent_session` |
| `cancel` | `running` / `waiting_on_user` / `waiting_for_parent_session` / `recovery_required` | `cancelled` |

`waiting_for_parent_session` is reachable as a *target* only via three triggers —
`stage_start_admitted_waiting`, `graceful_detach_corroborated`, and `resume` — asserted directly by
a dedicated test in `packages/conformance/test/stage-lifecycle.test.ts`, so a future change that
lets some other trigger reach it fails loudly rather than silently widening the boundary.

## Checked against the real canary transcript

`packages/daemon/test/native-bridge-rpc.test.ts` builds a typed `StageLifecycleEvent[]` from its
own real RPC responses as it runs (not a hand-authored stand-in) and asserts
`checkStageLifecycleTrace(...)` returns `{ok: true, violations: []}` against it before the test
completes. The two runs it drives, restated here as the trigger sequence the checker actually
validated:

**Run 1:** `stage_start_admitted_waiting` → `poll_claim` → `raise_question` → `answer_question` →
`submit_succeeded`.

**Run 2:** `stage_start_admitted_waiting` → `poll_claim` → `graceful_detach_corroborated` →
`poll_claim` → `cancel`.

Both runs' events are concatenated into one flat trace passed to a single `checkStageLifecycleTrace`
call. This is intentional and exercises a real property of the checker: a `from: null` event (the
start of a new run) never has to match the previous event's `to` — it asserts a fresh causal chain
starting, not a continuation. Without that rule, checking more than one run's trace in one call
would falsely fail on the second run's own admission event, which is exactly the bug the checker's
own unit tests caught and fixed during implementation (see the ADR's defect table).

## Store-level cross-check

The transition table's stage-level counterpart (`NativeStageState`, `NativeDispatchState`,
`ParentSessionState` in `packages/contracts/src/native-bridge/state.ts`) is enforced imperatively at
every row in `packages/state/src/native-bridge/store.ts` (`WHERE state = ? AND revision = ?`,
`changes === 1`, one-shot transitions). `STAGE_LIFECYCLE_TRANSITIONS` was built by reading those
call sites directly, not inferred from the plan's prose table alone, and the recovery/resume and
CR6 self-loop paths are each covered by a dedicated `checkStageLifecycleTrace` unit test in addition
to the real canary's own two runs.

## The generalized `waiting_for_parent_session` ownership check

`checkNoExternalMapperOwnsWaitingForParentSession` generalizes
`packages/conformance/test/claudexor-state-map.test.ts`'s existing pin ("the Claudexor mapper never
returns `waiting_for_parent_session`") from one hardcoded assertion into a reusable structural
check: it takes a list of `{mapperName, producedStatuses}` samples and flags any sample whose
output set contains the native-bridge-owned status. `packages/conformance/test/stage-lifecycle.test.ts`
exercises it twice — once against the real Claudexor mapper's full input domain (passes), and once
against an adversarial hypothetical mapper that does emit it (fails), proving the check is not
vacuously true. A future second external mapper is a one-line addition to a sample list, never a
change to the checker.

## Command and result

```sh
pnpm --filter @heniek/conformance test stage-lifecycle
```

9 tests passed. Full-suite confirmation: `pnpm check` (see
[`0021-q023-command-results.md`](0021-q023-command-results.md)) includes this file and passed.
