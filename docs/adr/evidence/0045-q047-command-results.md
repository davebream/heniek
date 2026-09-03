# Q047 command results

Recorded on Node.js 24 and pnpm 11.

| Command | Result |
|---|---|
| `pnpm --filter @heniek/github-client test` | Passed: 3 tests |
| `pnpm --filter @heniek/forge-github test` | Passed: 23 tests, including 18 shared conformance cases |
| `pnpm --filter @heniek/contracts test` | Passed: 150 tests |
| Targeted conformance compatibility, matrix, and fake suite | Passed: 63 tests |
| `pnpm exec vitest run apps/cli/test/cli.test.ts packages/codebase/test/codebase.test.ts packages/daemon/test/native-bridge-rpc.test.ts packages/pipeline/test/properties.test.ts` | Passed: 26 tests in the four baseline timeout-prone files |
| `pnpm exec vitest run packages/workspace/test/workspace.test.ts` | Passed: 13 tests after the same file exceeded the five-second limit only under full-suite load |
| `pnpm exec vitest run packages/runner/test/command.test.ts` | Passed: 9 tests after one uncapped run exposed its existing temporary-log race |
| `pnpm check --maxWorkers=2` | Passed every repository gate: 217 test files passed, 3 skipped; 2,479 tests passed, 9 skipped |

Uncapped `pnpm check` runs reproduced the existing suite-level five-second timeout flakiness described in the
Q047 assumptions. Each timed-out file passed immediately in isolation. Capping Vitest at two workers changed
only test scheduling and produced the required clean full check.

GitHub required-check and merge confirmation are reported after the non-draft pull request is opened and the
remote result exists; a pull request cannot contain evidence of its own eventual merge.
