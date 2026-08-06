# Evidence — ADR 0009: Codebase registration and instruction conflicts

## Contract and fixture pins

- `packages/contracts/generated/manifest.json` contains 33 versioned schemas,
  including Codebase detection/registration, instruction diagnostics/snapshots,
  and `Run/v2`. The compatibility test pins every schema ID and SHA-256 digest.
- `packages/codebase/test/fixtures/registered-codebase.json` is a canonical,
  self-hashed blocked-readiness registration snapshot.
- `packages/codebase/test/fixtures/instruction-conflict-report.json` is a
  self-hashed incompatible-requirement report whose line anchors resolve to
  its two declared instruction sources.

## Regression evidence

The Codebase fixtures exercise enclosing and direct-child repositories,
symlink and worktree deduplication, deterministic input ordering, remote URL
sanitization, default-branch discovery, move-stable IDs, ambiguous evidence,
TOCTOU rejection, file-first retry, and manual-file hash conflicts.

Instruction fixtures exercise every supported repository-native source,
application-home-relative stage sources, precedence and nested scope,
content hashes, additive guidance, keyed mismatches, direct negation,
conservative overlap, and anchored blockers.

State/RPC/CLI fixtures exercise aggregate registration, idempotent retries,
one-time immutable run snapshots, legacy/conflicted run blocking, negotiated
authenticated Codebase RPC, noninteractive confirmation refusal, and the JSON
registration flow after a fresh detection preview.

## Local checks

Validated on 2026-08-06 with Node.js 24.19.0:

```text
pnpm dlx node@24 --version
v24.19.0

pnpm dlx node@24 /opt/homebrew/bin/pnpm check

102 test files: 99 passed, 3 skipped.
1,583 tests: 1,575 passed, 8 skipped.
```

`pnpm check` includes formatting, backlog drift, generated-contract drift,
conformance generation, TypeScript type checking, and the complete Vitest
suite.
