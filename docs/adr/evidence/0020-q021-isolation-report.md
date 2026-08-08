# Q021 isolation and permission report

## Workspace boundary

| Check | Result |
| --- | --- |
| Canonical assigned worktree (`realpath`) | passed |
| Working directory differs from assigned worktree | rejected |
| `..`, absolute, empty-segment, and NUL artifact paths | rejected |
| Existing artifact ancestor is a symlink | rejected before backend dispatch |
| Fallback attempt base | both attempts matched the run's original 40-character HEAD |
| Fallback workspace/branch | distinct managed worktree and attempt branch |

Read-only mutation tests independently change Git HEAD, the index tree, a tracked worktree file, and
an untracked path/content hash. Each change is detected. An unchanged worktree passes. A detected
mutation is stored only as the sanitized typed `permission_denied` failure
`readonly_workspace_mutated`.

## Identifier boundary

The primary and candidate allowlists are intersected with the requested identifiers before state or
workspace mutation. The integration test passes one allowed name to the backend through an
attempt-scoped reader. The reader returns the in-memory `SensitiveValue`; a disallowed name is
rejected before the backing store's `read` method runs.

A dynamically assembled sentinel value is then searched across:

- the durable scheduling status, attempts, and decision projection;
- the SQLite database, WAL/sidecars, workspace logs, and managed worktree files; and
- every checked-in generated contract schema.

The sentinel is absent. Errors use fixed messages and never interpolate the requested name or
underlying value.

## Backend boundary

The Claudexor v3.1.2 adapter test verifies one explicit harness, a one-element eligible-harness
list, one explicit Claude account/profile pin, and `access: readonly`. The outgoing body has neither
an account-pool field nor a quota-rotation field. Read-write maps to `workspace_write`; full access is
never produced by the Q021 adapter.
