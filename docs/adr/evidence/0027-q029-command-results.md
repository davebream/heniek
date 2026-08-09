# Q029 command results

Recorded on Node.js 24.19.0 after implementing segment fusion and smart
continuation (ADR 0027), branch `issue-30`.

```text
$ node -v
v24.19.0

$ pnpm --filter @heniek/contracts generate
# ok — manifest 152 → 157 schemas (pure addition)

$ pnpm --filter @heniek/pipeline test
# ok — fusion evaluate/pressure/capsule/verify (39 tests)

$ pnpm --filter @heniek/runner test
# ok — agent fuse_resume V2 path + continue_fresh

$ pnpm --filter @heniek/state test
# ok — migration 16, fusion store, fixture pins, barrel surface

$ pnpm --filter @heniek/daemon test
# ok — segment-fusion runtime allowlist, pipeline runner hooks

$ pnpm --filter @heniek/conformance test contracts-compatibility
# ok — 157 pinned schemas; all prior digests unchanged

$ pnpm check
# ok — format, backlog, generate, conformance, typecheck, full suite
# Test Files  168 passed | 3 skipped (171)
# Tests       2189 passed | 9 skipped (2198)
```
