# Development reference charter

The predecessor orchestrator and TAKT are complementary development-time references. Neither is a
runtime dependency or authoritative architecture.

| Reference | Upstream | Pin | Heniek borrows |
|---|---|---|---|
| Predecessor orchestrator | Not published | Internal reference, intentionally unpinned in the public repository | Cognitive workflow contracts, evidence discipline, and critic/reviewer/verifier roles |
| TAKT | [nrslib/takt](https://github.com/nrslib/takt) | `ee15089b276e9c66c115c7864d64b6c47c986291` | YAML and state-machine mechanics, sessions, transitions, findings, doctor, and subworkflows |
| Claudexor | [razzant/claudexor](https://github.com/razzant/claudexor) | `v3.1.2` / `bb5efee24132aa3d65e417040df201e08da44c8c` | Provider processes, accounts, sessions, interactions, and execution through `/v2` |
| Heniek | this repository | this repository | Codebases, multi-root workspaces, task waves, integration, and delivery |

The reference pins are evidence baselines: each records the upstream commit the
borrowed mechanics were actually read at, not the current state of that project.
Do not read a pin as a survey of what the upstream tool can do today. As of
2026-08-12, TAKT `main` (`f074b24`) is 161 commits ahead of the pin above and has
grown team-leader decomposition, callable subworkflows, dynamic parallel
reviewers, command quality gates, a findings contract, and resume/restart
positions; re-pinning requires re-reading the borrowed mechanics at the new
commit, so the baseline stays where the evidence was taken.

Product contracts remain provider-neutral, and only a versioned ADR with
compatibility tests can change an accepted implementation default.

## Glossary

These terms appear across the specification, ADRs, and backlog without further
explanation. None of them is a Heniek runtime dependency.

| Term | What it means |
|---|---|
| **Windmill** | [windmill-labs/windmill](https://github.com/windmill-labs/windmill), an open-source workflow engine. It runs the temporary external automation that builds Heniek. It is factory infrastructure, not part of the product. |
| **TAKT** | [nrslib/takt](https://github.com/nrslib/takt), an open-source YAML-defined agent-coordination CLI. Read as a design reference for state-machine and workflow mechanics. Unrelated to Heniek's own naming — see the [brand-name creation report](../provenance/brand-name-creation-report-v0.1.md) for why `takt` was rejected as a name for this project. |
| **Predecessor orchestrator** | An earlier, unpublished internal automation system. Referenced for its workflow contracts and reviewer roles. Deliberately unpinned here because it is not public. |
| **Factory** | The external tooling that *builds* Heniek, as opposed to the *product* Heniek itself. Factory state, credentials, and configuration deliberately stay outside this repository. See [Product versus factory](../product/product-resolution-v0.2.md#product-versus-factory). |
