# Q028 command results

Recorded on Node.js 24.19.0 after implementing deterministic recovery policy
(ADR 0026), branch `issue-29`.

```text
$ node -v
v24.19.0

$ pnpm --filter @heniek/contracts generate
# ok — manifest 142 → 152 schemas (pure addition)

$ pnpm --filter @heniek/pipeline test
# ok — recovery classify/signature/decide/limits, canonical-state,
#      scheduler repair_fresh + unchanged_failure_exhausted

$ pnpm --filter @heniek/runner test
# ok — agent resume vs fresh vs missing prior

$ pnpm --filter @heniek/state test
# ok — migration 15, recovery ledger, fixture pins

$ pnpm --filter @heniek/daemon test
# ok — classified failure observations, V2 tick, HITL approval helper

$ pnpm --filter @heniek/conformance test contracts-compatibility
# ok — 152 pinned schemas; all prior digests unchanged

$ pnpm check
# ok — format, backlog, generate, conformance, typecheck, full suite
# Test Files  163 passed | 3 skipped (166)
# Tests       2145 passed | 9 skipped (2154)
```
