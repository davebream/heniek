# Q031 predecessor extraction record

Reference posture: read-only development evidence. Neither source is a runtime dependency.
The unpublished predecessor checkout was observed at `8ec27c0647a8e6bcdc48974b2ac51c4a96b5c947`;
TAKT is the chartered pin `ee15089b276e9c66c115c7864d64b6c47c986291`.

| Source path | Retained invariant | Heniek contract or behavior | Regression evidence |
|---|---|---|---|
| `plugins/dev/agents/critic.md` | Fresh adversarial critic; CRITICAL/MAJOR/MINOR; claims require source evidence | `ReviewFinding/v1`, fresh `critique`, typed verdict | `structured-report.test.ts`, `bundled-careful.test.ts` |
| `plugins/dev/skills/review-plan/SKILL.md` | Round one reviews fully; later passes verify named prior findings | Stable finding IDs, report lineage, final per-finding verification | `pipeline-findings.test.ts`, careful fake scenario |
| `plugins/dev/agents/review-applier.md` | Evidence reversal excludes disproven findings from repair; scope-changing fixes require verification | rejected + retracted lifecycle; accepted-only repair; final fresh verifier | careful fake scenario seeds both accepted and retracted findings |
| TAKT `src/core/workflow/engine/WorkflowEngine.ts` and `src/core/models/schemas.ts` | Validated YAML workflow, explicit transitions, finite execution | generated `careful.v1`, DAG scheduler, repair budget two | bundle hash and graph snapshot |

## Deliberately rejected complexity

| Rejected concept | Reason |
|---|---|
| Kombajn runtime, prompts, or provider routing | Product contracts must remain provider-neutral and replaceable. |
| TAKT cyclic review/fix engine and loop monitors | Heniek already has a deterministic DAG and bounded recovery policy. |
| Giant reviewer roster or mandatory provider diversity | Fresh posture and evidence are the invariant; provider count is not. |
| Mutable manager ledger, provisional/conflict states, raw transcripts | Immutable reports plus a rebuildable projection provide the required audit trail without storing provider control data. |
