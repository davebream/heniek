# Q030 fast run export (fake-backend scenario)

Source: `packages/daemon/test/fast-e2e-scenario.test.ts`.

Hermetic multi-module scenario (no daemon socket). It covers:

1. Onboard fixture repository with injected analyzer; apply reviewed policy.
2. Load bundled `fast` with `risk.requiresFreshReview: true`.
3. Drive `tickScheduler` through deliberate → build (fail once) → repair →
   risk-review → verify → publish.
4. First build fails validation for missing `non_empty_diff`; classified failure
   schedules `repair` with `session: resume`.
5. Verify runs argv checks from repository workspace policy (`pnpm check`).
6. Publish creates a PR through `@heniek/conformance` fake forge.
7. Export-shaped summary asserts repair trace + publication result.

## Export shape

```json
{
  "schemaVersion": 1,
  "runId": "run_fast_e2e",
  "pipeline": {
    "id": "fast",
    "version": 1,
    "sourceSha256": "<pinned>",
    "normalizedGraphSha256": "<pinned>"
  },
  "onboarding": {
    "proposalId": "proposal-1",
    "digest": "<sha256>",
    "appliedPolicies": ["repo-fixture"],
    "verifyArgv": [["pnpm", "check"]]
  },
  "risk": { "requiresFreshReview": true },
  "stageTrace": [
    { "stageId": "deliberate", "outcome": "succeeded", "attemptOrdinal": 1 },
    {
      "stageId": "build",
      "outcome": "failed",
      "attemptOrdinal": 1,
      "missingEvidence": ["non_empty_diff"],
      "recovery": {
        "outcome": "repair",
        "action": "dispatch"
      }
    },
    {
      "stageId": "build",
      "outcome": "succeeded",
      "attemptOrdinal": 2,
      "retryDirective": { "mode": "resume", "sessionPolicy": "resume" }
    },
    { "stageId": "risk-review", "outcome": "succeeded", "attemptOrdinal": 1 },
    { "stageId": "verify", "outcome": "succeeded", "attemptOrdinal": 1 },
    { "stageId": "publish", "outcome": "succeeded", "attemptOrdinal": 1 }
  ],
  "publication": {
    "schemaVersion": 1,
    "publicationKey": "pub_fast_e2e",
    "outcome": "created"
  }
}
```

Not covered: full `pipeline-runner-service` / socket compose loop (heavy daemon
integration). The scenario uses the same modules that compose wires —
onboarding APIs, bundled lookup, scheduler, agent/verify/publish runners, and
conformance fake forge.
