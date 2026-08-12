# Q042 command results

Environment: Node.js 24, pnpm workspace, macOS arm64.

| Command | Result |
|---|---|
| `pnpm typecheck` | Passed |
| `pnpm --filter @heniek/contracts test` | Passed: 142 tests |
| `pnpm --filter @heniek/state test` | Passed: 489 tests, 1 skipped |
| `pnpm --filter @heniek/daemon test` | Passed: 368 tests, 2 skipped |
| `pnpm --filter @heniek/contracts generate:check` | Passed |
| `pnpm exec vitest run packages/conformance/test/contracts-compatibility.test.ts packages/workspace/test/workspace.test.ts` | Passed: 15 tests |
| `pnpm check` | Passed: 204 test files; 2,387 tests passed, 9 skipped |

The pre-change baseline `pnpm check` reached 2,376 passing tests and failed one existing intermittent command
test because its expected `$HOME` stdout was empty. The first final run also exposed the intentionally changed
schema pin list and timed out one unrelated workspace rebase test. After updating the six new compatibility
pins, that workspace test and the compatibility tests passed together, followed by the successful full check
recorded above.
