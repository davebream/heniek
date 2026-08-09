# Q028 retry decision trace

Concrete recovery decision traces from `classifyFailure` → `buildFailureSignature`
→ `decideRecovery` (and HITL approve in `tickScheduler`). Coordinates:
`runId=run-q028`, `stageId=verify`, `graphRevision=1`, `generation=1`.
Digests computed from `packages/pipeline/src/recovery/{classify,signature,decide}.ts`.

## A. Autonomous validation `repair_fresh`

Policy: `onValidationFailure.strategy = repair_fresh`. Mode: `autonomous`.
`repairBudget=3`, counters start at `{ repairsUsed: 0, identicalSignatureCount: 0 }`.

### Classified failure

```json
{
  "schemaVersion": 1,
  "category": "validation",
  "classification": "validation_failed",
  "phase": "validate",
  "code": "schema",
  "retryable": true,
  "runnerRetryable": true
}
```

### Signature

```json
{
  "schemaVersion": 1,
  "digest": "b8a343813d77e042212321951a8b2c5b3735d877782c1be2b06f0038f4d5d537",
  "category": "validation",
  "classification": "validation_failed",
  "phase": "validate",
  "code": "schema"
}
```

### Retry directive

```json
{
  "schemaVersion": 1,
  "mode": "fresh",
  "sessionPolicy": "fresh",
  "recoveryContextDigest": "b8a343813d77e042212321951a8b2c5b3735d877782c1be2b06f0038f4d5d537"
}
```

### Recovery decision

```json
{
  "schemaVersion": 1,
  "decisionId": "prd:run-q028:1:verify:1:1:dispatch",
  "runId": "run-q028",
  "stageId": "verify",
  "graphRevision": 1,
  "generation": 1,
  "attemptOrdinal": 1,
  "action": "dispatch",
  "outcome": "repair_fresh",
  "failure": {
    "schemaVersion": 1,
    "category": "validation",
    "classification": "validation_failed",
    "phase": "validate",
    "code": "schema",
    "retryable": true,
    "runnerRetryable": true
  },
  "signature": {
    "schemaVersion": 1,
    "digest": "b8a343813d77e042212321951a8b2c5b3735d877782c1be2b06f0038f4d5d537",
    "category": "validation",
    "classification": "validation_failed",
    "phase": "validate",
    "code": "schema"
  },
  "directive": {
    "schemaVersion": 1,
    "mode": "fresh",
    "sessionPolicy": "fresh",
    "recoveryContextDigest": "b8a343813d77e042212321951a8b2c5b3735d877782c1be2b06f0038f4d5d537"
  },
  "repairsUsed": 1,
  "repairBudget": 3,
  "identicalSignatureCount": 1,
  "recordedAt": "2026-08-09T12:00:00.000Z"
}
```

`decideRecovery` result kind: `retry` / reason `retry_scheduled`. Covered by
`decideRecovery` → `schedules repair_fresh for validation failures` and
scheduler-tick → `schedules validation repair_fresh with a retry directive on the next attempt`.

## B. HITL propose → approve

Transient timeout failure. Mode: `hitl`, `sessionPolicy: "fresh"`.
`repairBudget=3`. Propose does **not** increment `repairsUsed`; approve does.

### Classified failure

```json
{
  "schemaVersion": 1,
  "category": "transient",
  "classification": "timeout",
  "phase": "running",
  "code": "timeout",
  "retryable": true,
  "runnerRetryable": true
}
```

### Signature

```json
{
  "schemaVersion": 1,
  "digest": "3194219f808e002e366265cc2b03d7af7f89e4b646939e426c880ba110997f0a",
  "category": "transient",
  "classification": "timeout",
  "phase": "running",
  "code": "timeout"
}
```

### Step 1 — propose (`decideRecovery`, executionMode `hitl`)

```json
{
  "schemaVersion": 1,
  "decisionId": "prd:run-q028:1:verify:1:1:propose",
  "runId": "run-q028",
  "stageId": "verify",
  "graphRevision": 1,
  "generation": 1,
  "attemptOrdinal": 1,
  "action": "propose",
  "outcome": "repair_fresh",
  "failure": {
    "schemaVersion": 1,
    "category": "transient",
    "classification": "timeout",
    "phase": "running",
    "code": "timeout",
    "retryable": true,
    "runnerRetryable": true
  },
  "signature": {
    "schemaVersion": 1,
    "digest": "3194219f808e002e366265cc2b03d7af7f89e4b646939e426c880ba110997f0a",
    "category": "transient",
    "classification": "timeout",
    "phase": "running",
    "code": "timeout"
  },
  "directive": {
    "schemaVersion": 1,
    "mode": "fresh",
    "sessionPolicy": "fresh",
    "recoveryContextDigest": "3194219f808e002e366265cc2b03d7af7f89e4b646939e426c880ba110997f0a"
  },
  "proposalId": "prp:run-q028:1:verify:1:1",
  "repairsUsed": 0,
  "repairBudget": 3,
  "identicalSignatureCount": 1,
  "recordedAt": "2026-08-09T12:00:00.000Z"
}
```

Pending counters after propose:

```json
{
  "repairsUsed": 0,
  "lastSignatureDigest": "3194219f808e002e366265cc2b03d7af7f89e4b646939e426c880ba110997f0a",
  "identicalSignatureCount": 1,
  "pendingProposalId": "prp:run-q028:1:verify:1:1",
  "pendingDirective": {
    "schemaVersion": 1,
    "mode": "fresh",
    "sessionPolicy": "fresh",
    "recoveryContextDigest": "3194219f808e002e366265cc2b03d7af7f89e4b646939e426c880ba110997f0a"
  }
}
```

### Step 2 — approve (`processRecoveryApproved` on `recovery_approved`)

Approve consumes the pending proposal/directive and increments `repairsUsed`.
Outcome follows directive mode (`fresh` → `repair_fresh`).

```json
{
  "schemaVersion": 1,
  "decisionId": "prd:run-q028:1:verify:1:1:approve",
  "runId": "run-q028",
  "stageId": "verify",
  "graphRevision": 1,
  "generation": 1,
  "attemptOrdinal": 1,
  "action": "approve",
  "outcome": "repair_fresh",
  "directive": {
    "schemaVersion": 1,
    "mode": "fresh",
    "sessionPolicy": "fresh",
    "recoveryContextDigest": "3194219f808e002e366265cc2b03d7af7f89e4b646939e426c880ba110997f0a"
  },
  "proposalId": "prp:run-q028:1:verify:1:1",
  "repairsUsed": 1,
  "repairBudget": 3,
  "identicalSignatureCount": 1,
  "recordedAt": "2026-08-09T12:00:00.000Z"
}
```

Covered by `decideRecovery` → `proposes instead of dispatching in HITL mode`
and scheduler approve path in `packages/pipeline/src/scheduler/tick.ts`
(`processRecoveryApproved`).
