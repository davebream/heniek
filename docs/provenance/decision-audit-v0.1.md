# Multi-Engine Coding Workflow Orchestrator
## Decision, Contradiction, and Scope Audit v0.1

**Date:** 30 July 2026  
**Purpose:** Record how the final specification resolves conflicting or evolving statements from the discovery conversation, distinguish v1 from future work, and identify implementation unknowns that are not product-preference questions.

---

## 1. Executive audit verdict

The conversation converged on a coherent product architecture:

- one durable local runtime;
- multiple thin clients;
- configurable provider-neutral profiles and pipelines;
- whole-Codebase reasoning across one or many repositories;
- task-level epic waves;
- logical artifacts decoupled from model sessions;
- managed workspaces and repository-scoped Git delivery;
- Claudexor as a replaceable execution backend;
- confidential-code defaults.

The largest remaining risk is not conceptual contradiction. It is v1 breadth: full epic orchestration, three engines, two operating systems, Claude plugin, CLI, TUI, web dashboard, GitHub delivery, and multi-repository workspaces.

No unresolved product-choice question is currently blocking the architecture. Several technical assumptions require spikes before implementation commitments are trusted.

---

## 2. Resolved contradictions

### 2.1 Personal/local v1 versus Linux VPS

Earlier direction: local-only on one Mac.  
Later requirement: macOS and Linux because autonomous runs also happen on a VPS.

**Resolution:** Each machine is an independent local installation. Linux is controlled through SSH/Termius. No remote-node or cross-machine control plane exists in v1.

### 2.2 Configuration inside repositories versus global application home

Earlier direction included optional repository files.  
The user later required state and configuration to live outside repositories and pointed to CCS's global-home model.

**Resolution:** v1 configuration and runtime state are global. Repository files may be read as native provider instructions, but the product does not require a committed config file. An optional shareable manifest is deferred.

### 2.3 Repository-scoped task versus multi-repository task

An early model made every execution task own one repository.  
Heniek supports product-level designs and plans that span many repositories, and one coherent plan task may modify several.

**Resolution:** Execution tasks may span repositories. Git delivery units remain repository-scoped.

### 2.4 Single issue repository as implementation repository

An early inference treated the issue repository as primary.  
The user clarified that project managers often file issues in the wrong repository.

**Resolution:** The issue repository is provenance and a weak hint. Whole-Codebase analysis determines actual read/write sets and primary repositories.

### 2.5 Selected repositories versus whole Codebase

A question proposed materializing only a selected repository subset.  
The user correctly noted that initial analysis must discover which repositories matter.

**Resolution:** The registered Codebase is the analysis universe. All repositories are semantically available. Physical optimization may not hide repositories from analysis.

### 2.6 Sequential epic versus fully parallel epic

An early simplification proposed only sequential or fully independent parallel epics.  
The user clarified the need for task-level dependency waves.

**Resolution:** General task DAGs are supported. Waves schedule whole tasks. Stage-level epic scheduling is excluded.

### 2.7 Understand as a separate process versus fused stage

The predecessor orchestrator used separate stages, but cold-start cost was a major failure.
The user still values the understanding artifact and its role in epic topology.

**Resolution:** `understand` remains a logical artifact boundary. It may share a model session with design and planning.

### 2.8 One task equals one model session

A persistent task owner improves context economics, but the product's purpose includes using different models for different roles.

**Resolution:** Tasks contain logical stages compiled into execution segments. Adjacent compatible stages may share a session; profile changes and reviews create boundaries.

### 2.9 Predicting context size versus smart continuation

The runtime cannot reliably predict total task context before execution.

**Resolution:** Monitor actual/approximate utilization and create a smart continuation capsule at configurable thresholds.

### 2.10 Cross-provider review as requirement

Cross-provider diversity was initially treated as a likely best practice.  
The user correctly questioned scientific support and one-subscription usability.

**Resolution:** Different-provider review is optional. Capability, fresh context, posture, protocol, and evidence are primary. Same-model fresh review remains valid.

### 2.11 Strict YAML review contracts versus strong prose

Strict serialization was initially suggested for review findings.

**Resolution:** Rich Markdown artifact plus a small schema-validated JSON result envelope. YAML is for human configuration, not model runtime interchange.

### 2.12 One format for everything

JSON, YAML, and TOML were compared.

**Resolution:** YAML for configuration, Markdown for substantive artifacts, JSON for interchange/snapshots, SQLite for operational state. TOML is omitted.

### 2.13 Managed worktree always versus complex repositories

The Conductor model inspired automatic worktrees, but some repositories have setup constraints.

**Resolution:** Workspace is always logical and first-class. `managed-worktree` is default, with `current-checkout`, `existing-checkout`, and `custom` strategies configurable per repository/Codebase/stage/invocation.

### 2.14 One epic PR versus multi-repository delivery

One epic branch/PR is valid only within one repository.

**Resolution:** Every changed repository gets an epic integration branch and final PR. The parent run coordinates them. There is no global Git branch or atomic merge.

### 2.15 Child task PRs

**Resolution:** Internal task branches by default. Child PRs to epic branches are opt-in.

### 2.16 Pipeline topology fixed versus configurable

Several questions about whether plan review or code review is mandatory were incorrectly framed as product-wide choices.

**Resolution:** Pipelines are arbitrary YAML graphs. `fast` and `careful` are bundled examples only.

### 2.17 Permissions versus confidential-code security

The user explicitly said permission policy is not important and YOLO should be default. Later the product was required to default to confidential-code mode.

**Resolution:** Confidential-code mode governs telemetry, storage, and data egress. Agent execution remains non-interactive and broad within isolated workspaces. v1 does not include a fine-grained permissions DSL.

### 2.18 Parent session blocking

Long-running phases must not block or depend on the parent session.

**Resolution:** Daemon-owned external stages return durable handles. Native Claude stages are session-bound and enter `WAITING_FOR_PARENT_SESSION` when necessary.

### 2.19 Delivery watcher in v1

The conversation designed a strong post-PR delivery watcher. Later the explicit v1 success criterion selected the complete feature pipeline ending in a draft PR, not the full delivery lifecycle.

**Resolution:** Draft PR publication is v1. Continuous CI polling, repair runs, review-comment triage, automated replies, and thread resolution are post-v1.

### 2.20 Claudexor as foundation versus replaceable dependency

**Resolution:** Build on Claudexor's execution capabilities through a narrow adapter, but never adopt its run model as the product's pipeline/domain model.

---

## 3. Explicit v1 commitments

The following are binding v1 product commitments because the user explicitly selected them:

- personal-first product, possible OSS later;
- macOS and Linux;
- independent per-machine local operation;
- full epic acceptance, not single-task-only;
- Claude Code, Codex CLI, Cursor CLI;
- named profiles as primitives and pipelines as compositions;
- explicit effort settings;
- native and external Claude modes;
- multiple named accounts selected explicitly;
- configurable direct/parent-mediated questions;
- autonomous and HITL modes;
- declarative graph with parallelism, fan-in, conditions, retries;
- one canonical run state;
- hybrid immutable artifacts plus mutable projection;
- MCP and CLI surfaces over one runtime;
- bounded initial context plus on-demand artifact access;
- replaceable `ExecutionBackend`, Claudexor first;
- configurable workspace strategies;
- one writer per checkout and isolated variants;
- configurable variant integration;
- ad hoc runs attachable to pipelines;
- configurable fresh/resumed retry behavior;
- explicit fallback chains;
- validated one-off graphs;
- controlled profile overrides;
- structured parent-context handoff;
- remote-base workspace creation;
- configurable base synchronization, default notify;
- draft PR default, ready/auto-merge configurable;
- GitHub forge abstraction;
- separate future delivery watcher;
- durable inbox and macOS notifications;
- retention/archive policy;
- Conductor-style setup scripts;
- automatic Codebase/repository detection with one confirmation;
- hybrid instruction discovery;
- precedence plus material-conflict handling;
- native stages waiting for parent;
- layered completion and repair contracts;
- layered execution limits;
- assisted explicit engine management;
- capability catalogue;
- YAML/Markdown configuration source;
- Claude plugin, CLI, TUI, web dashboard;
- Unix socket plus authenticated local HTTP;
- SQLite plus filesystem state;
- exports and backups;
- managed/pinned Claudexor plus external mode;
- account concurrency/queues;
- general `TaskSource` abstraction;
- confidential-code default, configurable;
- TypeScript-first with language-neutral boundaries;
- full epic v1;
- GitHub Projects draft items excluded as source;
- existing branch/PR adoption;
- standalone binaries plus npm;
- task-level waves;
- configurable epic/child PR strategy;
- first-class multi-repository parent runs;
- autonomous graph revision;
- autonomous GitHub issue synchronization;
- configurable external task materialization;
- Codebase-wide initial analysis;
- per-task fast/careful assignment;
- careful critic plus final code review;
- fixed v1 stage-type set.

---

## 4. Inferred decisions made by engineering best practice

These were not direct A/B/C choices but follow strongly from the selected architecture. They should be revisited only if implementation evidence contradicts them.

### 4.1 One final draft PR per changed repository

A multi-repository run cannot produce one GitHub PR. Therefore the final epic output is one PR per changed repository, coordinated by the parent run.

### 4.2 All Codebase repositories visible to analysis

Selecting repositories before analysis would be circular. v1 should expose the full registered Codebase to initial analysis.

### 4.3 Plan review is conditional only in the bundled `careful` template

The runtime does not mandate it. The bundled default adds it for high-risk/multi-task/cross-repository plans.

### 4.4 Review roles are semantically read-only

Even with YOLO execution, a critic/reviewer should not mutate code. The runtime may reject attempts that changed the workspace.

### 4.5 Delivery watcher is deferred

This follows the later explicit v1 success criterion ending at draft PR.

### 4.6 Context thresholds start conservatively

Suggested defaults of 65% soft and 80% hard are working defaults, not scientifically fixed values. They must be tuned with measurements.

### 4.7 Multi-repository integration uses reconciliation, not pseudo-atomicity

No implementation should claim atomic cross-repository merge.

### 4.8 The product daemon talks to Claudexor control API

This is more expressive and deterministic than exposing raw Claudexor MCP tools to the parent.

---

## 5. Scope pressure audit

### 5.1 High-risk v1 breadth

The user explicitly selected:

- full epic orchestration;
- multi-repository composite workspaces;
- three engines;
- macOS and Linux;
- plugin, CLI, TUI, and web dashboard;
- GitHub issue synchronization;
- autonomous task decomposition;
- draft PR publication;
- backup/export;
- smart continuation.

This is a large v1. The implementation must use vertical milestones but must not quietly redefine v1 downward.

### 5.2 Features most likely to delay v1

1. Native Claude stages coordinated with a durable daemon.
2. Reliable interaction/question propagation across three CLIs.
3. Subscription-account isolation and auth-route verification.
4. Multi-repository wave integration and reconciliation.
5. Autonomous GitHub issue mutation with idempotency.
6. Self-contained macOS/Linux packaging.
7. TUI and web dashboard parity.
8. Context-utilization measurement across providers.
9. Claudexor version churn.
10. Cursor session/account semantics.

### 5.3 Features to resist adding

Until the canonical acceptance scenario is reliable, do not add:

- OpenCode;
- Windows;
- remote nodes;
- dynamic third-party stage plugins;
- cloud sync;
- general CI/review delivery watcher;
- large expert rosters;
- stage-level waves;
- more bundled pipeline tiers;
- a public marketplace;
- provider API integrations unrelated to subscription CLIs.

---

## 6. Technical validation spikes

These are implementation unknowns, not user-preference questions.

### Spike A — Claudexor long-run and interaction fidelity

Prove:

- run handle returns immediately;
- 20-minute stage remains alive;
- free-text question becomes durable interaction;
- answer resumes same native provider session;
- completion is retrievable after parent closes.

### Spike B — External Claude subscription profiles

Prove:

- child Claude can run while parent Claude Code is active;
- correct subscription account is selected;
- ambient API keys cannot silently change billing;
- separate profile sessions do not corrupt each other.

Reverify provider policy before public distribution.

### Spike C — Cursor ACP/Claudexor interaction behavior

Prove:

- model selection;
- plan/build mode;
- question propagation;
- cancellation;
- session continuation;
- subscription auth;
- structured changed-file/result output.

### Spike D — Context telemetry

Measure which engines expose:

- current context utilization;
- token usage;
- cache usage;
- native session IDs.

Define conservative estimation fallback.

### Spike E — Composite multi-repository workspaces

Prove:

- ten-repository workspace creation;
- setup script behavior;
- one session searching all repositories;
- task variant creation;
- shared base pinning;
- acceptable disk/time cost.

### Spike F — Multi-repository wave integration

Prove prepare/verify/publish and recovery after one ref update fails.

### Spike G — Native Claude pipeline bridge

Prove:

- daemon advertises pending native stage;
- active plugin dispatches named subagent;
- result and questions enter canonical state;
- stage waits correctly when parent disconnects.

### Spike H — Packaging

Evaluate a self-contained TypeScript distribution approach on macOS and Linux with SQLite, TUI, web assets, and child-process management.

---

## 7. Missing acceptance criteria detected and added

The main specification adds acceptance criteria that were not explicit in the conversation but are necessary to make selected features testable:

- expected-SHA guards during integration;
- reconciliation after partial multi-repository updates;
- idempotency keys for autonomous issue creation;
- artifact-before-state transaction;
- subscription auth-route mismatch failure;
- native stage waiting behavior;
- hidden dependency discovery during a parallel wave;
- malformed result-envelope handling;
- exact run provenance;
- no runtime state in repositories;
- cross-client visibility;
- export/import;
- daemon restart classification;
- profile/account queue behavior.

---

## 8. Open product questions

No major product-choice question currently blocks specification work.

Naming remains intentionally open.

Potential future product decisions, deferred until v1 evidence exists:

- whether remote nodes are valuable;
- whether OpenCode should join the supported engine set;
- whether the delivery watcher belongs in v1.x;
- whether a committed Codebase manifest is useful for teams;
- whether additional bundled pipeline presets are justified;
- whether a public stage-plugin API is needed;
- whether a cloud sync/control plane has product value.

---

## 9. Final audit recommendation

Proceed to architecture and implementation planning under these rules:

1. Treat the product specification as canonical.
2. Treat the predecessor extraction charter as a guard against accidental porting.
3. Build the single-stage kernel first, but keep full epic acceptance as the v1 bar.
4. Complete the technical spikes before committing provider-specific schemas.
5. Keep every provider behind `ExecutionBackend`.
6. Do not add more product questions unless implementation evidence reveals a real, material ambiguity.
