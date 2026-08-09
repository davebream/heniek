# Q030 onboarding evidence

Agent-guided codebase onboarding is covered by
`packages/codebase/test/onboard.test.ts`.

What those tests prove:

- Multi-repository propose → digest → apply is atomic and topology-bound.
- Analyzer drafts are validated; shell-wrapper argv (`bash -c`, `cmd /c`, …) is
  rejected.
- One repair of malformed analyzer output is allowed; a second failure blocks.
- Applied `RepositoryWorkspacePolicy/v1` projects to
  `WorkspaceConfiguration/v2` (structured verify checks) and a v1 setup-only
  projection.
- `resolveVerifyChecksFromPolicy` returns the argv list used by verify stages.

End-to-end wiring (propose/apply → policy verify argv → verify runner) is
exercised in `packages/daemon/test/fast-e2e-scenario.test.ts` with an injected
analyzer and temp directories.
