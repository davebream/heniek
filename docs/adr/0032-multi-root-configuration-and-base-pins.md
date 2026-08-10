# 32. Multi-root configuration and immutable base pins

- Status: accepted
- Date: 2026-08-10
- Issue: davebream/heniek#37 (Q034, T2-capability)
- Spec anchors: §11.2 multi-root Codebase, §12.3 base resolution, §12.4 active-base synchronization

## Context

Registered Codebases already retain stable repository IDs and normalized remote identities, while
the configuration package already resolves Codebase, repository, pipeline, stage/profile, and
invocation layers. Q034 must connect those boundaries without creating the composite checkout owned
by Q035 or changing the existing single-repository workspace contracts.

## Decision

Multi-root workspace configuration is stored under application home as
`codebases/<codebase-id>/workspace.yaml`. Repository IDs are map keys so layered configuration stays
stable when authoring order changes. Every repository selects one closed provisioning variant:
`managed-worktree`, `current-checkout`, `existing-checkout`, or `custom`.

Only `managed-worktree` resolves a remote pin in Q034, following §12.3. Resolution records the
requested and resolved refs, configured remote, normalized credential-free fetch identity, exact
commit, timestamp, and synchronization policy. Every managed repository resolves before a snapshot
is returned; any failure discards the candidate set. A retry never replaces a previously published
snapshot's pins.

Repository matching uses registered IDs first and then verifies the registered path and normalized
remote identity. Missing, moved, ambiguous, unauthorized, unsafe, or credential-bearing inputs return
typed diagnostics attached to the winning configuration source and pointer. Raw Git stderr is not
retained.

## Consequences

- `RegisteredCodebaseV1` and `WorkspaceConfigurationV1/V2` remain byte-compatible.
- Current, existing, and custom strategies are configuration-only until Q035 provisions them.
- No repository receives runtime state and no cross-repository atomicity is claimed.
- The resolved snapshot is safe to pass to task admission because it either contains every required
  managed pin or does not exist.
