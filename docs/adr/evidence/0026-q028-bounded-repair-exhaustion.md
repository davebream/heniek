# Q028 bounded-repair exhaustion fixture

Two distinct exhaustion paths share the same effective repair budget (strictest
hard limit). Fixtures use `repairBudget=2` as in
`packages/pipeline/test/scheduler-tick.test.ts`
(`fails with unchanged_failure_exhausted for repeated identical signatures`)
and `packages/pipeline/test/recovery-decide.test.ts`
(`exhausts unchanged identical signatures at the budget`,
`exhausts when repairsUsed reaches the budget`).

Coordinates: `runId=run-q028`, `stageId=verify`, `graphRevision=1`,
`generation=1`. Failure is a retryable transient timeout; signature digest
`3194219f808e002e366265cc2b03d7af7f89e4b646939e426c880ba110997f0a`.

## Case 1 — Unchanged-signature exhaustion

Identical failure evidence appears twice while `identicalSignatureCount`
reaches the budget. Rule in `decideRecovery`:
`identicalSignatureCount >= repairBudget` → reason `unchanged_failure_exhausted`,
outcome `unchanged_exhausted`.

### Failure (both attempts)

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

### Attempt 1 — first identical signature → retry

Inputs: `counters = { repairsUsed: 0, identicalSignatureCount: 0 }`,
`repairBudget = 2`.

```json
{
  "kind": "retry",
  "reason": "retry_scheduled",
  "recoveryDecision": {
    "decisionId": "prd:run-q028:1:verify:1:1:dispatch",
    "action": "dispatch",
    "outcome": "repair_fresh",
    "signature": {
      "digest": "3194219f808e002e366265cc2b03d7af7f89e4b646939e426c880ba110997f0a"
    },
    "repairsUsed": 1,
    "repairBudget": 2,
    "identicalSignatureCount": 1
  },
  "nextCounters": {
    "repairsUsed": 1,
    "lastSignatureDigest": "3194219f808e002e366265cc2b03d7af7f89e4b646939e426c880ba110997f0a",
    "identicalSignatureCount": 1
  }
}
```

### Attempt 2 — same digest again → unchanged exhausted

Inputs: `counters = first.nextCounters`, `attemptOrdinal = 2`,
`repairBudget = 2`. Counter update yields `identicalSignatureCount = 2`.

```json
{
  "kind": "fail",
  "reason": "unchanged_failure_exhausted",
  "recoveryDecision": {
    "decisionId": "prd:run-q028:1:verify:1:2:exhaust",
    "action": "exhaust",
    "outcome": "unchanged_exhausted",
    "signature": {
      "digest": "3194219f808e002e366265cc2b03d7af7f89e4b646939e426c880ba110997f0a"
    },
    "repairsUsed": 1,
    "repairBudget": 2,
    "identicalSignatureCount": 2,
    "detail": "unchanged_failure_exhausted"
  }
}
```

Scheduler-tick assertion: stage ends `failed`, decision reason
`unchanged_failure_exhausted`, recovery outcome `unchanged_exhausted`.

## Case 2 — Repair budget exhaustion

`repairsUsed` already equals the budget before a new repair is scheduled.
Rule: `repairBudget === 0 || repairsUsed >= repairBudget` → reason
`repair_exhausted`, outcome `exhausted`. Checked **before** the unchanged-
signature gate.

### Inputs

```json
{
  "failure": {
    "category": "transient",
    "classification": "timeout",
    "phase": "running",
    "code": "timeout",
    "retryable": true,
    "runnerRetryable": true
  },
  "repairBudget": 2,
  "counters": {
    "repairsUsed": 2,
    "identicalSignatureCount": 0
  },
  "attemptOrdinal": 3
}
```

### Decision

```json
{
  "kind": "fail",
  "reason": "repair_exhausted",
  "recoveryDecision": {
    "decisionId": "prd:run-q028:1:verify:1:3:exhaust",
    "action": "exhaust",
    "outcome": "exhausted",
    "signature": {
      "digest": "3194219f808e002e366265cc2b03d7af7f89e4b646939e426c880ba110997f0a"
    },
    "repairsUsed": 2,
    "repairBudget": 2,
    "identicalSignatureCount": 1,
    "detail": "repair_exhausted"
  }
}
```

Note: signature counters still update (`identicalSignatureCount` becomes `1`
for a new digest sighting), but the repair is refused because the budget is
already spent.
