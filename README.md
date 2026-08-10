# Heniek

[![quality](https://github.com/davebream/heniek/actions/workflows/quality.yml/badge.svg?branch=main)](https://github.com/davebream/heniek/actions/workflows/quality.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/node-24-brightgreen.svg)](.node-version)

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
`docs/product` for auditability. Explanatory notes on individual design
decisions, written for readers who are not tracking the backlog, live in
[`docs/design-notes`](docs/design-notes).

## How Heniek relates to TAKT and Claudexor

Two open-source tools solve neighboring problems, so it is worth stating the
boundary precisely. Heniek sits one layer above both, and depends on one of them
at runtime.

[TAKT](https://github.com/nrslib/takt) coordinates agent work inside a single
repository. It keeps a first-in-first-out task queue in `.takt/tasks.yaml`,
drains it with a worker pool, runs each task through a declarative YAML state
machine in its own worktree, and can open a draft pull request when a task
finishes.

[Claudexor](https://github.com/razzant/claudexor) executes agent turns against a
single project. It owns the vendor CLI adapters, credential profiles spanning
several subscriptions, quota and cost accounting, best-of-N candidate races, and
arbitration between them.

Heniek treats execution as replaceable and starts at delivery:

- the unit of work is one feature across a **Codebase** of one or many
  repositories, not a task inside one repository;
- execution tasks form a **dependency graph**, and a task becomes eligible only
  once its predecessors have been integrated into the repository integration
  branches and combined verification has passed, not once a worker is free;
- a hidden dependency discovered mid-run **revises the graph**, preserves
  completed safe work, and replans the remainder;
- a **logical stage is not a model session**: adjacent stages on one profile
  fuse into a single live session, and a long stage hands off between sessions
  through a durable continuation capsule that the next session must verify
  against Git before continuing;
- orchestration state lives **outside** the repositories being changed, so work
  survives the parent conversation, the terminal, and a machine restart.

Claudexor is Heniek's first `ExecutionBackend`, reached only through its
versioned `/v2` control API behind an anti-corruption adapter. TAKT is a
development-time design reference and not a dependency. Both relationships are
recorded in the
[development reference charter](docs/reference/development-references.md).

If your work is a stream of independent single-repository tasks, TAKT's queue
already covers it. Heniek is for the case where one feature crosses several
repositories and the order in which its parts land matters.

## Current status

Milestones M0 through M3, covering queue items Q001–Q032, are complete, and M4
is in progress through Q034. The bundled `fast` and `careful` pipelines run end
to end from a source checkout, which is the first repeatable multi-stage
workflow. This is an engineering checkpoint, not the point at which Heniek is
generally usable.

What works today:

- versioned provider-neutral contracts, generated JSON Schemas, and backend
  conformance fixtures;
- layered local configuration, secret-store boundaries, SQLite projections, an
  append-only event journal, and immutable artifacts;
- a single-instance authenticated daemon with Unix-socket JSON-RPC, crash
  recovery, and a CLI handshake/status path;
- named accounts, workers, roles, and profiles, with account queues,
  concurrency limits, fallback chains, and a subscription billing guard;
- Claude Code, Codex CLI, and Cursor CLI execution through profile adapters, a
  native Claude bridge, and a managed Claudexor `/v2` runtime;
- durable interactions with an inbox, answer, and resume across daemon restarts;
- YAML pipeline definitions with diagnostics, deterministic scheduling, the
  fixed stage state machine, bounded repair, segment fusion, and smart
  continuation capsules;
- single-repository Codebase detection, workspace provisioning, base sync, and
  writer leases, plus multi-root Codebase configuration and immutable base pins.

What is still missing:

- composite workspace provisioning, isolated variants, whole-Codebase analysis,
  and combined multi-repository verification;
- epic task hierarchies, DAG validation, parallel task waves, autonomous graph
  revision, integration branches, and reconciliation;
- GitHub task synchronization and linked single- and multi-repository draft-PR
  delivery;
- the Claude MCP/plugin surface, the complete CLI, the TUI, the local dashboard,
  notifications, and retention/export/backup;
- standalone binaries, an installation/update path, and the full security,
  compatibility, and platform acceptance required for v1.

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
