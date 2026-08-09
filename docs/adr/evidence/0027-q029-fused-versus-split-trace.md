# Q029 fused-versus-split trace

Concrete fusion decisions from `evaluateFusion` / `evaluateContextPressure`
(`packages/pipeline/src/fusion/{evaluate,pressure}.ts`). Coordinates:
`runId=run-q029`, adjacent agent stages `plan` → `implement`, matching
profile/fingerprint/permissions/workspace/lease, backend continuation enabled.

## A. Fuse (pressure below soft)

Pressure ratio `0.4` (estimated), soft `0.65` / hard `0.80`.

```json
{
  "outcome": "fuse",
  "pressure": {
    "softThreshold": 0.65,
    "hardThreshold": 0.8,
    "confidence": "estimated",
    "ratio": 0.4,
    "action": "continue"
  },
  "decision": {
    "schemaVersion": 1,
    "decisionId": "fuse:run-q029:7ed51e954e7cfd6694857071a3e6a0bb",
    "runId": "run-q029",
    "fromStageId": "plan",
    "toStageId": "implement",
    "outcome": "fuse",
    "pressure": {
      "softThreshold": 0.65,
      "hardThreshold": 0.8,
      "confidence": "estimated",
      "ratio": 0.4
    }
  }
}
```

## B. Split — explicit fresh

Successor `sessionPolicy: "fresh"` forces a new segment even when other gates pass.

```json
{
  "outcome": "split",
  "splitReason": "explicit_fresh",
  "decision": {
    "schemaVersion": 1,
    "decisionId": "fuse:run-q029:7ed51e954e7cfd6694857071a3e6a0bb",
    "runId": "run-q029",
    "fromStageId": "plan",
    "toStageId": "implement",
    "outcome": "split",
    "splitReason": "explicit_fresh"
  }
}
```

## C. Split — soft pressure boundary

Ratio `0.7` at soft `0.65`: finish the current backend turn, then continue in a
fresh segment via capsule (smart continuation), not fuse.

```json
{
  "outcome": "split",
  "splitReason": "pressure_soft_threshold",
  "decision": {
    "schemaVersion": 1,
    "decisionId": "fuse:run-q029:7ed51e954e7cfd6694857071a3e6a0bb",
    "runId": "run-q029",
    "fromStageId": "plan",
    "toStageId": "implement",
    "outcome": "split",
    "splitReason": "pressure_soft_threshold",
    "pressure": {
      "softThreshold": 0.65,
      "hardThreshold": 0.8,
      "confidence": "estimated",
      "ratio": 0.7
    }
  },
  "pressure": {
    "softThreshold": 0.65,
    "hardThreshold": 0.8,
    "confidence": "estimated",
    "ratio": 0.7,
    "action": "soft_boundary",
    "splitReason": "pressure_soft_threshold"
  }
}
```

## Matrix coverage (tests)

`packages/pipeline/test/fusion-evaluate.test.ts` and
`fusion-pressure.test.ts` cover profile/fingerprint/permissions/workspace/lease
mismatch, fresh review, backend capability, delegated/retry-fresh recovery,
branching/non-adjacent/non-agent, and unavailable/soft/hard/exhausted pressure.
