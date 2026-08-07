# Heniek

Heniek is a local-first control plane for durable software work performed by
coding-agent CLIs. It models one or more Git repositories as a Codebase, runs
task pipelines through replaceable execution backends, and keeps orchestration
state outside the repositories it manages.

> [!WARNING]
> Heniek is a public alpha under active development. It is open for technical
> observation and early feedback, but it is not a supported release and is not
> ready for production use.

The canonical scope is [Product Specification v0.2](docs/product/product-spec-v0.2.md).
Original specifications and naming records remain under `docs/provenance` and
`docs/product` for auditability.

## Current status

Milestones M0 and M1, covering queue items Q001–Q012, are complete. The Q012
vertical slice is dogfoodable from a source checkout: it can run one external
Claudexor stage end to end and exercise restart and doctor behavior. This is an
engineering checkpoint, not the point at which Heniek is generally usable.

What works today:

- versioned provider-neutral contracts, generated JSON Schemas, and backend
  conformance fixtures;
- layered local configuration, secret-store boundaries, SQLite projections, an
  append-only event journal, and immutable artifacts;
- a single-instance authenticated daemon with Unix-socket JSON-RPC and a
  minimal CLI handshake/status path;
- single-repository Codebase detection, workspace provisioning, base sync, and
  writer leases;
- one replaceable Claudexor `/v2` execution path with restart and diagnostic
  coverage.

What is still missing:

- general engine profiles and multi-engine execution;
- user-selectable and bundled multi-stage pipelines;
- epic planning, multi-repository waves, review loops, and delivery automation;
- the TUI, local dashboard, standalone binaries, and an installation/update
  path;
- the full security, compatibility, and platform acceptance required for v1.

There is no supported package, binary, hosted service, or compatibility promise.
Nothing in this repository is currently published to npm.

## Roadmap thresholds

The complete, strictly ordered backlog is checked in under
`docs/backlog/revision-1`. These are the practical readiness thresholds:

| Threshold | Meaning |
|---|---|
| [Q030](https://github.com/davebream/heniek/issues/31) | A bundled `fast` pipeline provides the first repeatable end-to-end workflow. |
| [Q049](https://github.com/davebream/heniek/issues/65) | Linked single- and multi-repository draft-PR delivery and recovery make Heniek genuinely usable. |
| [Q056](https://github.com/davebream/heniek/issues/72) | Verified macOS/Linux standalone artifacts and an unpublished npm installation/update path make distribution testable. |
| [Q057](https://github.com/davebream/heniek/issues/73) | Security hardening, the compatibility matrix, and full platform acceptance complete the planned v1 engineering scope. |

GitHub issue state and merged-PR evidence are authoritative for implementation
status. The checked-in backlog is generated planning input, so its issue-body
checkboxes and factory labels may not reflect later completion.

## Development

Requirements:

- Node.js 24
- pnpm 11.13 or newer

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` verifies formatting, generated backlog and contract artifacts,
conformance, types, and tests. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
opening an issue or proposing a change.

## Feedback and security

Bug reports and design feedback are welcome through
[GitHub Issues](https://github.com/davebream/heniek/issues/new/choose). During
the alpha, code contributions require a maintainer-approved issue before work
starts; unsolicited feature pull requests may be closed. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the lightweight participation standards.

Do not report vulnerabilities in a public issue. Follow
[SECURITY.md](SECURITY.md) to use GitHub private vulnerability reporting, and
never publish credentials, secrets, or unredacted diagnostic output.

## License and hosted services

The local Heniek product—the daemon, CLI, SDKs, protocols, TUI, and local
dashboard—is licensed under the [MIT License](LICENSE). The package manifests
remain private because this alpha does not authorize npm publication.

A future hosted control plane, hosted GUI, or cloud-only features may be
operated commercially under separate terms. No such service exists today, and
the MIT license is not a v1 release or a promise of one.
