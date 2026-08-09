# Q025 — local command results

Run from the Q025 branch on predecessor commit `90e472e` (Q024, confirmed
merged on remote `main` as PR #108).

## Environment

```console
$ node --version
v24.19.0

$ pnpm --version
11.13.0
```

## Install

```console
$ corepack enable
$ pnpm install
Done in ~3s using pnpm v11.13.0
```

## Generated contracts

```console
$ pnpm --filter @heniek/contracts generate
$ pnpm --filter @heniek/contracts generate:check
```

Nine new pipeline-runtime schemas added to `packages/contracts/generated/`
(109 → 118). Prior digests unchanged.

## Package suites

```console
$ pnpm --filter @heniek/pipeline test
 Test Files  10 passed (10)
      Tests  169 passed (169)

$ pnpm --filter @heniek/state test
# includes migration-12, pipeline-scheduler CAS/replay, barrel pin
```

## Full gate

```console
$ pnpm check
 Test Files  146 passed | 3 skipped (149)
      Tests  2053 passed | 9 skipped (2062)
```

Node.js 24. Evidence for the state machine and seeded replay log lives
alongside this file.
