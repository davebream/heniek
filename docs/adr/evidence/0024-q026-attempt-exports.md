# Q026 — stage attempt exports

Representative durable exports after a claimed command dispatch finalizes
successfully (from `packages/state/test/pipeline-runner.test.ts`):

```json
{
  "attempt": {
    "schemaVersion": 1,
    "stageType": "command",
    "phase": "succeeded",
    "recovery": "none",
    "outputs": [
      { "schemaVersion": 1, "reference": "artifacts.build", "kind": "value", "value": { "ok": true } }
    ],
    "evidence": [
      { "schemaVersion": 1, "kind": "result_envelope", "satisfied": true }
    ]
  },
  "transitions": [
    { "fromPhase": null, "toPhase": "prepare", "detail": "claim_dispatch" },
    { "fromPhase": "prepare", "toPhase": "finalize", "detail": null },
    { "fromPhase": "finalize", "toPhase": "succeeded", "detail": "finalize" }
  ],
  "validation": {
    "schemaVersion": 1,
    "valid": true,
    "missingWrites": [],
    "missingEvidence": [],
    "envelopeValid": true,
    "exitCodeAlone": false
  }
}
```

Agent runner lifecycle (profile resolution → one `ExecutionBackendV7.start` →
collect/validate/finalize) is covered by `packages/runner/test/agent.test.ts`.
Command argv/cwd/env and process-group cleanup are covered by
`packages/runner/test/command.test.ts`.
