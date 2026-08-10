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

GitHub run links are recorded after the retained Linux artifact is promoted from the two-platform CI
matrix.

## CI evidence

The `q033-spike` matrix runs the same command on `macos-latest` and `ubuntu-latest`, uploads each raw
manifest/failure trace, and gates the existing required `quality` job. Exact run links and the Linux
measurements are added before merge.
