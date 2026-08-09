# Q023 local command results

- Runtime: Node.js `v24.19.0`
- Date: 2026-08-09
- Scope: native Claude bridge contracts, migration 11, store, service, JSON-RPC surface, client
  calls, binding/replay tests, the plugin-to-daemon canary, and the stage lifecycle conformance
  check

| Command | Result |
| --- | --- |
| `pnpm --filter @heniek/contracts generate` | passed; additive/versioned schemas generated |
| `pnpm --filter @heniek/contracts generate:check` | passed |
| `pnpm --filter @heniek/conformance generate:check` | passed — the stage lifecycle module is pure/ungenerated and produced no diff |
| `pnpm typecheck` | passed |
| `pnpm check` | passed: 134 test files passed, 3 skipped (137); 1,876 tests passed, 9 skipped (1,885) |

The focused native-bridge command was:

```sh
pnpm exec vitest run \
  packages/conformance/test/contracts-compatibility.test.ts \
  packages/conformance/test/claudexor-state-map.test.ts \
  packages/conformance/test/stage-lifecycle.test.ts \
  packages/state/test/migration-11-native-bridge.test.ts \
  packages/state/test/native-bridge.test.ts \
  packages/state/test/regressions.test.ts \
  packages/state/test/scheduling.test.ts \
  packages/state/test/complete-stage-derived.test.ts \
  packages/daemon/test/native-bridge-service.test.ts \
  packages/daemon/test/native-bridge-binding.test.ts \
  packages/daemon/test/native-bridge-rpc.test.ts \
  packages/daemon/test/no-ambient-sources.test.ts
```

It passed 12 test files and 109 tests.

`packages/daemon/test/native-bridge-rpc.test.ts` is the plugin-to-daemon canary: a real assembled
daemon (`startDaemon`), a real Unix domain socket, real HMAC-signed frames, driving hello →
negotiate (listing every native-bridge method and schema digest in one call) → `stage.start.v3`
admitting a native stage with nobody attached → `nativeStage.status.v1` confirming
`waiting_for_parent_session` before any attach → attach → poll → a real question/answer round trip
through `inbox.list.v1` and `run.answer.v2` → a second poll delivering the resume → submit →
`artifact.get.v1` reading the published bytes back byte-for-byte → a second block proving graceful
detach → re-attach → cancel. Its sanitized sequence trace is
[`0021-q023-bridge-sequence-trace.md`](0021-q023-bridge-sequence-trace.md). It also builds a typed
lifecycle-event trace from its own real responses and checks it against
`@heniek/conformance`'s declarative transition table — see
[`0021-q023-stage-lifecycle-conformance.md`](0021-q023-stage-lifecycle-conformance.md).

`packages/daemon/test/native-bridge-binding.test.ts` is the service-level companion: the same
rejection surface (not-attached, another session's dispatch invisible and unreachable, idempotent
resubmission publishing exactly one artifact, `dispatch_already_settled`, `idempotency_key_reuse`,
a rebind invalidating the pre-rebind revision, tampered ids leaving stored state byte-identical)
through `createNativeBridgeService` against a real git worktree, plus the CR1 regression through a
real second provisioned workspace.

`packages/state/test/native-bridge.test.ts` (32 tests) is the store-level fencing suite the two
files above build on: the full dispatch lifecycle, every rejection code, and the original CR1
regression under an injected fake clock.

`packages/state/test/migration-11-native-bridge.test.ts` covers fresh creation and upgrade-from-10
witnesses for the six new tables, constraint-by-name.

`packages/daemon/test/no-ambient-sources.test.ts` confirms `native-bridge-service.ts`'s only
ambient sources (`execFile` for `git rev-parse HEAD`, `readFile` for artifact reads) are the exact,
reviewed exemption — no new undocumented ambient dependency entered `src/runtime/**`.

The full `pnpm check` includes formatting, backlog generation, contract generation, conformance
generation, TypeScript checking, and the full monorepo test suite on Node.js 24.
