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

On 2026-08-06, the opt-in suite passed against the prebuilt pinned Claudexor
runtime. The isolated process received only `CLAUDE_CODE_OAUTH_TOKEN`, a fixed
system `PATH`, and Claudexor's explicit absolute Claude-binary locator. Its
`claude auth status --json` attested `oauth_token` with the first-party provider
and no visible API key.

The run exercised a free-text question/answer, closed only Heniek's
database/service mid-run, reconciled the same Claudexor thread, imported and
retrieved `artifacts/q012-real.txt`, and cancelled a second run. No API-key
fallback was supplied or observed. The preflight doctor report records the
earlier, deliberately unconfigured state; the real promotion result is
captured in the accompanying redacted trace and end-to-end export.
