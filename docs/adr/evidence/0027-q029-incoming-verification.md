# Q029 incoming verification

Verdicts from `verifyIncomingContinuation`
(`packages/pipeline/src/fusion/verify.ts`) against a built capsule for
`run-1` / `seg:1`. Failures block without automatic repository mutation.

## Pass — observed state matches capsule

Dirty files compared as sorted sets; HEAD and artifact/context hashes match;
cheap checks (`git diff --check` class) pass.

```json
{
  "schemaVersion": 1,
  "verificationId": "ver:cc53e51611e4e6637f23322d3e2d4758",
  "capsuleId": "cap:run-1:94d363ef0b5a35c7bce818e14666e372",
  "runId": "run-1",
  "verdict": "pass",
  "blockers": [],
  "observedHeads": [{ "repositoryId": "repo-api", "head": "abc123" }],
  "observedDirtyFiles": ["src/a.ts", "src/b.ts"],
  "recordedAt": "2026-08-09T23:31:00.000Z"
}
```

## Block — stale HEAD

```json
{
  "schemaVersion": 1,
  "verificationId": "ver:cc53e51611e4e6637f23322d3e2d4758",
  "capsuleId": "cap:run-1:94d363ef0b5a35c7bce818e14666e372",
  "runId": "run-1",
  "verdict": "block",
  "blockers": ["stale_head"],
  "observedHeads": [{ "repositoryId": "repo-api", "head": "deadbeef" }],
  "observedDirtyFiles": ["src/a.ts", "src/b.ts"],
  "recordedAt": "2026-08-09T23:31:00.000Z",
  "detail": "blocked:stale_head"
}
```

## Additional blockers (tests)

`packages/pipeline/test/fusion-verify.test.ts` also covers
`dirty_set_mismatch`, `missing_artifact`, `artifact_hash_mismatch`,
`missing_context_file`, `contradictory_completion`, `cheap_check_failed`,
`digest_mismatch`, and `tampered_capsule`.
