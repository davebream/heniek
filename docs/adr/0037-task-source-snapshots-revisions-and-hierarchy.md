# 37. Task-source snapshots, revisions, and hierarchy

- Status: accepted
- Date: 2026-08-12
- Issue: davebream/heniek#47 (Q039, T1-foundation)
- Spec anchors: §4.10 provenance, §13 task sources and hierarchy, §16 canonical run state
- Evidence:
  [`evidence/0037-q039-task-snapshot-revision-export.json`](evidence/0037-q039-task-snapshot-revision-export.json),
  [`evidence/0037-q039-requirement-traceability.md`](evidence/0037-q039-requirement-traceability.md),
  [`evidence/0037-q039-command-results.md`](evidence/0037-q039-command-results.md)

## Context

The bootstrap `TaskSource` contract returned a flat summary and revision number. It could not retain the
observed source version, prove the exact source bytes, represent attachments, reconstruct accepted changes,
or distinguish a tracker parent from an execution dependency. Q039 is the first M5 foundation and must make
those distinctions durable before graph scheduling is introduced.

## Decision

`TaskSource.load()` now returns a complete `TaskContextV1`: an immutable source snapshot, the active task
revision, and an independent hierarchy projection. This is an intentional pre-release reset of the original
flat `TaskContext/v1`; the private package has no external or persisted consumers, and its only in-repository
consumer was the conformance fake changed in the same commit.

Source bytes and attachments are published to the content-addressed artifact store before SQLite mutation.
SQLite then atomically appends the source snapshot, artifact references, revision, tracker edges, and
execution mappings before advancing the active-revision projection. A crash before the transaction can only
leave a recoverable unreferenced blob; a database failure cannot expose a partial canonical task context.

Task revisions contain the complete normalized document plus a bounded RFC 6902 JSON Patch from their exact
predecessor. Applying the patch must reconstruct the new document byte-for-byte under canonical JSON. The
revision table and predecessor links are immutable; only the projection selecting the active revision is
mutable. Historical reads derive `active` or `superseded` from the chain instead of rewriting revision rows.

Tracker hierarchy uses source-work-item identities. Execution mappings use `ExecutionTaskId`, while execution
dependencies remain solely on `ExecutionTaskRevisionV1.dependencies`. No field can be interpreted as both.

## Compatibility and boundaries

Five supporting v1 schemas are additive: `ParentHandoff`, `TaskSourceSnapshot`, `TaskRevisionDocument`,
`TaskRevision`, and `TaskHierarchy`. `TaskContext/v1` changes in place under the explicitly authorized alpha
break. Generated schemas and the conformance compatibility baseline record the exact change.

The implementation is provider-neutral. It does not fetch GitHub data, mutate issues, schedule a graph,
adopt branches or PRs, or store credentials/transcripts. GitHub synchronization and optimistic concurrency
remain Q046 scope.
