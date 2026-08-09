# Q027 command results

Recorded on Node.js 24.19.0 after implementing durable fixed-stage runners
(ADR 0025), branch `issue-28`.

```text
$ node -v
v24.19.0

$ pnpm --filter @heniek/contracts generate
# ok — manifest 125 → 142 schemas (pure addition)

$ pnpm --filter @heniek/runner test
# ok — approval, integration, verify, publish, agent, command suites

$ pnpm --filter @heniek/state test
# ok — migration 14, operation ledger, runner-store, fixture pins

$ pnpm --filter @heniek/daemon test
# ok — coordinator waiting/reconstruction and compose inbox/answer wiring

$ pnpm --filter @heniek/conformance test contracts-compatibility
# ok — 142 pinned schemas; all Q026 StageRunner/v1 digests unchanged

$ pnpm check
# ok — format, backlog, generate, conformance, typecheck, full suite
# Test Files  156 passed | 3 skipped (159)
# Tests       2100 passed | 9 skipped (2109)
```
