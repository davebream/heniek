# ADR 0010 — Single-repository workspaces and writer leases

## Decision

Heniek provisions one `managed-worktree` checkout for one registered
repository under the application home's
`workspaces/<workspace-id>/checkouts/<repository-name>` layout. Provisioning
resolves and verifies a remote base, acquires a durable writer lease, records
phase intent before each external effect, creates the integration worktree,
copies only configured files, runs optional setup, inspects the checkout, and
commits a versioned manifest.

An `auto` base means the remote symbolic HEAD, then `main`, then `master`.
Heniek explicitly fetches the chosen branch and compares the fetched tracking
SHA with `ls-remote`, retrying three times before reporting
`REMOTE_MOVED_DURING_FETCH`. Integration branches are Git-validated and never
force-moved over an existing branch or worktree during initial provisioning.

Copied paths must be relative regular files. Traversal, symlinks, directories,
changed sources, and conflicting retry targets are rejected. Copied files and
application-home logs are owner-only. Setup runs non-interactively through
`/bin/sh` with a scrubbed environment and stable `HENIEK_*` metadata. The
manifest stores hashes, timing, status, exit code, and a log path; it never
stores command text, output, or environment values. An uncertain setup attempt
requires the caller to choose `retry-setup` or `fail-workspace`.

Synchronization has three exact strategies:

1. `notify` records observed drift and never mutates the checkout;
2. `rebase-before-build` requires a clean checkout, a current lease SHA, and
   the recorded base as an ancestor, and aborts plus verifies restoration on
   conflict;
3. `recreate-before-build` requires a clean checkout whose HEAD equals the
   recorded base, so commits and unclassified changes are never discarded.

Every checkout writer holds a persistent renewable lease keyed by canonical
checkout path. The default TTL is 60 seconds and renewal interval is 20
seconds; configuration requires renewal below half the TTL. Lease events
transactionally acquire, renew, advance expected SHA, enter recovery, and
release with monotonically increasing fencing revisions. Takeover requires
expiry plus positive evidence that every process and process-group witness is
dead under the recorded boot witness. Alive or unknown owners remain blocked.

Setup uses a supervisor handshake: the process group exists first, its witness
is committed through lease renewal, and only then may the first shell
instruction run. Renewal loss terminates the whole process group and marks the
workspace recovery-required. Every Git or filesystem mutation rechecks lease
identity, fence, expected SHA, and observed HEAD immediately beforehand.

Migration 6 extends the workspace projection and adds the retained
`workspace_lease` projection. Released rows remain queryable, while the
append-only journal is the complete history. The daemon composes the service
in-process for Q012 but exposes no workspace RPC or CLI method in Q011.

## Consequences

- Registered repositories contain no Heniek runtime state.
- Setup scripts need not be idempotent; uncertain execution is never retried
  implicitly.
- A stale or unfenced owner cannot mutate a checkout after takeover.
- Rebase/recreate success reruns copy and setup and refreshes the manifest.
- Existing Run schemas and provider-facing contracts remain unchanged.
