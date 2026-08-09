# Q023 sanitized plugin-to-daemon bridge sequence trace

This summarizes a real, passing run of
`packages/daemon/test/native-bridge-rpc.test.ts` — a real assembled daemon (`startDaemon`), a real
Unix domain socket, real HMAC-signed JSON-RPC frames, a real git worktree, and a real
content-addressed artifact store. IDs, paths, and timestamps below are synthetic; no filesystem
path, credential, or host-specific value from the actual run is included. The step numbering and
every field name/value shape match the real run exactly.

## Negotiation

| Step | Method | Notable request | Notable response |
| --- | --- | --- | --- |
| 1 | `daemon.hello` | — | `challenge`, `keyId` |
| 2 | `daemon.negotiate` | `requiredMethods`: `stage.start` v3, `parentSession.attach` v1, `parentSession.detach` v1, `nativeStage.poll/question/submit/status` v1, `inbox.list` v1, `run.answer` v2, `run.cancel` v1, `artifact.get` v1 (11 methods, one call) | `compatibility: "compatible"`, 11 negotiated methods, each with its wire method and result-schema digest |

Negotiating all 11 methods in one call, rather than one negotiate per method, is what proves
`dispatch.ts`'s `availableByName` table actually carries every new schema together — a client that
negotiated them one at a time could pass even if only the *last* one it happened to check were
correctly wired.

## First run — question, resume, submit, artifact retrieval

| Step | Method | Notable request | Notable response |
| --- | --- | --- | --- |
| 3 | `stage.start.v3` | `profileId: "opus-native"`, `currentDirectory: <registered codebase root>` | `runId: "run-0001"`, `stageId: "stage-0001"`, `status: "waiting_for_parent_session"`, `executionMode: "native"` |
| 4 | `nativeStage.status.v1` | `runId: "run-0001"` | `status: "waiting_for_parent_session"`, `stageState: "waiting_for_parent"`, `attemptCount: 0` — confirmed **before any parent has attached** |
| 5 | `parentSession.attach.v1` | `currentDirectory` | `sessionId: "session-0001"`, `sessionRevision: 1`, `leaseTtlMs: 90000`, `maxDispatches: 16`, `pollAfterMs: 3000` |
| 6 | `nativeStage.poll.v1` | `sessionId`, `sessionRevision: 1` | `accepted: true`, one claimed dispatch: `dispatchId: "dispatch-0001"`, `attemptOrdinal: 1`, a real `workingDirectory` inside a provisioned managed worktree |
| 7 | `nativeStage.status.v1` | `runId: "run-0001"` | `status: "running"`, `stageState: "dispatched"` — confirms the claim actually moved the run |
| — | *(test writes the declared artifact file into the claimed working directory)* | | |
| 8 | `nativeStage.question.v1` | the claimed dispatch's fencing tuple, one `PendingInteractionV2` (`schemaVersion: 2`, one single-choice question) | `accepted: true`, `status: "waiting_on_user"` |
| 9 | `inbox.list.v1` | — | one item, `runId: "run-0001"`, the raised question, `deliveryState: "not_applicable"` |
| 10 | `run.answer.v2` | `runId: "run-0001"`, the answer submission | `status: "running"`, `deliveryState: "delivered"` |
| 11 | `nativeStage.poll.v1` | same session | `accepted: true`, `resumes`: one entry carrying the delivered answer, keyed by the same dispatch id and a bumped `dispatchRevision` |
| 12 | `nativeStage.submit.v1` | the resumed dispatch's fencing tuple, `submissionId: "submission-0001"`, `outcome: "succeeded"`, `result: {summary, artifactPath}` | `accepted: true`, `idempotentReplay: false`, `status: "succeeded"` |
| 13 | `nativeStage.status.v1` | `runId: "run-0001"` | `status: "succeeded"`, `stageState: "settled"`, one attempt, `status: "succeeded"` |
| 14 | `artifact.get.v1` | `artifactId` (read from the daemon's own state, since native's status result carries no artifact id — see the ADR's "Not covered" section) | the published bytes, byte-length and SHA-256 matching exactly what the test wrote into the worktree |

## Second run — graceful detach, re-attach, cancel

| Step | Method | Notable request | Notable response |
| --- | --- | --- | --- |
| 15 | `stage.start.v3` | a second native profile start | `runId: "run-0002"`, `status: "waiting_for_parent_session"` |
| 16 | `parentSession.attach.v1` | — | `sessionId: "session-0002"` |
| 17 | `nativeStage.poll.v1` | — | one claimed dispatch, `attemptOrdinal: 1` |
| 18 | `parentSession.detach.v1` | the claimed dispatch, `outcome: "not_started"` | `accepted: true`, `released: [{disposition: "redispatchable"}]` |
| 19 | `nativeStage.status.v1` | `runId: "run-0002"` | `status: "waiting_for_parent_session"` — the run genuinely returned to waiting, corroborated (CR8), not merely trusted |
| 20 | `parentSession.attach.v1` | a fresh session, no `previousSessionId` | `sessionId: "session-0003"` |
| 21 | `nativeStage.poll.v1` | — | the same run reclaimed, `attemptOrdinal: 2` — a genuinely new attempt, not a resumed one |
| 22 | `run.cancel.v1` | `runId: "run-0002"` | `status: "cancelled"`, `accepted: true` |

## What this proves that a service-level test cannot

Every method above went through the real JSON-RPC dispatcher, the real HMAC verification path, and
real TypeBox request validation (`Value.Check` against the generated contracts) — not a direct
service call. Two of the defects listed in the ADR's own defect table were only reachable this way:
a `TypeDereferenceError` on the two request schemas carrying a `Type.Ref` field, and a rejected
well-formed request because TypeBox's `Value.Check` does not validate `format: "date-time"` without
an explicit registration. Both are fixed in `packages/daemon/src/runtime/compose.ts` and could not
have been found by calling `createNativeBridgeService` directly, however thoroughly.
