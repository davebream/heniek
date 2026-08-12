# Q046 command results

Recorded on Node.js 24.19.0 and pnpm 11.21.0.

| Command | Result |
|---|---|
| `pnpm typecheck` | Passed across 19 workspace projects |
| `pnpm --filter @heniek/task-source-github test` | Passed: 18 tests, including 7 shared conformance cases |
| Targeted state and compatibility suite | Passed: 69 tests |
| `pnpm check` | Passed: formatting, backlog validation, schema generation, conformance generation, type checking, and the full test suite |
| Full Vitest suite inside `pnpm check` | Passed: 213 test files with 3 skipped; 2,442 tests with 9 skipped |

The first full test run identified the expected additive schema and migration fixture updates plus one
process-signal timing failure. The compatibility fixtures were updated from independently computed schema and
migration fingerprints. The process-signal failure did not recur during the final clean `pnpm check` run.

GitHub required-check and merge confirmation are appended after the non-draft pull request is opened and the
remote result exists.
