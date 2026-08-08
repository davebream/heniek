# 20. Durable account scheduling, fallbacks, and permissions

- Status: accepted
- Date: 2026-08-08
- Issue: davebream/heniek#22 (Q021, T2-capability, milestone M2)
- Spec anchors: §9.6 concurrency and queues, §9.7 execution permissions, §24 limits,
  retries, and safeguards
- Evidence:
  [`evidence/0020-q021-queue-fallback-trace.md`](evidence/0020-q021-queue-fallback-trace.md),
  [`evidence/0020-q021-isolation-report.md`](evidence/0020-q021-isolation-report.md),
  [`evidence/0020-q021-command-results.md`](evidence/0020-q021-command-results.md)

## Context

Q020 made questions and recovery durable, but execution admission still depended on a live daemon
process and one selected backend route. It could not enforce a subscription account's concurrency
limit after restart, represent ordered profile fallbacks, or prove that a fallback received no more
workspace or identifier access than the primary profile allowed.

Scheduling is a local control-plane responsibility. Claudexor remains a pinned execution backend;
Heniek must not ask its account pool to rotate routes or let a model rank candidates. Admission,
fallback order, permission narrowing, and durable evidence therefore belong above the backend
adapter.

## Decisions

### D1 — configuration and contracts evolve additively

`ProfileConfigurationV2` adds account capacity, the `priority-fifo` queue strategy, flat ordered
fallback IDs, capacity policy, and an execution permission envelope. Missing fields normalize to one
concurrent run, `priority-fifo`, no fallbacks, `queue`, read-write workspace access, and no allowed
identifiers. `ResolvedProfileV2` and `ResolvedProfileChainV1` freeze the direct candidate order.
A fallback profile's own chain is never expanded, and invocation overrides apply only to the
primary.

Public execution contracts add typed permissions, failures, attempts, and scheduling decisions,
plus `ExecutionRequestV4`, `ExecutionResultV5`, `stage.start.v2`, `run.status.v3`, and
`run.result.v2`. All earlier generated schemas and hashes remain pinned. Public fields use the
neutral name `identifiers`; values are never contract or durable data.

### D2 — SQLite is the scheduling authority

Migration 10 adds schedules, ordered candidates, queue memberships, account capacity, execution
attempts, five-minute fenced account leases, immutable decisions, and durable capacity approvals.
Active pre-Q021 executions become one-capacity `legacy` attempts and receive conservative lease
provenance. The migration is append-only and has independent fresh, V9-upgrade, active-legacy,
interrupted, replay, statement-hash, and schema-fingerprint witnesses.

Claims run under `BEGIN IMMEDIATE`. A fallback-policy run may wait in several account queues, but a
winning claim deletes every sibling membership before it creates the attempt and lease. Queue heads
are ordered by:

```text
effective = min(9, requested + floor(waitMilliseconds / 60_000))
effective descending → durable enqueue sequence ascending
```

The durable per-account capacity row lets a configuration reduction affect work that was already
queued. A lease lasts five minutes, is renewed no more often than once per minute, and increments a
fencing revision on renewal, restart restoration, expiry, and release. Restart reconciles backend
status and restores non-orphan active attempts before dispatching queued work.

### D3 — capacity policy and execution fallback are separate decisions

`queue` enrolls only the primary account. `fallback` enrolls every compatible direct candidate and
selects the earliest configured candidate that is currently an account-queue head with capacity.
`ask` first tries the primary, then persists a Q020-shaped approval offering wait, each compatible
fallback, or cancellation. Its answer is compare-and-set locally in the same immediate transaction
as the scheduling change and is never delivered to a provider.

An execution fallback begins only after the prior attempt has a terminal result or a confirmed
cancellation. The allowlist is account/profile/model/engine unavailable, provider throttling, and
context-capacity exhaustion. Authentication, permission, invalid request, workspace/artifact,
hard-limit, cancellation, ambiguous, and unknown failures fail closed even if an inconsistent
backend flag claims otherwise. Every candidate is tried at most once and in configured order.

### D4 — every attempt is isolated and keeps the original deadline

Provisioning starts only after an account claim. Every attempt gets a distinct managed worktree and
branch at the run's original full Git SHA. Failed worktrees and attempt rows remain evidence; their
artifacts are never imported. Only the successful attempt's declared artifact is length- and
digest-checked, published, and attached to the stage.

Limits are resolved independently per candidate. The minimum stage, invocation, profile, and
remaining absolute-deadline value wins. The absolute deadline is recomputed immediately before
backend dispatch, so fallback queue time consumes rather than resets it.

### D5 — permissions can only narrow

The primary profile is the run ceiling. Read-only wins over read-write, and each requested
identifier must appear in both the primary and selected candidate allowlists. The backend receives
the effective names-only envelope and a fresh in-memory scoped reader. A denied name is rejected
before the underlying store is touched.

Before dispatch, Heniek resolves the assigned worktree with `realpath`, requires the working
directory to be exactly that canonical path, and rejects traversal, symlink ancestors, and unsafe
artifact paths. Read-only attempts compare pre/post Git HEAD, index tree, tracked diff, and untracked
path/content state. Mutation converts an otherwise terminal result into a fail-closed permission
failure. This is a semantic Git-boundary guarantee, not a claim of an OS sandbox.

### D6 — Claudexor routing is explicit and singular

The adapter remains pinned to Claudexor `v3.1.2` at
`bb5efee24132aa3d65e417040df201e08da44c8c`. Each scheduled request supplies one
`primaryHarness`, the same one-element `eligibleHarnesses` list, and the explicit account/profile
pin when required. Workspace permission maps only to `readonly` or `workspace_write`. Heniek never
requests Claudexor account-pool selection or quota rotation.

This matches the pinned upstream contract: explicit credential-profile selection is strict and the
documented access surface is `readonly|workspace_write`. The upstream sources used for the check
were the tagged [README](https://github.com/razzant/claudexor/blob/v3.1.2/README.md) and
[architecture](https://github.com/razzant/claudexor/blob/v3.1.2/docs/ARCHITECTURE.md), not current
main.

## Consequences and boundaries

- Queue, compatibility, choice, lease, attempt, fallback, and exhaustion facts remain inspectable
  with profile and account provenance.
- A daemon crash cannot silently free capacity for a backend attempt that still exists. Only an
  expired orphan is reclaimable; a live backend attempt restores its fenced lease first.
- Public and durable data can identify an allowed value by name but cannot contain its value.
- Provider environment construction, credential injection, billing-route enforcement, generalized
  redaction, and process-tree cleanup remain Q022.
- The existing V1 RPC surface remains wire-compatible. Migration conservatively classifies active
  V1 executions in a one-capacity primary-only legacy lane; new clients use V2 admission.
