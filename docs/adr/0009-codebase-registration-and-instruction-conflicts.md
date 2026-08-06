# ADR 0009 — Codebase registration and instruction conflicts

## Decision

Heniek models a Codebase as one logical aggregate containing one or more Git
repositories. Detection is read-only and never allocates permanent IDs.
Registration re-runs detection after confirmation, compares a topology hash,
writes one application-home `codebase.yaml` atomically, then commits one
aggregate event to SQLite. A file-first crash is reconciled by replaying the
same registration on retry; a file whose canonical content no longer matches
its embedded hash is never overwritten.

Repository identity uses Git common-directory evidence first and normalized
remote evidence second. A match must be one-to-one across the complete
repository set. Multiple possible Codebases or repositories produce a typed
ambiguity blocker. The topology hash detects changes between preview and
confirmation; it is not an identity key.

Detection resolves an enclosing repository before considering a multi-root.
Only immediate children of a non-repository root are inspected. Real paths
are canonicalized, worktrees sharing a Git common directory are deduplicated,
and every output order is deterministic.

Instruction snapshots preserve source kind, provider, relative location,
scope, precedence, SHA-256 content hash, and line anchors. Repository-visible
sources come from Git's tracked-plus-untracked-nonignored listing. Run
snapshots additionally accept orchestrator, profile/role, and stage sources
from the application home.

Precedence is reported as:

1. shared documentation;
2. provider-native instructions;
3. orchestrator instructions;
4. profile/role instructions;
5. stage instructions.

Deeper repository scope is more specific within the same precedence layer.
Neither precedence nor specificity silently resolves a material
contradiction. The deterministic classifier recognizes keyed requirements,
imperative/modal statements, direct negation, and conservative topic overlap.
Additive diagnostics remain executable; incompatible and indeterminate
diagnostics block execution.

`Run/v1` remains unchanged. `Run/v2` requires an immutable instruction
snapshot, and the execution-readiness guard also rejects legacy run rows with
no snapshot. Every run re-discovers its instruction inputs before the
one-time snapshot event, so registration-time hashes are provenance rather
than an execution cache.

The authenticated local-control surface adds negotiated
`codebase.detect.v1` and `codebase.register.v1`. The CLI adds detection and
registration commands; interactive registration asks once, while JSON and
non-TTY callers must pass `--confirm-registration`.

## Consequences

- Runtime state and registration files remain outside registered repositories.
- Credentials, query strings, and fragments never survive remote normalization.
- Registration may complete with blocked readiness, preserving topology and
  diagnostics without authorizing execution.
- Moving a repository preserves its ID when normalized remote evidence is
  unique.
- ADR 0008's intentionally status-only CLI boundary is superseded for the two
  Codebase operations defined here.
