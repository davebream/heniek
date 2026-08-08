# Q021 local command results

- Runtime: Node.js `v24.19.0`
- Date: 2026-08-08
- Scope: durable account scheduling, ordered fallbacks, permission narrowing, and migration 10

| Command | Result |
| --- | --- |
| `pnpm --filter @heniek/contracts generate` | passed; additive/versioned schemas generated |
| `pnpm --filter @heniek/contracts generate:check` | passed |
| `pnpm --filter @heniek/conformance generate:check` | passed |
| `pnpm typecheck` | passed |
| `pnpm check` | passed: 127 test files passed, 3 skipped; 1,801 tests passed, 9 skipped |

The focused migration, scheduling, fallback, isolation, contract, CLI, and adapter command was:

```sh
pnpm exec vitest run \
  apps/cli/test/cli.test.ts \
  packages/config/test/profile-chain.test.ts \
  packages/conformance/test/contracts-compatibility.test.ts \
  packages/daemon/test/scheduling-policy.test.ts \
  packages/daemon/test/scheduling-service.test.ts \
  packages/execution-claudexor/test/profile-adapter.test.ts \
  packages/secrets/test/scoped-reader.test.ts \
  packages/state/test/migration-9-interactions.test.ts \
  packages/state/test/migration-10-scheduling.test.ts \
  packages/state/test/scheduling.test.ts \
  packages/workspace/test/safety.test.ts
```

It passed 11 test files and 78 tests.

One preceding `pnpm check` attempt timed out at five seconds in two existing tests:
`apps/cli/test/cli.test.ts` (engine capability rendering) and
`packages/workspace/test/workspace.test.ts` (uncertain setup recovery). The exact isolated rerun was:

```sh
pnpm exec vitest run \
  apps/cli/test/cli.test.ts \
  packages/workspace/test/workspace.test.ts \
  -t "renders the engine capability matrix and stable JSON|requires an explicit recovery decision before retrying uncertain setup"
```

Both tests passed in isolation, and the subsequent complete `pnpm check` passed with the counts
recorded above.

The focused migration matrix covers fresh creation, V9 upgrade, active legacy backfill, interrupted
rollback/retry, idempotent replay, and terminal schema equality. Statement hashes for migrations
1–9 and every pre-Q021 contract schema hash remain unchanged; only migration/schema version 10 and
new versioned contracts add pins.

The final `pnpm check` includes formatting, backlog generation, contract generation, conformance
generation, TypeScript checking, and the full monorepo test suite on Node.js 24.
