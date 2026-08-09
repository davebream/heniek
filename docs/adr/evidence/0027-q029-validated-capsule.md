# Q029 validated (redacted) continuation capsule

Built via `buildContinuationCapsule` (`packages/pipeline/src/fusion/capsule.ts`).
Session identity redacted for evidence; digest is over the canonical payload
including the redacted field value used at build time
(`session-redacted` → digest below). Narrative truncated fields omit transcripts
and credentials.

```json
{
  "schemaVersion": 1,
  "capsuleId": "cap:run-q029:080c1317760c3ec88433ca5ef3ec9ea4",
  "runId": "run-q029",
  "stageId": "implement",
  "attemptId": "pa:1",
  "segmentId": "pes:run-q029:coder:0",
  "segmentOrdinal": 0,
  "completedPlanItems": ["scaffold fusion evaluator"],
  "activePlanItem": "wire daemon dispatch",
  "remainingPlanItems": ["ADR evidence"],
  "nextAction": "Resume implement stage after soft-threshold capsule handoff",
  "repositoryHeads": [{ "repositoryId": "heniek", "head": "8f31c2a" }],
  "dirtyFiles": ["packages/pipeline/src/fusion/evaluate.ts"],
  "artifactRefs": [
    {
      "artifactId": "art-plan",
      "contentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "name": "stage-result"
    }
  ],
  "contextFileRefs": [
    {
      "path": "docs/brief.md",
      "contentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ],
  "decisionIds": ["D2"],
  "unresolvedQuestionIds": [],
  "riskRefs": ["R-pressure"],
  "outgoingSessionId": "session-[redacted]",
  "narrativeDigest": "c7872acc3899f5b1996467d6c19701c9f89d9aece7d9d28251b6e1600b8f4abd",
  "digest": "ce561f243b8d0281ee7e697d295bc8daf9756923172b8ed5eea2f5b624199cb2",
  "createdAt": "2026-08-09T23:30:00.000Z"
}
```

Bounds exercised in `packages/pipeline/test/fusion-capsule.test.ts`: 32 KiB
narrative truncation with omitted-byte counts, 64-entry reference overflow as
typed blocker, deterministic digest, and tamper detection via
`digestCapsulePayload`.
