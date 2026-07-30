# Development reference charter

Kombajn and TAKT are complementary development-time references. Neither is a
runtime dependency or authoritative architecture.

| Reference | Pin | Heniek borrows |
|---|---|---|
| Kombajn | `936aaf145c667cf44573584b29f44ba006e5aee7` (plugin `1.327.0`) | Cognitive workflow contracts, evidence discipline, and critic/reviewer/verifier roles |
| TAKT | `ee15089b276e9c66c115c7864d64b6c47c986291` | YAML and state-machine mechanics, sessions, transitions, findings, doctor, and subworkflows |
| Claudexor | `v3.1.2` / `bb5efee24132aa3d65e417040df201e08da44c8c` | Provider processes, accounts, sessions, interactions, and execution through `/v2` |
| Heniek | this repository | Codebases, multi-root workspaces, task waves, integration, and delivery |

The reference pins are evidence baselines. Product contracts remain
provider-neutral, and only a versioned ADR with compatibility tests can change an
accepted implementation default.
