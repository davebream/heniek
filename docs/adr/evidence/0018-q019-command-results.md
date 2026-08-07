# Q019 cross-engine telemetry conformance report

Recorded on 2026-08-07 from branch `issue-20`, based on Q018's merge on remote `main`.

## Dependency and toolchain

| Fact | Result |
| --- | --- |
| Q018 GitHub PR | #102, merged; required `quality` check succeeded |
| Q018 fetched Git history | merge commit `88ac8bc` present on `origin/main` |
| Node.js | `v24.19.0` |
| pnpm | `11.13.0` |
| Baseline `pnpm check` | 116 files passed / 3 skipped; 1,727 tests passed / 9 skipped |

The dependency was confirmed independently through GitHub PR metadata and fetched Git history before
implementation began.

## Focused checks

```text
$ pnpm --filter @heniek/contracts test
Test Files  5 passed (5)
Tests       106 passed (106)

$ pnpm --filter @heniek/telemetry test
Test Files  1 passed (1)
Tests       7 passed (7)

$ pnpm --filter @heniek/execution-claudexor test
Test Files  2 passed (2)
Tests       20 passed (20)

$ pnpm --filter @heniek/conformance test
Test Files  23 passed | 3 skipped (26)
Tests       367 passed | 6 skipped (373)

$ pnpm typecheck
passed
```

These tests cover exact, estimated, missing, malformed, contradictory, overflow, counter-reset,
compaction, and capacity-exhaustion behavior. Contract tests reject provider DTO keys and credential-
shaped fields. The fixture matrix validates all four route shapes against `ExecutionTelemetryV1` and
uses only sanitized session placeholders and non-sensitive evidence references.

## Schema and repository checks

```text
$ pnpm --filter @heniek/contracts generate:check
passed

$ pnpm --filter @heniek/conformance test
Test Files  23 passed | 3 skipped (26)
Tests       367 passed | 6 skipped (373)

$ diff <origin/main manifest hashes> <current manifest hashes excluding Q019 additions>
no output; exit 0

$ pnpm check
format:check         passed (413 files; no fixes)
backlog:check        passed
generate:check       passed
conformance:check    passed
typecheck            passed
Test Files           118 passed | 3 skipped (121)
Tests                1,736 passed | 9 skipped (1,745)
```

Q019 adds three schemas to the generated manifest without changing any of the 63 prior hashes:

| Schema | SHA-256 |
| --- | --- |
| `ExecutionEvent/v3` | `b655478dec94642c6746fc061f475c296a03db91a1065bc7d6c6f174a0cf2d08` |
| `ExecutionResult/v4` | `95fb520c52f22d554a1d05d959297a89555ab08e8abefefe5d600791a587be93` |
| `ExecutionTelemetry/v1` | `ebf92b2b848a42cedb66191b4fe8b00a9aaea6d32182e1409f5f0b8123f0a306` |

## Delivery evidence still pending

The GitHub PR, required-check result, and merge confirmation will be appended after the branch is
published as a non-draft PR with `Closes #20`.
