# Q021 local command results

- Runtime: Node.js `v24.19.0`
- Date: 2026-08-08
- Scope: durable account scheduling, ordered fallbacks, permission narrowing, and migration 10

| Command | Result |
| --- | --- |
| `pnpm --filter @heniek/contracts generate` | passed; additive/versioned schemas generated |
| `pnpm --filter @heniek/contracts generate:check` | passed |
| focused config, scheduler, migration, daemon, workspace, identifier-reader, protocol, CLI, and Claudexor adapter suites | passed |
| `pnpm typecheck` | passed |
| `pnpm check` | passed: 127 test files passed, 3 skipped; 1,801 tests passed, 9 skipped |

The focused migration matrix covers fresh creation, V9 upgrade, active legacy backfill, interrupted
rollback/retry, idempotent replay, and terminal schema equality. Statement hashes for migrations
1–9 and every pre-Q021 contract schema hash remain unchanged; only migration/schema version 10 and
new versioned contracts add pins.

The final `pnpm check` includes formatting, backlog generation, contract generation, conformance
generation, TypeScript checking, and the full monorepo test suite on Node.js 24.
