# Q032 — Local check results

Node.js: `v24.19.0`  
Date: 2026-08-10  
Branch: `issue-33`

## Commands

```bash
pnpm check
```

## Result

- `pnpm format:check` — pass
- `pnpm backlog:check` — pass
- `pnpm generate:check` — pass (contracts + pipeline bundles)
- `pnpm conformance:check` — pass (PipelineRuntime matrix)
- `pnpm typecheck` — pass
- `pnpm test` — **2238 passed**, 9 skipped, 0 failed

Focused packages also exercised during implementation:

- `@heniek/pipeline` admission + purity
- `@heniek/state` migration 18, admission store, barrel pin
- `@heniek/daemon` ambient allowlist
- `@heniek/conformance` contracts-compatibility (181 schemas)

## Evidence artifacts

- Effective-graph snapshot: `0030-q032-effective-graph-snapshot.json`
- Attachment lifecycle trace: `0030-q032-attachment-lifecycle-trace.md`
- ADR: `docs/adr/0030-one-off-pipeline-admission-overrides-and-attachment.md`
