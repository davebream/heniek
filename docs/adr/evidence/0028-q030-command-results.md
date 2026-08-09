# Q030 command results

Recorded on Node.js 24.19.0 after implementing bundled `fast` and onboarding
(ADR 0028), branch `issue-31`.

```text
$ node -v
v24.19.0

$ pnpm --filter @heniek/pipeline generate
# ok — wrote packages/pipeline/src/bundled/manifest.generated.ts
# sourceSha256 89fe1b201d9590376080aac94abc474640c9034a73f1464768e31ad07c4afacb
# normalizedGraphSha256 8650b9e6d60a5cd31b8f261189abaebb2b7948fc1119579dc547e4cc534b469b

$ pnpm --filter @heniek/pipeline test bundled-fast
# ok — Test Files 1 passed; Tests 5 passed

$ pnpm --filter @heniek/codebase test onboard
# ok — Test Files 1 passed; Tests 5 passed

$ pnpm --filter @heniek/runner test
# ok — Test Files 6 passed; Tests 39 passed

$ pnpm --filter @heniek/daemon test fast-e2e-scenario
# ok — Test Files 1 passed; Tests 1 passed

$ pnpm --filter @heniek/conformance test contracts-compatibility
# ok — WorkspaceConfiguration/v2 + onboard schemas; prior digests unchanged

$ pnpm check
# ok — format, backlog, generate, conformance, typecheck, full suite
# Test Files  171 passed | 3 skipped (174)
# Tests       2202 passed | 9 skipped (2211)
```
