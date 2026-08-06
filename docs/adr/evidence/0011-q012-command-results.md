# Evidence — ADR 0011: First Claudexor vertical slice

## Deterministic vertical and fault coverage

The fake V2 backend exercises start, immediate durable handle persistence,
observation, grouped question/answer, resume, cancellation, terminal result,
validated artifact import, retrieval, and lease release. The daemon-restart
case closes only Heniek's database/service, then verifies the same
`thread-q012` handle is observed and backend start remains single-shot.

Fault cases cover a backend dispatch before handle persistence and a crash
after atomic stage completion but before artifact-import bookkeeping. Restart
repairs the partial import, preserves exactly one artifact, finalizes once, and
releases the lease. Adapter cases cover exact `/v2` routes, continuation on the
same thread, malformed payloads, incompatible pins, traversal, hash/size
mismatches, cancellation, and secret-safe error mapping.

## Local checks

Validated on 2026-08-06 with Node.js 24.19.0:

```text
npx --yes --package=node@24 --call 'node --version; pnpm check'
v24.19.0

102 test files passed, 3 skipped.
1,599 tests passed, 9 skipped.
```

`pnpm check` passed formatting, backlog drift, generated-contract drift,
conformance generation, TypeScript type checking, and the complete Vitest
suite. The generated manifest contains 50 compatibility artifacts and the
compatibility suite asserts every pre-Q012 V1 digest remains unchanged.

## Real-Claude promotion gate

The opt-in suite requires both
`HENIEK_CONFORMANCE_SMOKE_CLAUDEXOR_ROOT` (an already-built pinned runtime) and
`CLAUDE_CODE_OAUTH_TOKEN`. Neither variable was present in this session, so the
real question/answer, daemon-restart, artifact, session-continuity, and cancel
test was intentionally skipped.

This is the issue's `SUBSCRIPTION_ROUTE_PROOF_UNAVAILABLE` autonomous stop
condition. No host login was treated as proof, no runtime was installed or
upgraded, and no API-key fallback was attempted. Consequently no PR or GitHub
required-check/merge evidence is claimed in this artifact.

