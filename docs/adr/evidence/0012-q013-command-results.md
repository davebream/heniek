# Evidence — ADR 0012: Managed Claudexor runtime lifecycle

## Node.js 24 acceptance

Validated on 2026-08-07 with the repository-required Node.js release:

```text
npx --yes --package=node@24 --call 'node --version; pnpm check'
v24.19.0

106 test files passed, 3 skipped.
1,654 tests passed, 9 skipped.
```

`pnpm check` passed formatting, backlog drift, generated-contract drift,
conformance generation, TypeScript type checking, and the complete Vitest
suite. The generated contract manifest contains 54 schemas. Its compatibility
fixture retains every pre-Q013 schema digest and adds the four Q013 V1 schemas.

## Focused lifecycle checks

```text
pnpm exec vitest run packages/runtime-claudexor/test packages/conformance/test/contracts-compatibility.test.ts packages/execution-claudexor/test/backend.test.ts apps/cli/test/cli.test.ts

7 test files passed.
67 tests passed.
```

Coverage includes signature, manifest identity and URL validation; checksum
mismatch; unsafe daemon entry; idempotent and conflicting reinstall;
interrupted extraction; concurrent, malformed, and stale locks; failed promotion;
monotonic upgrades; external canonicalization and mutation; dynamic adapter
handshake identity; missing attestations; binary mutation; and
attestation-backed rollback. Hostile ambient API keys, OAuth tokens, config
homes, XDG homes, and unrelated secrets are excluded from both candidate and
promotion-runner child processes; explicit route values are opt-in and cannot
override the isolated homes. Archive downloads stream with cancellation at the
configured size limit. A 24-case matrix injects failures before every
install and activation write, fsync, extraction/unlink, and rename boundary;
the previously active runtime remains recoverable in every case.

## Real signed bootstrap outside the repository

The following commands ran with `Q013_HOME` set to a fresh directory under the
system temporary root. Outputs were filtered before recording; the temporary
home itself, credentials, and transcripts are absent from this evidence.

```text
HENIEK_HOME="$Q013_HOME" pnpm exec tsx apps/cli/src/bin.ts runtime install claudexor 3.1.2 --json
HENIEK_HOME="$Q013_HOME" pnpm exec tsx apps/cli/src/bin.ts runtime list --json
HENIEK_HOME="$Q013_HOME" pnpm exec tsx apps/cli/src/bin.ts runtime activate claudexor 3.1.2 --json
HENIEK_HOME="$Q013_HOME" pnpm exec tsx apps/cli/src/bin.ts runtime list --json
```

Install and inventory exited 0. The signed upstream identity matched version
`3.1.2`, build `bb5efee24132aa3d65e417040df201e08da44c8c`, archive SHA-256
`28b54f20723b866eefdba1ebcbc4311da5c03f0828e72073947087ba092a6a4e`,
and extracted daemon-entry SHA-256
`009b785070d73b434ef9ff1c8f5b072dc49c70fe7df47c51a578eac75eb4bb5a`.

Activation passed the live identity, protocol-major, and complete operation
catalog probe, then exited 8 with `COMPATIBILITY_BLOCKED` because no complete
local §23.5 promotion runner was configured. The second inventory confirmed
that the release remained installed but inactive (`active: null`,
`previous: null`). No compatibility attestation or activation record was
created from the partial run.

## Publication status and remaining acceptance gate

Pull request #88 is open and must not be merged. The real pinned candidate
still has no successful full §23.5 promotion attestation: this machine has no
configured promotion-runner command or smoke configuration, and the required
Codex broker is unavailable. The PR therefore does not claim to close Q013.
Merge remains contingent on a real pinned-suite run with all required provider
routes, a successful promotion record, and redacted evidence.
