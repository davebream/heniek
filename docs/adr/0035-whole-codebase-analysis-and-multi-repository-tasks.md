# 35. Whole-Codebase analysis and multi-repository task bindings

- Status: accepted
- Date: 2026-08-12
- Issue: davebream/heniek#42 (Q037, T2-capability)
- Spec anchors: §4.5 whole-Codebase reasoning, §11.3 repository analysis, §20.3 tasks may span repositories
- Evidence:
  [`evidence/0035-q037-whole-codebase-analysis.json`](evidence/0035-q037-whole-codebase-analysis.json),
  [`evidence/0035-q037-task-workspace-inventory.json`](evidence/0035-q037-task-workspace-inventory.json),
  [`evidence/0035-q037-command-results.md`](evidence/0035-q037-command-results.md)

## Context

Q035 and Q036 establish a ready composite workspace, effective instruction provenance, isolated variants,
and repository-scoped writer leases. They do not define the immutable analysis input used to reason about
the whole registered Codebase or bind a versioned execution task to an exact subset of repositories.

The source issue repository is provenance, not task placement. A task can require a different primary
repository and coordinated writes in several repositories. Allowing the issue repository to select or
limit analysis would violate the product's whole-Codebase boundary.

## Decision

`WholeCodebaseAnalysisPacketV1` is a provider-neutral, metadata-only snapshot. It is created only from a
matching ready composite workspace and resolved Codebase snapshot. It includes every registered
repository, the existing effective-instruction report, the recorded checkout/base SHA, and a lexical Git
tree index. Each repository index is independently capped at 10,000 entries and 1 MiB of encoded metadata;
observed and emitted totals make either truncation mode explicit.

`ExecutionTaskRevisionV1` is immutable and content-addressed. A validator enforces consecutive revisions,
predecessor digests, registered and unique repository sets, write-as-a-subset-of-read access, readable
primary and verification repositories, dependency hygiene, and an explicit rationale for every excluded
repository.

Variant provisioning accepts an optional read set. Omitting it preserves Q036's all-repository behavior;
providing it materializes only declared repositories. A task binding is written once, after every writer
lease matches the repository, expected HEAD, lease ID, and fencing revision. Replaying the binding checks
the current leases again.

Before integration, Heniek inventories committed, staged, unstaged, and untracked paths in every
materialized repository. Changed-path output is bounded to 10,000 entries and 1 MiB per repository. A
mutation in a read-only checkout produces a typed `UNDECLARED_WRITE` result and a
`replanning-required` inventory. The variant remains intact as evidence; expanded access requires a new
task revision, fresh variant, and newly validated writer leases.

## Compatibility and boundaries

Four additive public v1 schemas are registered. Compatibility tests pin every earlier generated schema
byte-for-byte. Existing callers of Q036 variant provisioning remain source-compatible because an omitted
read set still means all repositories.

Q037 does not persist or schedule a task DAG, create epic waves, run combined verification, implement
cleanup/recovery, ingest TaskSource revisions, or synchronize GitHub state. Those remain Q039–Q044 scope.
