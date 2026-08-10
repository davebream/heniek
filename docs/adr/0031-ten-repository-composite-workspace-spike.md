# 31. Ten-repository composite workspace spike

- Status: accepted
- Date: 2026-08-10
- Issue: davebream/heniek#35 (Q033, T0-evidence)
- Spec anchors: §11.2 multi-root Codebase, §12.2 managed composite workspace,
  §12.6 provisioning
- Evidence:
  [`evidence/0031-q033-composite-manifest-macos.json`](evidence/0031-q033-composite-manifest-macos.json),
  [`evidence/0031-q033-composite-manifest-linux.json`](evidence/0031-q033-composite-manifest-linux.json),
  [`evidence/0031-q033-failure-traces-macos.json`](evidence/0031-q033-failure-traces-macos.json),
  [`evidence/0031-q033-failure-traces-linux.json`](evidence/0031-q033-failure-traces-linux.json),
  [`evidence/0031-q033-command-results.md`](evidence/0031-q033-command-results.md)

## Context

Heniek's single-repository implementation already uses registered repositories and linked Git
worktrees. Q033 had to establish whether the same ownership boundary remains practical for ten
independent repositories before Q034 defines multi-root configuration and Q035 implements the
production composite provisioner.

The retained spike creates ten independent bare remotes, resolves all ten base SHAs before any
workspace effect, clones one registration per remote, and creates one linked worktree per repository.
It uses only temporary local repositories and synthetic setup commands.

## Decision

### D1 — Keep one non-Git composite root with repository-owned checkouts

The selected layout remains `workspaces/<workspace-id>/checkouts/<repository-name>`. The parent is
not a Git repository. Each child is a worktree owned by exactly one registered repository and pinned
to that repository's independently resolved remote base SHA.

This preserves natural navigation and semantic visibility without inventing a cross-repository Git
identity. A task may read all repositories, while write-set enforcement remains repository-scoped.

### D2 — Prefer registered clones plus linked worktrees over workspace-local full clones

One registered clone per repository owns refs and objects; workspace materialization adds linked
worktrees. The macOS run used about 4.1 MB allocated at peak for ten tiny repositories and returned to
zero sandbox bytes after cleanup. Full clones per workspace would duplicate object databases and make
cleanup own both source registration and task state.

The registration boundary also gives clone failures a precise phase. It does not make the registered
checkout part of the composite workspace or allow workspace state inside a managed repository.

### D3 — Resolve every base pin before provisioning and journal every external effect

The spike records all ten full base SHAs atomically before cloning. Restart observes remote movement
but continues from the recorded commits. Atomic journal revisions bracket clone, worktree, setup, and
cleanup effects. If interruption occurs after `git worktree add` but before the next revision, restart
inspects the checkout and reconciles it only when its HEAD still equals the pin.

Corrupt journals, incompatible intent, and changed partial checkouts fail with typed blockers. No
uncertain effect is silently replayed.

### D4 — Run setup as a bounded dependency graph

Setup runs in deterministic dependency levels with at most three child processes. A failed repository
blocks its dependants while independent repositories continue. Cancellation terminates active process
groups, cancels pending work, and leaves zero tracked children. Setup output is discarded; the retained
trace contains only typed failure metadata.

### D5 — Treat the spike formats as evidence, not public contracts

The fixture configuration, journal, manifest, metrics, and fault vocabulary are private to Q033. They
do not change package exports, generated schemas, SQLite state, RPCs, or compatibility counts. Q034
owns production multi-root configuration/base-pin contracts; Q035 owns production composite setup,
restart, and instruction merging.

## Observations

- All ten repositories were readable from the composite root; `api`, `web`, and `e2e` were the only
  dirty worktrees after the modification phase.
- Cross-repository verification consumed repository markers and setup results from all ten checkouts.
- Clone, setup, disk, cancellation, interruption, corrupt-journal, and incompatible-intent behavior is
  covered by the retained harness and integration suite.
- Disk/interruption restarts retained their original base pins after a remote branch advanced, ran
  setup exactly once per repository, and cleaned every worktree and registration idempotently.

## Consequences

- Ten-repository support remains a v1 commitment; this spike introduces no narrower repository cap.
- Composite provisioning is not production-ready merely because the evidence harness succeeds.
- Q034/Q035 can adopt the selected layout and mechanics while defining durable public/state contracts
  independently.
- macOS and Linux remain required execution platforms for the retained spike.
