# Q033 — Ten-repository composite workspace results

Date: 2026-08-10  
Branch: `issue-35`

## Local macOS evidence

Environment:

- macOS (`darwin`, Apple Silicon arm64)
- Node.js `v24.19.0`
- Git `2.52.0`

Commands:

```bash
pnpm --filter @heniek/workspace test -- q033-composite-spike.test.ts
pnpm --filter @heniek/workspace spike:q033 -- --output /absolute/evidence/directory
pnpm check
```

Observed spike result:

- ten independent remotes, registrations, base SHAs, and linked worktrees;
- ten semantic reads and scoped changes only in `api`, `web`, and `e2e`;
- cross-repository verification passed;
- setup peak: 3 child processes; remaining after every scenario: 0;
- peak sandbox allocation: 4,116,480 bytes; after cleanup: 0 bytes;
- clone/setup/cancel failures recorded; disk/interruption restart retained base pins;
- cleanup completed twice without residue.

Focused integration result: 7 Q033 tests passed.

Full local result:

- `pnpm format:check` — pass;
- backlog, contract, pipeline, and conformance generation checks — pass;
- TypeScript — pass;
- Vitest — 2,245 passed, 9 skipped, 0 failed.

## CI evidence

The first [two-platform evidence run](https://github.com/davebream/heniek/actions/runs/31373624857)
completed both spike jobs successfully and supplied the retained Linux files.

Linux environment and observations:

- Ubuntu (`linux`, x64), Node.js `v24.18.0`, Git `2.54.0`;
- ten semantic reads, three scoped writes, and cross-repository verification passed;
- setup peak: 3 child processes; remaining after every scenario: 0;
- peak sandbox allocation: 6,893,568 bytes; after cleanup: 0 bytes;
- all six retained failure/restart scenarios behaved equivalently to macOS.

The `q033-spike` matrix uploads each platform's raw manifest/failure trace and gates the existing
required `quality` job. The final evidence commit is validated by a second complete matrix before
merge.
