# 33. Composite provisioning and effective instruction merge

- Status: accepted
- Date: 2026-08-10
- Issue: davebream/heniek#38 (Q035, T2-capability)
- Spec anchors: §11.4 repository instructions, §12.2 managed composite workspace, §12.6 provisioning
- Evidence:
  [`evidence/0033-q035-composite-manifest.json`](evidence/0033-q035-composite-manifest.json),
  [`evidence/0033-q035-effective-instructions.json`](evidence/0033-q035-effective-instructions.json),
  [`evidence/0033-q035-command-results.md`](evidence/0033-q035-command-results.md)

## Context

Q034 resolves all repository configuration and immutable managed base pins before workspace effects,
but deliberately stops before materialization. The existing workspace service provisions one linked
worktree and cannot represent restart state, dependency-ordered setup, or instruction provenance for
a multi-root Codebase.

## Decision

Composite provisioning is a separate production service. It owns one non-Git workspace root and one
manifest containing every repository's strategy, verified Git common directory, checkout path, base
pin, HEAD, materialization result, and setup result. Custom command text is represented only by a
hash plus bounded execution metadata. The manifest is atomically replaced under the Heniek workspace
directory after every external effect; no runtime file is written into a registered repository.

Managed repositories use linked worktrees below `checkouts/<name>`. Current and existing strategies
retain their verified real paths. A custom provisioner receives a deterministic target through the
scrubbed environment and must materialize a checkout whose Git ownership can be verified.

`CodebaseConfiguration/v2` and `ResolvedCodebaseSnapshot/v2` add a structured setup policy with a
repository dependency list and timeout. V1 setup strings normalize to an empty dependency list and a
15-minute timeout. The scheduler runs deterministic repository-ID levels with at most three active
processes. Failures block dependants while independent repositories continue. Logs are redacted,
mode `0600`, hashed, and capped at 1 MiB; commands and raw output are not persisted.

Effective instructions are filtered to the selected provider, ordered by precedence and scope, and
reported with source locations and hashes. Source text is verified against discovery hashes but is
not stored in the report. Additive guidance remains executable; applicable incompatible or
indeterminate diagnostics block the workspace.

## Recovery and compatibility

Restart reuses only phases whose checkout ownership and HEAD still match the manifest. An uncertain
custom provisioner or setup attempt requires an explicit retry-or-fail decision. Remote movement does
not replace a recorded Q034 base pin.

All pre-Q035 schema files remain byte-identical. Four schemas are added: Codebase configuration V2,
resolved Codebase snapshot V2, composite provisioning manifest V1, and effective instruction report
V1. Existing single-repository service contracts remain unchanged for current callers.

## Consequences

- Composite readiness may be `partial-failure`, instruction-`blocked`, or `recovery-required`; no
  cross-repository atomicity is claimed.
- Setup parallelism is fixed at three for this version.
- Parallel writer variants and expected-SHA integration remain Q036 scope.
- Whole-Codebase task read/write sets remain Q037 scope.
