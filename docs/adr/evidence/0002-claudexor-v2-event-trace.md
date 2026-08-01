# Evidence — Claudexor `/v2` long-run semantics (ADR 0002)

Redacted by `packages/conformance/src/smoke/claudexor/trace.ts`: engine-controlled
values pass a deny layer before a narrow allowlist, payload keys are allowlisted, and
field names are sanitised as data. `dropped` names the fields withheld — never their
values. No prompt text, model output, credential, or filesystem path appears here.

## Canary results

| canary | outcome | evidence |
| --- | --- | --- |
| parentIndependence(detached) — duration run | supported | stateAtKill=running; launcherAliveAfterKill=false; daemonAliveAfterKill=true; postKillMs=1370779; minimumPostKillMs=1200000; postKillEventCount=350; observationEnded=harness-teardown |
| parentIndependence(detached) — terminal run | degraded | stateAtKill=running; launcherAliveAfterKill=false; daemonAliveAfterKill=true; postKillMs=1027738; minimumPostKillMs=1200000; postKillEventCount=2824; finalState=succeeded; terminalReached=true |
| questionAnswerResume | supported | questionObserved=true; interactionAnswered=true; sameRunContinued=true; reachedTerminal=true; waitedMs=21286 |
| cancellationCleanup | supported | acceptedControlCall=true; finalState=cancelled; survivingDescendantPids=0; settleMs=20155 |
| daemonRestartRecovery | supported | daemonRestarted=true; runStillReadable=true; stateAfterRestart=interrupted; recoveryPartitionReadable=true |

The duration run cleared the 20-minute floor (postKillMs 1370779 = 22.8 min) with the
run still `running` and producing events; observation ended because the harness was torn
down, not because the run stopped. The terminal run is the same canary carried all the way
to `succeeded` (postKillMs 1027738 = 17.1 min, 2824 post-kill events) and is reported
`degraded` only because it settled below the 20-minute floor. Both are shown rather than
just the favourable one.

## Redacted event trace — duration run

Launcher pid 16 SIGKILLed at 06:38:34Z; daemon pid 24 alive throughout. Post-kill frames
include `plan.progress` and `harness.event`, i.e. continued work rather than idling.

**Engine provenance**
- protocol major: `3`
- operations path: `/v2/operations`
- engine version: `3.1.2`
- engine sha: `bb5efee24132aa3d65e417040df201e08da44c8c`
- matches pin: `true`
| # | timestamp | kind | type / label | run | task | pid | payload | dropped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 2026-08-01T06:37:49.419Z | process | launcher | - | - | 16 | - | - |
| 3 | 2026-08-01T06:37:49.420Z | process | daemon | - | - | 24 | - | - |
| 4 | 2026-08-01T06:37:49.227Z | event | run.created | run-87514f5cb5e3 | task-175f22dbb387 | - | mode=agent | payload.prompt |
| 5 | 2026-08-01T06:37:49.239Z | event | task.contract.created | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.task_contract_hash |
| 6 | 2026-08-01T06:37:49.274Z | event | project.git.initialized | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.repo_root, payload.initialized, payload.baseline_committed, payload.gitignore_seeded, payload.head_sha |
| 7 | 2026-08-01T06:38:07.689Z | event | budget.lease.created | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.granted, payload.attempt_id, payload.harness_id |
| 8 | 2026-08-01T06:38:07.696Z | event | harness.started | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.external_context_policy |
| 9 | 2026-08-01T06:38:09.404Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.observed_model, payload.credential_route, payload.payload |
| 10 | 2026-08-01T06:38:34.507Z | process | launcher-killed | - | - | 16 | - | - |
| 11 | 2026-08-01T06:39:03.765Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.payload |
| 12 | 2026-08-01T06:39:04.075Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.payload |
| 13 | 2026-08-01T06:39:04.082Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route |
| 14 | 2026-08-01T06:39:04.590Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool, payload.payload |
| 15 | 2026-08-01T06:39:04.698Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 16 | 2026-08-01T06:39:41.297Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.credential_route, payload.tool, payload.payload |
| 17 | 2026-08-01T06:39:41.313Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 18 | 2026-08-01T06:39:44.174Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool, payload.payload |
| 19 | 2026-08-01T06:39:44.184Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 20 | 2026-08-01T06:39:51.892Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.payload |
| 21 | 2026-08-01T06:39:52.192Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.payload |
| 22 | 2026-08-01T06:39:52.554Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.payload |
| 23 | 2026-08-01T06:39:52.562Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route |
| 24 | 2026-08-01T06:40:15.060Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.credential_route, payload.tool, payload.payload |
| 25 | 2026-08-01T06:40:15.080Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 26 | 2026-08-01T06:40:17.500Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool, payload.payload |
| 27 | 2026-08-01T06:40:17.510Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 28 | 2026-08-01T06:40:35.044Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.credential_route, payload.tool, payload.payload |
| 29 | 2026-08-01T06:40:35.062Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 30 | 2026-08-01T06:40:36.859Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool, payload.payload |
| 31 | 2026-08-01T06:40:36.895Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 32 | 2026-08-01T06:40:43.056Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.credential_route, payload.tool, payload.payload |
| 33 | 2026-08-01T06:40:43.071Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 34 | 2026-08-01T06:40:45.047Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool, payload.payload |
| 35 | 2026-08-01T06:40:45.094Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 36 | 2026-08-01T06:40:48.515Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool, payload.payload |
| 37 | 2026-08-01T06:40:48.524Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 38 | 2026-08-01T06:41:02.629Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.credential_route, payload.tool, payload.payload |
| 39 | 2026-08-01T06:41:02.645Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 40 | 2026-08-01T06:41:11.430Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.payload |
| 41 | 2026-08-01T06:41:11.840Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.payload |
| 42 | 2026-08-01T06:41:11.879Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route |
| 43 | 2026-08-01T06:41:47.710Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.credential_route, payload.tool, payload.payload |
| 44 | 2026-08-01T06:41:47.719Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 45 | 2026-08-01T06:41:50.473Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool, payload.payload |
| 46 | 2026-08-01T06:41:50.481Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 47 | 2026-08-01T06:42:19.953Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.credential_route, payload.tool, payload.payload |
| 48 | 2026-08-01T06:42:19.967Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 49 | 2026-08-01T06:42:22.395Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool, payload.payload |
| 50 | 2026-08-01T06:42:22.417Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 51 | 2026-08-01T06:42:35.724Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.credential_route, payload.tool, payload.payload |
| 52 | 2026-08-01T06:42:35.747Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool |
| 53 | 2026-08-01T06:42:37.397Z | event | harness.event | run-87514f5cb5e3 | task-175f22dbb387 | - | - | payload.harness_id, payload.attempt_id, payload.session_id, payload.ts, payload.type, payload.title, payload.text, payload.credential_route, payload.tool, payload.payload |

_Trace truncated: 367 recorded rows in the full run._

