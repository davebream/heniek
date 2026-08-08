# Q020 local command results

- Runtime: Node.js 24.x, pnpm 11.x
- Date: 2026-08-08
- Scope: durable interactions, global actionable inbox, revision-safe answers, and recovery-only resume

| Command | Result |
| --- | --- |
| `pnpm backlog:check` | passed after the authorized GitHub queue-marker reconciliation |
| `pnpm --filter @heniek/contracts generate` | passed; 10 additive schemas generated |
| `pnpm typecheck` | passed |
| `pnpm test` | passed: 120 files passed, 3 skipped; 1,750 tests passed, 9 skipped |
| `pnpm check` | passed: formatting, backlog, generated contracts, conformance generation, typecheck, and full tests |

Focused evidence includes:

- fixed-seed interaction state-machine and replay agreement;
- fresh, v8-upgraded, interrupted/retried, and replayed migration 9 databases;
- answer/answer, answer/cancel, cancel/answer, and resume/resume transaction races;
- crashes before backend delivery and after backend acknowledgement;
- same-run answer continuation with no extra turn and durable resume-key reuse; and
- highest-version RPC negotiation, v1 fallback, unauthorized inbox access, and authenticated answer
  provenance.
