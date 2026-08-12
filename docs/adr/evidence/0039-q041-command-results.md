# Q041 command results

Environment: Node.js 24, pnpm workspace, macOS arm64.

| Command | Result |
|---|---|
| `pnpm typecheck` | Passed |
| `pnpm --filter @heniek/contracts test` | Passed: 140 tests |
| `pnpm --filter @heniek/pipeline test` | Passed: 291 tests |
| `pnpm --filter @heniek/state test` | Passed: 485 tests, 1 skipped |
| `pnpm --filter @heniek/daemon test` | Passed: 364 tests, 2 skipped |
| `pnpm --filter @heniek/contracts generate:check` | Passed |
| `pnpm --filter @heniek/conformance test -- contracts-compatibility.test.ts` | Passed: 382 tests, 6 skipped |
| `pnpm check` | Passed: 201 test files; 2,377 tests passed, 9 skipped |
