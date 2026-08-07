# Evidence — ADR 0010: Single-repository workspaces and writer leases

## Contract and persistence pins

- The generated contract manifest contains additive v1 schemas for workspace
  configuration, provisioning manifests, synchronization results, and writer
  leases. Existing Run and provider-facing schemas are unchanged.
- Migration 6 has a committed statement hash, per-version structural and
  declared schema fingerprints, and an independently authored terminal schema.
- Replay comparison and projection digests include workspace lifecycle fields
  and retained writer-lease rows.
- `packages/workspace/test/fixtures/workspace-provisioning-manifest.json` pins a
  redacted completed manifest, and
  `packages/workspace/test/fixtures/lease-contention-trace.json` pins fencing
  behavior across blocked acquisition, dead-owner takeover, stale refusal, and
  release.

## Regression evidence

Real-Git tests create temporary bare remotes and exercise verified explicit and
automatic bases, deterministic worktree layout, configured-file copying,
supervised setup, redacted owner-only logs, dirty notification, successful
rebase, safe recreation, replay convergence, and preservation guards.

Lease tests exercise idempotent same-owner acquisition, live-owner blocking,
dead-owner takeover, monotonically increasing fencing revisions, and stale
owner refusal. State tests cover migration lineage fingerprints, transactional
projection writes, append-only replay, divergence reporting, and causal
revision guards.

## Local checks

Validated on 2026-08-06 with Node.js 24.19.0:

```text
pnpm dlx node@24 --version
v24.19.0

pnpm dlx node@24 /opt/homebrew/bin/pnpm check

103 test files: 100 passed, 3 skipped.
1,597 tests: 1,589 passed, 8 skipped.
```

`pnpm check` includes formatting, backlog drift, generated-contract drift,
conformance generation, TypeScript type checking, and the complete Vitest
suite.
