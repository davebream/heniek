# Multi-Engine Coding Workflow Orchestrator
## Product Specification v0.1

**Working product name:** TBD  
**Status:** Consolidated first specification draft  
**Date:** 30 July 2026  
**Primary user for v1:** A single technical user running local installations  
**Possible later direction:** Public open-source developer tool, only after personal value and differentiation are validated

---

## 1. Executive summary

The product is a local-first, durable control plane for software work performed by coding-agent CLIs. It lets a developer define named, subscription-backed worker profiles and compose them into configurable pipelines that may use Claude Code, Codex CLI, and Cursor CLI in any combination.

A Claude Code session may be the conversational controller, but it is not the runtime. Long-running work is owned by a local daemon, survives the parent conversation closing, records questions and artifacts durably, and can also be controlled through a CLI, an operational TUI, and a local web dashboard.

The product treats one or more Git repositories as a logical **Codebase**. A Codebase may be a single repository or a multi-root directory containing many independent repositories. A run creates a logical **Workspace**. In the default managed mode, the workspace is materialized from freshly fetched, configured remote base branches and contains one Git worktree per participating repository. The composite workspace root is not itself a Git repository.

The product performs understanding, design, and planning at the product-feature level, across the whole Codebase. It does not require separate plans merely because a feature spans repositories. Implementation is decomposed into execution tasks. Tasks may themselves span multiple repositories. Epic scheduling uses a dependency DAG at **whole-task granularity**: a task runs its internal mini-pipeline as one schedulable unit, and independent tasks run in parallel waves.

Logical stages and model sessions are deliberately separate concepts. Understanding, design, planning, building, and verification remain durable artifact boundaries, but compatible adjacent stages may execute in one persistent model session to avoid cold starts and repeated context loading. When a session approaches a configurable context threshold, it creates a smart continuation capsule and hands the task to a fresh session.

The v1 success condition is a complete, full-epic workflow:

```text
source issue or task context
→ multi-repository analysis
→ task-graph revision and wave computation
→ configurable multi-model task pipelines
→ implementation and verification
→ repository-scoped integration branches
→ linked draft pull requests
```

The implementation is TypeScript-first, supports macOS and Linux, and exposes language-neutral boundaries so its core may later be reimplemented without changing pipeline definitions or client protocols.

---

## 2. Product promise

> Turn multiple subscription-backed coding agents into one dependable, inspectable software-delivery system without forcing the developer to use API-key billing, split one product feature into disconnected repository plans, or keep one Claude Code conversation alive for the duration of the work.

The user should be able to say, from Claude Code:

```text
Use `opus-designer` to design this feature.
Use `sol-critic` to challenge the design.
Run the `careful-epic` pipeline autonomously.
Show me every pending worker question.
Resume the implementation after the parent session closed.
```

The same operations must be available deterministically from the terminal:

```bash
tool profile run sol-critic --task current
tool pipeline run careful-epic --issue 482
tool run status run_01...
tool run answer run_01... interaction_04
tool inbox
tool doctor
```

`tool` is a placeholder; naming is intentionally deferred.

---

## 3. Scope and non-goals

### 3.1 v1 scope

v1 includes:

- local installations on macOS and Linux;
- independent operation on each machine, including headless Linux over SSH;
- Claude Code, Codex CLI, and Cursor CLI as production-ready engines;
- subscription-backed authentication and explicit named accounts;
- native Claude subagents and external Claude Code sessions as distinct execution modes;
- a durable local daemon;
- a Claude Code plugin and MCP facade;
- a CLI, operational TUI, and local web dashboard;
- single- and multi-repository Codebases;
- managed composite workspaces and configurable workspace strategies;
- arbitrary YAML-defined pipelines using a fixed set of stage types;
- named workers, roles, profiles, and explicit fallback chains;
- HITL and autonomous execution;
- direct or parent-mediated worker questions;
- logical stage artifacts with fused execution segments;
- smart context continuation;
- full epic task DAGs and task-level waves;
- autonomous internal task-graph revision;
- configurable synchronization of the revised graph to GitHub Issues;
- GitHub issue and pull-request task sources;
- GitHub pull-request publication through a forge abstraction;
- draft pull requests by default;
- backup, restore, and portable run/workspace exports;
- confidential-code mode by default.

### 3.2 Explicit non-goals for v1

v1 does not include:

- Windows support;
- a cloud-hosted control plane;
- Mac-to-Linux remote-node registration or remote execution control;
- cross-machine synchronized dashboards;
- OpenCode as a production-ready engine;
- API-key-only model integrations as the required path;
- an implementation of a coding-agent loop;
- a generic public runtime-plugin API for new stage types;
- draft GitHub Projects items as first-class task sources;
- atomic merges across repositories;
- stage-level wave scheduling across an epic;
- fine-grained per-tool permission-policy authoring;
- automatic account pooling or quota-based account rotation;
- transparent recovery of every live provider process after machine reboot;
- a full post-PR delivery watcher with automated CI repair and review-thread handling;
- a Conductor-style general IDE replacing the developer's editor or terminal;
- repository-local runtime state.

---

## 4. Product principles

### 4.1 Stage contracts, not transcripts

Stages exchange durable artifacts and a small machine result envelope. Raw agent transcripts are retained for diagnostics but are not automatically forwarded into the parent model or downstream workers.

### 4.2 Logical stage is not a model session

A stage is a semantic and durability boundary. An execution segment is a live provider session. Multiple adjacent stages may share a segment, and one stage may continue across several segments.

### 4.3 Deterministic control plane, model-driven cognitive work

Models perform understanding, design, critique, planning, implementation, and semantic review. Deterministic code owns:

- run and stage state;
- dependency scheduling;
- workspace creation;
- locks and leases;
- artifact registration;
- validation;
- transition conditions;
- retry caps;
- branch integration;
- task and graph versioning;
- publication.

### 4.4 Artifact before completion state

A stage artifact must be completely persisted and validated before the transaction that marks the stage attempt successful and releases dependants.

### 4.5 Whole-Codebase reasoning

The repository containing a source issue is provenance and a weak hint. Initial analysis considers the whole registered Codebase and derives the actual read and write sets.

### 4.6 Parallelize whole tasks, not cognitive fragments

Epic waves schedule complete execution tasks. The runtime does not interleave `understand T1`, `design T2`, and `build T3` as independently scheduled epic nodes.

### 4.7 Capability before vendor diversity

Reviewer selection begins with suitability for the role. A different model or provider is preferred among similarly capable profiles but is never required for correctness or tool availability.

### 4.8 Local and confidential by default

No cloud service is required. Product telemetry is off by default. Repository content, prompts, diffs, paths, and task text do not leave the machine except through the coding providers explicitly selected by profiles.

### 4.9 Replaceable execution backend

The pipeline and state model do not depend on Claudexor DTOs or internals. Claudexor is the first `ExecutionBackend`, not the product's domain model.

### 4.10 Every decision has provenance

Graph changes, fallback selection, model/profile resolution, questions, answers, stage transitions, integration, validation, and issue mutations are recorded.

---

## 5. Core domain terminology

### Codebase

A logical software system containing one or more Git repositories.

Examples:

```text
company-platform/
├── api/
├── web/
├── admin/
├── shared-client/
└── reporting/
```

The Codebase root need not be a Git repository.

### Repository

One independent Git repository inside a Codebase. Git branches, commits, CI, pull requests, merge state, and rollback remain repository-scoped.

### Workspace

A logical environment for a unit of work. It owns:

- a Codebase;
- working directories for its repositories;
- provisioning strategy;
- resolved repository base SHAs;
- feature or epic integration branches;
- runs and worker sessions;
- artifacts;
- delivery state.

A workspace is first-class even when backed by an existing checkout rather than managed worktrees.

### Workspace variant

An isolated concrete checkout set created for one parallel writer, candidate implementation, repair attempt, or synthesis task.

### Source work item

The human-facing source of requirements, such as a GitHub issue, parent conversation, Markdown file, or existing PR.

### Feature run / epic run

One coordinated product change. It may span many repositories, source issues, execution tasks, branches, and final pull requests.

### Execution task

A graph node representing one coherent implementation unit. An execution task may read or modify multiple repositories. It executes as a complete mini-pipeline and is the unit scheduled into epic waves.

### Plan step

A fine-grained action inside an execution task. It is not automatically a GitHub issue, branch, PR, or epic wave node.

### Delivery unit

The repository-scoped commits and pull request produced by a run or epic.

### Stage

A logical pipeline step with declared inputs, outputs, completion contract, and transition semantics.

### Stage attempt

One execution of a stage. Retries produce new immutable attempts.

### Execution segment

One live provider session executing one or more adjacent stages or part of a long stage.

### Account

A named provider credential identity and billing route.

### Worker

An engine, account, model, effort level, and execution mode.

### Role

Reusable task instructions and review protocol, such as `designer`, `critic`, `planner`, `builder`, or `code-reviewer`.

### Profile

A convenient named composition of a worker and role, plus defaults and an allowlist of invocation overrides.

### Pipeline template

A YAML-defined graph of stages, transitions, profiles, limits, modes, and completion policies.

### Run state

The canonical durable state for one pipeline run, including artifact references, stages, attempts, decisions, interactions, graph revisions, workspace state, and provider provenance.

---

## 6. System architecture

```text
                         ┌─────────────────────────┐
                         │ Claude Code plugin/MCP  │
                         └────────────┬────────────┘
                                      │
┌────────────┐   ┌────────────┐      │      ┌─────────────────┐
│ CLI        │   │ TUI        │      │      │ Web dashboard   │
└──────┬─────┘   └──────┬─────┘      │      └────────┬────────┘
       │ Unix socket     │ Unix socket│               │ Authenticated
       └─────────────────┴────────────┼───────────────┘ localhost HTTP
                                      ▼
                          ┌────────────────────────┐
                          │ Local orchestration    │
                          │ daemon                 │
                          ├────────────────────────┤
                          │ pipeline runtime       │
                          │ state & event journal  │
                          │ artifact registry      │
                          │ workspace manager      │
                          │ scheduler              │
                          │ interaction inbox      │
                          │ forge adapters         │
                          │ capability catalogue   │
                          └───────────┬────────────┘
                                      │ ExecutionBackend
                                      ▼
                          ┌────────────────────────┐
                          │ Claudexor adapter      │
                          │ first implementation   │
                          └───────────┬────────────┘
                                      ▼
                       Claude Code / Codex / Cursor
```

Native Claude subagents use an additional session-bound path:

```text
active Claude Code parent
  → native Agent tool
  → custom Claude subagent
  → result submitted to daemon
```

The daemon cannot independently call the parent session's `Agent` tool. A native stage therefore waits for a connected parent session.

### 6.1 Local daemon

The daemon owns:

- durable run and workspace state;
- graph scheduling;
- provider run handles;
- background execution;
- interactions and pending questions;
- account queues and concurrency;
- continuation capsules;
- artifact transactions;
- workspace and branch operations;
- GitHub publication;
- notifications;
- backups and exports.

It must not place essential state inside the Claude conversation.

### 6.2 Client surfaces

All clients use the same application service and must not implement independent orchestration logic.

#### Claude Code plugin

Primary conversational interface. It:

- resolves user intent;
- creates structured handoffs from conversation context;
- invokes MCP tools for daemon-owned stages;
- dispatches native Claude profiles through the Agent tool;
- mediates parent-mediated questions;
- summarizes run events and artifacts.

#### CLI

Primary deterministic operational interface for:

- installation and configuration;
- project/codebase registration;
- profile and pipeline authoring;
- starting and inspecting runs;
- answering questions;
- cancellation, retry, and recovery;
- logs and diagnostics;
- backup and export;
- headless Linux operation.

#### TUI

Focused operational client for:

- active runs;
- stage and worker status;
- pending questions;
- inbox;
- start, cancel, retry, and resume;
- log tailing;
- quick profile invocations.

#### Web dashboard

Full rich control surface for:

- Codebases and workspaces;
- pipeline graphs;
- artifact and diff inspection;
- run history;
- questions and approvals;
- profile and pipeline editing;
- PR and CI state;
- high-level diagnostics.

Destructive or high-impact actions require explicit confirmation.

### 6.3 Local transports and authentication

- CLI, MCP, and TUI use a Unix domain socket by default.
- The local web UI binds to `127.0.0.1` and uses an authenticated session.
- A local secret is stored in macOS Keychain or an appropriate Linux secret store/file with restrictive permissions.
- All mutating actions are auditable.

---

## 7. Global application home

All product configuration and runtime state live outside repositories.

Illustrative layout:

```text
~/.tool/
├── config/
│   ├── accounts/
│   ├── workers/
│   ├── roles/
│   ├── profiles/
│   ├── pipelines/
│   └── defaults.yaml
├── codebases/
│   └── <codebase-id>/
│       ├── codebase.yaml
│       ├── repositories/
│       ├── instructions/
│       └── pipeline-overrides/
├── workspaces/
│   └── <workspace-id>/
│       ├── workspace.json
│       ├── checkouts/
│       └── snapshots/
├── artifacts/
│   └── <run-id>/
├── logs/
├── exports/
├── backups/
├── runtimes/
│   └── claudexor/<version>/
├── runtime/
│   ├── daemon.sock
│   └── daemon.pid
└── state.sqlite
```

Repositories are not required to contain `.tool`, generated manifests, sentinels, or run history.

A future public version may support an optional committed manifest for shareable repository defaults, but it is not required in v1 and may not contain accounts, credentials, absolute paths, or runtime state.

---

## 8. Configuration model

### 8.1 Formats

| Concern | Format |
|---|---|
| Human-authored configuration | YAML |
| Roles and substantive artifacts | Markdown |
| Runtime interchange and snapshots | JSON |
| Canonical operational state | SQLite |
| Large/raw artifacts | Files |
| TOML | Not supported in v1 |

YAML uses a restricted subset:

- no custom tags;
- no executable values;
- duplicate keys are rejected;
- merge keys and anchors are disabled initially;
- ambiguous scalar values should be quoted;
- every document is validated against JSON Schema.

### 8.2 Configuration layers

Resolution order, from least to most specific:

```text
built-in defaults
→ global defaults
→ Codebase configuration
→ repository configuration
→ pipeline template
→ profile or stage settings
→ invocation overrides
```

Special rules:

- the strictest applicable hard limit wins;
- privacy may be tightened by a more specific layer but not silently weakened;
- profile invocation overrides are allowed only for fields declared `overridable`;
- the fully resolved configuration is frozen as immutable JSON in every run.

### 8.3 Human-readable source of truth

Profiles, roles, pipelines, and Codebase configuration are YAML/Markdown files. The CLI scaffolds, validates, lists, edits, and resolves them.

```bash
tool profile create opus-planner
tool pipeline validate careful-epic
tool config edit
tool config resolved --codebase company-platform
```

---

## 9. Accounts, workers, roles, and profiles

### 9.1 Accounts

An account names one credential identity and billing route.

```yaml
accounts:
  claude-main:
    engine: claude
    billing: subscription

  claude-secondary:
    engine: claude
    billing: subscription

  codex-main:
    engine: codex
    billing: subscription

  cursor-main:
    engine: cursor
    billing: subscription
```

v1 rules:

- multiple named Claude and Codex accounts are supported where the backend supports them;
- account selection is explicit;
- no automatic quota-based rotation or pooled account routing;
- capacity and queue policy are configurable;
- fallback to another account is allowed only when explicitly declared;
- a `subscription_only` run may never silently fall back to an API key.

### 9.2 Workers

A worker binds execution mechanics:

```yaml
workers:
  opus-xhigh:
    engine: claude
    executor: external
    account: claude-main
    model: opus
    effort: xhigh

  opus-native-high:
    engine: claude
    executor: native
    model: opus
    effort: high

  sol-ultra:
    engine: codex
    account: codex-main
    model: gpt-5.6-sol
    effort: ultra

  grok-builder:
    engine: cursor
    account: cursor-main
    model: grok-4.5
    effort: high
```

`effort` is a first-class field. Model and effort values are validated against the capability catalogue.

### 9.3 Roles

Roles contain reusable task protocol and required artifact semantics.

```yaml
roles:
  designer:
    instructions: roles/designer.md
    artifact_contract: design.v1

  critic:
    instructions: roles/adversarial-critic.md
    artifact_contract: critique.v1

  builder:
    instructions: roles/builder.md
    artifact_contract: implementation.v1
```

### 9.4 Profiles

Profiles compose workers and roles:

```yaml
profiles:
  opus-designer:
    worker: opus-xhigh
    role: designer
    questions: parent-mediated
    overridable:
      - effort
      - focus
      - max_duration

  sol-critic:
    worker: sol-ultra
    role: critic
    questions: parent-mediated

  grok-builder:
    worker: grok-builder
    role: builder
    questions: direct
```

Provider, account, billing route, and workspace strategy are fixed unless the profile explicitly marks them overridable.

### 9.5 Native and external Claude modes

Claude profiles have explicit execution modes:

- `native`: a custom Claude subagent spawned by the active parent Claude Code session;
- `external`: a separate Claude Code session started by the execution backend.

No automatic switching occurs.

A native stage with no connected parent enters:

```text
WAITING_FOR_PARENT_SESSION
```

It may later be dispatched by a connected Claude session. If interrupted, it may be retried from canonical run state, but that is a new attempt rather than guaranteed hidden-context continuation.

### 9.6 Concurrency and queues

Each account defines capacity:

```yaml
accounts:
  claude-main:
    max_concurrent_runs: 2
    queue:
      strategy: priority-fifo
```

When capacity is exhausted, a stage may:

- queue;
- use a declared fallback;
- pause and ask.

Every scheduling decision is recorded.

### 9.7 Execution permissions

v1 does not expose a fine-grained permission-policy DSL. Agent workers default to non-interactive unrestricted execution in their assigned workspace, consistent with the user's preferred YOLO posture.

Safety is supplied by:

- workspace isolation;
- one-writer-per-checkout rules;
- protected base branches;
- completion contracts;
- Git expected-SHA guards;
- artifact validation;
- deterministic verification;
- UI confirmation for high-impact product operations.

A review role may be semantically read-only. The runtime can detect and reject an attempt that changes the workspace, even though v1 does not promise a complete OS-level read-only sandbox.

---

## 10. Engine and capability management

### 10.1 v1 engines

Production-ready:

- Claude Code;
- Codex CLI;
- Cursor CLI.

Deferred:

- OpenCode;
- additional ACP agents.

### 10.2 Assisted, explicit management

The product:

- detects installed versions;
- checks login/authentication state;
- recommends tested versions;
- can install or upgrade only when explicitly requested;
- launches native login flows;
- never silently upgrades;
- maintains a machine compatibility report.

```bash
tool doctor
tool engine install codex
tool engine login claude --account claude-main
tool engine pin cursor <version>
```

### 10.3 Capability catalogue

The daemon caches capabilities per engine/account/version:

- available models;
- effort/reasoning options;
- modes;
- structured-output support;
- session continuation;
- question/elicitation behavior;
- usage reporting;
- cancellation;
- CLI version;
- last verified time.

Profiles are validated when authored and immediately before execution.

### 10.4 Billing guard

For subscription-only profiles, the runtime removes ambient API-key variables where safe, verifies the observed authentication route when the backend exposes it, and fails rather than silently changing billing mode.

---

## 11. Codebases and repositories

### 11.1 Codebase registration

Unknown repositories are detected automatically and registered after one confirmation. Non-interactive use must pass an explicit registration flag.

A Codebase has a stable generated ID. Paths, remotes, and Git common directories are discovery attributes, not identity.

### 11.2 Multi-root Codebase

A Codebase configuration may list multiple repositories:

```yaml
id: codebase_company_platform
name: company-platform

repositories:
  api:
    path: /Users/dawid/code/company/api
  web:
    path: /Users/dawid/code/company/web
  admin:
    path: /Users/dawid/code/company/admin
  shared-client:
    path: /Users/dawid/code/company/shared-client
```

All registered repositories are semantically available to initial analysis. The source issue's repository is not treated as the authoritative implementation location.

### 11.3 Repository analysis

Initial analysis produces:

```json
{
  "sourceRepository": "api",
  "primaryRepository": "identity",
  "readSet": ["api", "identity", "web", "shared-client"],
  "writeSet": ["identity", "shared-client", "web"],
  "excluded": {
    "api": "The requested behavior already exists at the API boundary."
  }
}
```

Only repositories in the final write set require feature branches and PRs, but all Codebase repositories may be read during understanding and planning.

### 11.4 Repository instructions

Instruction sources are discovered and normalized:

```yaml
instructions:
  shared:
    - README.md
    - docs/architecture.md

  native:
    claude:
      - CLAUDE.md
    codex:
      - AGENTS.md
    cursor:
      - .cursor/rules/

  orchestrator:
    - ~/.tool/codebases/<id>/instructions.md
```

Effective precedence:

```text
stage instructions
→ profile/role instructions
→ orchestrator Codebase guidance
→ provider-native instructions
→ shared repository documentation
```

Specific guidance overrides general guidance. Material contradictions pause rather than being silently resolved.

---

## 12. Workspace model

### 12.1 Workspace is always first-class

Every run occurs in a logical workspace, regardless of provisioning strategy.

Supported v1 strategies:

- `managed-worktree`;
- `current-checkout`;
- `existing-checkout`;
- `custom` through configured scripts.

The default is `managed-worktree`.

### 12.2 Managed composite workspace

For a multi-repository Codebase:

```text
~/.tool/workspaces/ws_01.../checkouts/
├── api/             # worktree from api repository
├── web/             # worktree from web repository
├── admin/           # worktree from admin repository
└── shared-client/   # worktree from shared-client repository
```

The parent directory is not a Git repository. Agents start from the composite root and navigate repositories naturally.

### 12.3 Base resolution

For each managed repository:

1. Fetch the configured remote.
2. Resolve the configured branch.
3. If branch is `auto`, resolve `<remote>/HEAD`.
4. Fall back to `<remote>/main`, then `<remote>/master`.
5. Record the exact SHA.
6. Create the feature/integration branch and worktree from that SHA.

Configuration:

```yaml
workspace:
  base:
    remote: origin
    branch: auto
```

The base is configurable per Codebase, repository, pipeline, stage, and invocation.

### 12.4 Active-base synchronization

Workspaces record when a configured base branch advances. Default strategy:

```yaml
workspace:
  synchronization:
    strategy: notify
```

Other explicit strategies may include:

- `pinned`;
- `rebase-before-build`;
- `merge-before-build`;
- `custom`.

No implicit rebase occurs merely because the remote advanced.

### 12.5 New and existing workspaces

A pipeline may:

- create a new workspace automatically from a Codebase;
- run inside an existing workspace;
- be forced to create or reuse through invocation options.

### 12.6 Provisioning

v1 uses a Conductor-style configuration model rather than a public provisioner plugin API:

```yaml
workspace:
  strategy: managed-worktree

  files:
    copy:
      - .env
      - config/database.local.yml

  scripts:
    setup: |
      bundle install
      bin/rails db:prepare

    verify: |
      bundle exec rspec

    archive: |
      docker compose down

  run:
    web:
      command: bin/dev
      port: allocated
```

The runtime supplies stable environment variables for workspace root, Codebase root, repository paths, branch/base metadata, and allocated ports.

### 12.7 Writer isolation

One writer may own a concrete checkout at a time.

Parallel writers receive isolated workspace variants:

```text
Workspace feature-482
├── main integration view
├── candidate-a
├── candidate-b
└── candidate-c
```

Read-only analytical workers may inspect the same state concurrently.

### 12.8 Variant integration

Integration strategy is explicit:

- `select-best`;
- `synthesize`;
- `manual`.

No candidate modifies the canonical workspace automatically.

---

## 13. Task sources and task hierarchy

### 13.1 TaskSource abstraction

```ts
interface TaskSource {
  load(input: unknown): Promise<TaskContext>;
}
```

v1 sources:

- structured handoff from the parent Claude conversation;
- manual text or Markdown;
- GitHub issue;
- GitHub pull request;
- local file;
- existing branch/PR adoption.

GitHub Projects may supply grouping and field metadata, but a draft Project item without a backing repository issue is not a first-class v1 source.

### 13.2 Parent conversation handoff

Workers never receive the raw parent transcript by default. The parent creates:

```yaml
objective: ...
constraints: ...
decisions:
  - ...
open_questions:
  - ...
repository_references:
  - ...
```

This artifact becomes canonical run input.

### 13.3 Source snapshots and revisions

The initial source is immutable. Later GitHub edits or comments are detected and recorded as new source-update artifacts. They are never silently merged into active requirements.

Accepted updates create a new task revision and may invalidate selected downstream stages.

### 13.4 Existing branch or PR adoption

The runtime may adopt an existing branch or PR by:

- creating a managed workspace from its head;
- recording the original base and prior commits;
- linking the run to the existing PR;
- continuing to update the same branch.

It does not infer previously completed pipeline stages from history.

### 13.5 Tracker hierarchy versus execution hierarchy

A source issue may produce several execution tasks and several PRs. A parent issue may have sub-issues across repositories. The external tracker hierarchy and internal execution graph are related but need not be identical.

### 13.6 Autonomous graph revision

Initial analysis may autonomously:

- split tasks;
- merge duplicates;
- create missing tasks;
- remove or descoped execution tasks;
- reassign tasks to other repositories;
- change dependencies;
- change wave membership;
- change task preset.

Safeguards:

- original issues and source requirements remain immutable;
- every graph revision has rationale and evidence;
- no requirement disappears silently;
- merged/removed tasks retain disposition records;
- affected downstream artifacts are invalidated explicitly.

### 13.7 GitHub synchronization

Autonomous runs may synchronize graph revisions to GitHub Issues according to Codebase policy:

- create child issues;
- update scope;
- link dependencies;
- close duplicates;
- move work between repositories.

Required safeguards:

- optimistic concurrency against current issue versions;
- preservation or explicit supersession of human-authored text;
- idempotency keys for issue creation;
- reconciliation state after partial failures;
- complete mutation audit.

### 13.8 External materialization policy

Each Codebase chooses which internal node types become GitHub issues.

Default:

- stakeholder-visible work items are materialized;
- fine-grained plan steps remain internal.

---

## 14. Pipeline model

### 14.1 Arbitrary declarative graph

Pipelines are YAML-defined DAGs with:

- parallel branches;
- fan-in;
- deterministic conditions;
- explicit evaluator stages;
- optional stages;
- bounded retries;
- manual reruns;
- approval gates;
- invocation overrides.

Workers may not invent undeclared providers or unbounded runtime recursion. A user or parent Claude may create a validated one-off graph from existing profiles and supported stage types. The graph is persisted and may later be promoted into a named template.

### 14.2 First-class stage types

v1 supports:

- `agent`;
- `command`;
- `approval`;
- `integration`;
- `verify`;
- `publish`.

No public third-party stage implementation API exists in v1.

### 14.3 Illustrative stage definition

```yaml
stages:
  - id: critique
    type: agent
    profile: sol-critic

    reads:
      - task.current
      - artifacts.design.selected
      - decisions.architecture

    writes:
      - artifacts.critique
      - decisions.critique_verdict

    session:
      policy: fresh

    completion:
      require:
        - valid_result_envelope
        - artifact: critique-report

    on_validation_failure:
      strategy: repair
      session: resume
      max_attempts: 2
```

### 14.4 Conditional transitions

Deterministic conditions are preferred:

```yaml
when:
  expression: verify.blockingFindings.length > 0
then: repair
```

Subjective routing uses an explicit evaluator stage:

```yaml
when:
  evaluator: opus-arbiter
  question: >
    Is the finding local enough for repair, or does it invalidate the design?
```

The evaluator's reasoning and decision are immutable artifacts.

### 14.5 Execution modes

Execution mode is layered:

- pipeline default;
- stage override;
- invocation override.

Modes:

- `autonomous`;
- `hitl`.

HITL may approve every declared gate or selected transitions. Autonomous mode continues unless a question, blocking condition, or configured safety rule pauses it.

### 14.6 Bundled pipelines

Bundled templates are examples, not runtime constraints.

#### `fast`

Typical behavior:

```text
shared deliberation
→ build
→ deterministic verification
→ risk-triggered fresh review
→ publish
```

The same worker may execute deliberation and build if the profile and context permit it.

#### `careful`

Typical behavior:

```text
understand + design
→ fresh adversarial critic
→ revise + plan
→ risk-triggered plan review
→ build
→ fresh code review
→ deterministic verification
→ publish
```

Users may replace, remove, or add stages freely.

### 14.7 Task-level preset selection

Epic analysis assigns `fast` or `careful` per execution task using grounded risk and dependency evidence. The rationale is recorded. Explicit user/project policy may override it; an explicit `careful` request is never silently downgraded.

---

## 15. Logical stages and execution segments

### 15.1 Separate concepts

```text
logical stage       = semantic and durable boundary
worker profile      = engine/model/account/role
execution segment   = one live provider session
artifact boundary   = durable output checkpoint
```

### 15.2 Segment fusion

Adjacent stages may share a segment when:

- they resolve to the same profile;
- the backend supports continuation;
- a fresh-context review is not required;
- context usage is below threshold;
- no explicit fresh-session boundary exists.

A boundary occurs when:

- the next stage uses a different profile;
- an independent critic/reviewer is required;
- the context threshold is reached;
- a backend cannot continue reliably;
- a failure policy requests a fresh attempt;
- the pipeline explicitly declares `fresh`.

Example:

```yaml
stages:
  - id: understand
    profile: opus-planner
  - id: design
    profile: opus-planner
  - id: plan
    profile: opus-planner
  - id: build
    profile: grok-builder
  - id: verify
    profile: sol-verifier
```

Compiled segments:

```text
Segment 1: understand + design + plan
Segment 2: build
Segment 3: verify
```

### 15.3 Smart continuation

The runtime continuously monitors actual or approximate context utilization.

Default starting values:

```yaml
context:
  handoff_soft_threshold: 0.65
  handoff_hard_threshold: 0.80
```

At the soft threshold:

1. The worker completes the nearest safe unit.
2. Work and artifacts are persisted.
3. The runtime creates a deterministic continuation record.
4. The worker adds a narrative handoff.
5. A fresh session starts with the same or configured next profile.
6. The incoming session validates repository and artifact reality before continuing.

The hard threshold prevents further broad exploration and forces a checkpoint at the earliest safe point.

### 15.4 Continuation capsule

Machine record:

```json
{
  "taskId": "T3",
  "stageId": "build",
  "completedPlanItems": ["P1", "P2", "P3"],
  "activePlanItem": "P4",
  "repositoryHeads": {
    "api": "8f31c2a",
    "web": "ad94b11"
  },
  "dirtyFiles": [],
  "decisionIds": ["D7", "D9"],
  "unresolvedQuestionIds": ["Q4"],
  "nextAction": "Implement retry classification",
  "outgoingSessionId": "session-123"
}
```

The companion Markdown narrative contains:

- discoveries;
- implicit assumptions;
- rationale;
- rejected alternatives;
- fragile areas;
- remaining investigation;
- warnings.

### 15.5 Incoming verification

A continuation session must:

- inspect Git HEAD and working trees;
- verify required artifacts exist;
- compare state with the capsule;
- rerun cheap critical checks;
- read named context files first;
- continue only after reconciling mismatches.

---

## 16. Canonical run state and artifacts

### 16.1 One canonical state per run

Every stage knows how to load the same canonical run state. It contains:

- source task and revisions;
- Codebase and repository bases;
- workspace and variants;
- graph versions and waves;
- stage states and attempts;
- resolved profiles;
- provider sessions;
- decisions;
- questions and answers;
- artifacts;
- commits and diffs;
- verification evidence;
- publication state;
- usage and timing.

### 16.2 Hybrid mutability

Immutable:

- artifacts;
- attempts;
- decisions;
- questions and answers;
- commits/diffs;
- graph revisions;
- raw events;
- result envelopes.

Mutable projection:

- current stage status;
- active artifact aliases;
- selected attempt;
- pending interaction;
- run and workspace lifecycle status.

### 16.3 Storage

SQLite is authoritative for:

- identities and relationships;
- state projections;
- events;
- locks and leases;
- interactions;
- artifact metadata;
- scheduling;
- account queues.

Filesystem stores:

- YAML/Markdown configuration;
- prompts;
- reports;
- patches;
- logs;
- raw event streams;
- continuation narratives;
- exports.

### 16.4 Context loading

A stage receives a generated brief containing declared dependencies and a relevant state summary. It may discover additional artifacts on demand through state/artifact tools. Additional reads are recorded for provenance.

Workers may read artifact files directly. Canonical state transitions are submitted through runtime APIs/tools; workers do not directly edit the SQLite projection.

### 16.5 Result pattern

Substantive review/design reasoning remains Markdown. Machine orchestration uses a small validated JSON envelope.

Example:

```json
{
  "status": "changes_required",
  "artifactPath": "reviews/plan-review-r1.md",
  "blockingFindingIds": ["F-1"],
  "nonblockingFindingIds": ["F-2"],
  "unresolvedQuestionIds": [],
  "recommendedTransition": "revise_plan"
}
```

The runtime validates the envelope and required artifact, but never treats schema validity as semantic correctness.

### 16.6 Transactional stage completion

Stage success transaction:

1. Persist artifact to a temporary path.
2. Validate required structure and mechanical claims.
3. Move artifact to immutable final location.
4. Append stage result event.
5. Update state projection and active artifact alias.
6. Release dependent stages.

A crash before step 4 leaves the stage incomplete and safe to retry.

---

## 17. Interactions and questions

### 17.1 Questions are normal state

```text
QUEUED
→ RUNNING
  ├→ WAITING_ON_USER
  ├→ WAITING_FOR_PARENT_SESSION
  ├→ SUCCEEDED
  ├→ FAILED
  └→ CANCELLED
```

`WAITING_ON_USER` is not failure.

### 17.2 Question handling modes

Per profile:

- `parent-mediated`;
- `direct`.

Parent-mediated flow:

```text
worker question
→ daemon interaction
→ parent Claude checks existing context
→ parent asks user only when necessary
→ answer sent to same worker session
```

Direct flow:

```text
worker question
→ structured UI/MCP elicitation
→ user answer
→ same worker session resumes
```

### 17.3 Native Claude questions

A native subagent returns a structured `needs_input` result to the parent. The parent asks the user and resumes the custom subagent in the active Claude session.

### 17.4 Durable inbox and notifications

All events enter a durable inbox. Configurable macOS desktop notifications may alert for:

- worker question;
- pipeline failure;
- stage waiting for parent;
- PR created;
- verification failure.

Linux v1 guarantees the inbox and CLI/TUI visibility; desktop notification support may vary by environment.

---

## 18. Durability and recovery

### 18.1 Parent independence

Daemon-owned external workers and pipeline state continue after Claude Code closes.

A later session can:

- reconnect;
- inspect status;
- answer questions;
- fetch results;
- continue the pipeline.

### 18.2 Restart boundary

v1 does not promise transparent continuation of every provider process after daemon crash or machine reboot.

After restart, the runtime:

- reloads durable state;
- probes provider sessions/processes;
- marks uncertain attempts as `RECOVERY_REQUIRED`;
- offers explicit resume, retry, or fail decisions;
- never silently duplicates a write attempt.

### 18.3 Native stage boundary

Native Claude stages cannot run without an active parent session. The durable pipeline waits rather than silently switching to an external profile.

---

## 19. Review and verification

### 19.1 Review quality model

Review quality depends primarily on:

- role-appropriate model capability;
- fresh and deliberately scoped context;
- strong review protocol/posture;
- repository and artifact evidence;
- deterministic checks.

Different-provider review is optional.

### 19.2 Distinct roles

#### Adversarial critic

Challenges assumptions, alternatives, requirement interpretation, and likely failure modes before commitment.

#### Design/plan reviewer

Checks traceability, completeness, dependency order, interface coherence, executor clarity, and falsifiable completion conditions.

#### Code reviewer

Inspects the implementation against source requirements, design, plan, surrounding code, tests, and likely regressions.

#### Verifier

Runs deterministic commands and acceptance checks. An LLM supplements but does not replace executable evidence.

### 19.3 Fresh review context

The `careful` default requires fresh contexts for critic and code review. The reviewer receives a curated evidence package rather than the author transcript.

A blind-first protocol is preferred:

1. Inspect requirements/artifact/code.
2. Record preliminary findings.
3. Read rationale/rejected alternatives if necessary.
4. Verify or retract findings with evidence.

### 19.4 Model selection

Resolution order:

1. Profiles meeting the role capability contract.
2. Among similarly capable profiles, prefer a different model family.
3. Then another model from the same provider.
4. Then the same model in a fresh session.

The pipeline never blocks solely because the user owns one provider subscription.

### 19.5 Stage completion contract

A worker's “done” claim is evidence, not authority.

A stage may require:

- valid result envelope;
- required artifacts;
- schema or semantic-section checks;
- non-empty expected diff;
- exact commands and exit codes;
- repository-state checks;
- reviewer/evaluator verdict.

### 19.6 Validation failure policy

Configurable bounded strategies:

- pause;
- fail;
- repair in same session;
- repair in fresh session;
- delegate repair to another profile.

HITL proposes the repair first. Autonomous mode follows policy within hard limits.

---

## 20. Epic and multi-task orchestration

### 20.1 Shared epic analysis

A single high-context analysis process reads:

- all source issues;
- relevant GitHub relationships;
- all repositories in the Codebase;
- shared architecture and instructions.

It produces:

- one feature/epic understanding artifact;
- one product-level design;
- one product-level plan;
- per-task task records;
- dependency graph;
- repository read/write sets;
- risk/preset assignments.

There is no requirement for one separate plan per repository.

### 20.2 Task-level DAG

The epic graph contains execution tasks, not individual task stages.

Example:

```text
T1 ──→ T2 ──┐
 │           ├──→ T5
 └──→ T3 ──→ T4
```

Computed task waves:

```text
Wave 1: T1
Wave 2: T2, T3
Wave 3: T4
Wave 4: T5
```

Each task runs its complete configured mini-pipeline.

### 20.3 Tasks may span repositories

Example:

```text
T1: introduce API contract
  writes: api, shared-client
  reads: web, admin

T2: web adoption
  writes: web
  reads: api, shared-client
```

A task receives one composite workspace variant containing relevant repository worktrees.

### 20.4 Wave eligibility

A task becomes schedulable only when:

- all predecessors succeeded;
- predecessor completion contracts passed;
- predecessor changes were integrated into the relevant repository integration branches;
- combined wave verification passed;
- no unresolved graph revision blocks it.

### 20.5 Parallel-wave execution

Tasks in one wave run in isolated composite workspace variants created from the same repository integration SHAs.

Potential write-set overlap may cause the analyzer to serialize tasks even when their declared issue dependencies are independent.

### 20.6 Wave integration

For each completed task:

- preserve task branches and artifacts;
- prepare merges into repository-specific epic integration branches;
- perform expected-SHA and conflict checks;
- verify the combined composite state;
- only then release the next wave.

Because Git cannot atomically update many repositories, cross-repository integration uses a reconciliation state rather than claiming an atomic transaction.

A safe implementation may:

1. Prepare candidate merge commits/branches for every affected repository.
2. Materialize a temporary composite integration workspace.
3. Run combined verification.
4. Update canonical repository integration refs with expected-SHA guards.
5. Enter `RECONCILIATION_REQUIRED` if a partial update occurs.

### 20.7 Hidden dependency discovery

When a parallel worker discovers a material dependency:

1. Record a dependency finding.
2. Stop launching affected work.
3. Cancel or pause unsafe attempts.
4. Preserve completed safe work.
5. Create a new graph revision.
6. Integrate safe predecessors.
7. Replan remaining tasks.
8. Resume with new waves.

### 20.8 Failure propagation

A failed prerequisite blocks dependants. The runtime records the transitive block reason and does not ask a model to rediscover it.

### 20.9 Task graph and issue graph

The internal execution graph is canonical for the run. GitHub issue synchronization is an external projection governed by Codebase policy.

---

## 21. Git branch and delivery model

### 21.1 Single-repository epic

```text
main
└── epic/<feature>
    ├── task/<t1>
    ├── task/<t2>
    └── task/<t3>
```

Task branches merge into the epic integration branch. The final epic branch creates one draft PR to the configured base branch.

### 21.2 Multi-repository epic

Each changed repository has its own epic integration branch and final PR:

```text
api:           epic/<feature> → PR A
shared-client: epic/<feature> → PR B
web:           epic/<feature> → PR C
```

The parent run tracks these PRs collectively.

### 21.3 Child PRs

Task branches are internal by default. Child PRs targeting the epic integration branch are configurable per epic/task when separate review or CI visibility is valuable.

### 21.4 Alternative delivery mode

Per-task PRs are supported as an explicit delivery policy.

### 21.5 Draft PR default

Publish defaults:

```yaml
completion:
  pull_request:
    state: draft
```

Codebase/pipeline policy may choose:

- ready for review;
- auto-merge when the repository permits it and all required gates pass.

### 21.6 Forge abstraction

```ts
interface ForgeBackend {
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  markReady(id: string): Promise<void>;
  getChecks(id: string): Promise<CheckStatus[]>;
  getFailedCheckLogs(id: string): Promise<CheckFailure[]>;
  enableAutoMerge(id: string): Promise<void>;
}
```

v1 implements `GitHubForgeBackend`.

### 21.7 Cross-repository delivery

The parent run coordinates dependency and delivery order but does not promise atomic multi-repository merge.

Expand/migrate/contract and similar rollout patterns may be represented in the task DAG and publication policy.

### 21.8 Post-v1 delivery watcher

Continuous polling, CI-repair runs, review-comment classification, automatic replies, and thread resolution are specified future extensions, not part of the v1 completion criterion.

The intended model is:

```text
workspace
├── completed implementation run
├── PR(s)
└── delivery watcher
    └── creates new linked repair runs
```

A completed pipeline run is immutable and is never “reopened.”

---

## 22. ExecutionBackend abstraction

```ts
type ExecutionStatus =
  | "queued"
  | "running"
  | "waiting_on_user"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "recovery_required";

interface ExecutionRequest {
  stageId: string;
  profile: ResolvedProfile;
  workspaceId: string;
  workingDirectory: string;
  inputArtifactRefs: string[];
  outputContract: string;
  limits: {
    maxDurationMs?: number;
    maxTurns?: number;
  };
}

interface PendingInteraction {
  id: string;
  kind: "free_text" | "single_choice" | "multiple_choice";
  prompt: string;
  options?: string[];
}

interface ExecutionResult {
  status: "succeeded" | "failed" | "cancelled";
  summary: string;
  providerSessionId?: string;
  changedRepositories: string[];
  artifacts: Record<string, string>;
  usage?: Record<string, number>;
}

interface ExecutionBackend {
  start(request: ExecutionRequest): Promise<string>;
  status(runId: string): Promise<ExecutionStatus>;
  interactions(runId: string): Promise<PendingInteraction[]>;
  answer(runId: string, interactionId: string, answer: unknown): Promise<void>;
  resume(runId: string, inputArtifactRefs: string[]): Promise<void>;
  result(runId: string): Promise<ExecutionResult>;
  cancel(runId: string): Promise<void>;
}
```

The pipeline runtime stores its own IDs and maps them to backend run IDs.

---

## 23. Claudexor integration

### 23.1 Role

Claudexor is the v1 external execution kernel for Claude Code, Codex CLI, and Cursor CLI.

The product uses Claudexor for:

- CLI process/session handling;
- provider authentication profiles;
- long-running daemon-owned executions;
- questions and interaction persistence;
- provider session continuation where available;
- event capture;
- worktree/process supervision where useful.

The product does not use Claudexor as:

- pipeline graph;
- canonical state model;
- profile/role domain model;
- user-facing configuration schema;
- sole artifact store.

### 23.2 Integration surface

The custom daemon talks to Claudexor's versioned control API through an anti-corruption adapter. It does not import internal Claudexor packages.

The product's own MCP tools call the product daemon, not Claudexor directly.

### 23.3 Managed dependency

Default:

```text
~/.tool/runtimes/claudexor/<pinned-version>/
```

Advanced users may point to an external Claudexor installation.

Upgrades are explicit and must pass compatibility tests before activation.

### 23.4 Maturity posture

Claudexor is treated as replaceable because:

- it is young and rapidly evolving;
- longitudinal stability is limited;
- provider adapters may break as CLIs change;
- maintenance has owner/bus-factor risk.

The dependency is still valuable because it avoids building and continuously maintaining several fast-changing CLI adapters.

### 23.5 Required compatibility tests

Before promoting a Claudexor version:

- 20-minute external planning run;
- free-text question and same-session continuation;
- cancellation and process-tree cleanup;
- subscription-only auth-route verification;
- Claude external profile;
- Codex external profile;
- Cursor external profile;
- session resume;
- event/result normalization;
- isolated write attempt;
- daemon restart/recovery classification;
- malformed output and unsupported model failure;
- artifact path and diff retrieval.

---

## 24. Limits, retries, and safeguards

Limits are layered:

```yaml
limits:
  max_pipeline_duration: 4h
  max_concurrent_workers: 4
  max_repair_attempts: 3
  max_graph_revisions: 5
```

Profile/stage limits may be stricter. The strictest hard limit wins.

The runtime records:

- duration;
- turns when available;
- token/context usage when available;
- session count;
- retries;
- repair attempts;
- fallback substitutions;
- provider throttling;
- context handoffs.

Soft limits warn. Hard limits pause or fail safely.

---

## 25. Notifications and inbox

Every significant event is persisted in an inbox.

Configurable notifications include:

```yaml
notifications:
  desktop:
    - worker-question
    - waiting-for-parent
    - pipeline-failed
    - verification-failed
    - pull-request-created
```

When Claude Code reconnects, the plugin summarizes unresolved events rather than replaying all event logs.

---

## 26. Retention, backup, and export

### 26.1 Retention

After merge/close:

- workspace is archived;
- disposable worktrees are removed according to policy;
- run state, summaries, decisions, graph history, and PR history remain;
- bulky logs and events expire separately.

```yaml
retention:
  worktrees:
    after_merge: remove
  artifacts:
    summaries: forever
    patches: 180d
    raw_events: 30d
    logs: 14d
```

Failed/unmerged workspaces are retained unless policy explicitly removes them.

### 26.2 Portable workspace/run bundles

```bash
tool export workspace <id>
tool import <bundle>
```

Bundles contain:

- versioned metadata;
- resolved pipeline;
- resolved profiles without secrets;
- graph revisions;
- decisions/interactions;
- selected artifacts;
- patches and commit references;
- PR/CI history.

They exclude:

- credentials;
- tokens;
- machine secret paths;
- disposable logs unless requested.

### 26.3 Full backup

```bash
tool backup create
tool backup restore
```

Backup covers SQLite, configuration, selected artifacts, and runtime metadata.

---

## 27. Security and privacy

### 27.1 Confidential-code default

```yaml
privacy:
  mode: confidential
  telemetry: off
  crash_reports: local
  include_repository_content: false
  include_prompts: false
  include_paths: false
  diagnostics_export: explicit
```

### 27.2 Configurable, visible policy

Users may opt into anonymous operational metrics or richer diagnostics. The UI must show exactly what leaves the machine.

A Codebase may tighten global privacy but may not silently weaken it.

### 27.3 Provider transparency

Every run records which engine, model, account, and provider received which task/artifacts. The user can inspect this before and after execution.

### 27.4 Secrets and logs

- secrets are not copied into export bundles;
- logs support redaction;
- environment variables passed to workers are allowlisted or scrubbed;
- subscription-only profiles remove API-key variables where appropriate;
- local web tokens are protected;
- diagnostics exports are previewable.

---

## 28. Installation and distribution

### 28.1 Normal installation

Self-contained executables for macOS and Linux. Node.js is not a user prerequisite.

The distribution includes:

- daemon;
- CLI;
- TUI;
- MCP server;
- web assets;
- schemas;
- bundled pipelines;
- migration tooling.

### 28.2 Development installation

npm packages remain available for contributors and advanced environments.

### 28.3 Independent machine operation

Mac and Linux installations do not form a remote cluster in v1.

A Linux VPS is operated through SSH/Termius like a normal terminal host. It has its own state, accounts, workspaces, and local dashboard.

---

## 29. v1 end-to-end acceptance scenario

v1 is complete only when the following scenario works reliably on both macOS and Linux.

### Scenario

A registered Codebase contains at least three repositories. A GitHub issue in one repository describes a feature that actually requires changes in all three. The issue decomposition contains five execution tasks:

```text
T1 blocks T2, T3, T4, T5
T2–T5 are mutually independent after T1
```

Configured profiles use:

- external Claude Code for understanding/design/planning;
- Codex CLI for adversarial critique and/or verification;
- Cursor CLI for at least one implementation task;
- subscription-backed accounts only.

### Required behavior

1. The run creates a managed composite workspace from freshly fetched configured bases.
2. Shared analysis inspects the full Codebase and may determine the issue repository is not primary.
3. The run produces one feature-level understanding, design, and plan.
4. The analyzer creates or revises a five-task DAG and records graph provenance.
5. The analyzer assigns `fast`/`careful` per task.
6. T1 executes as a complete task pipeline.
7. T1 changes are verified and integrated into repository-specific epic branches.
8. T2–T5 start from the integrated bases and execute in parallel isolated variants.
9. At least one worker asks a clarification question and resumes the same provider session after an answer.
10. The parent Claude Code session can close while external stages continue.
11. A new parent session reconnects and retrieves status.
12. At least one long segment performs a smart continuation handoff.
13. All four parallel tasks integrate serially with expected-SHA guards.
14. Combined multi-repository verification passes.
15. One draft PR is created for each changed repository.
16. All PRs are linked to the same run and source issue.
17. Run state includes every profile, model, account, artifact, graph revision, question, answer, commit, verification command, and PR.
18. The workspace can be exported and imported.
19. The run can be inspected from CLI, TUI, web dashboard, and Claude Code.
20. No repository contains product runtime state.

### Failure-path acceptance

The same test suite must cover:

- unavailable model/profile fallback;
- account capacity queueing;
- worker cancellation;
- malformed stage result;
- failed deterministic verification and bounded repair;
- hidden task dependency discovered during a parallel wave;
- merge conflict;
- daemon restart with explicit recovery;
- partial multi-repository integration reconciliation;
- GitHub issue update conflict;
- native Claude stage waiting for parent;
- subscription auth route mismatch.

---

## 30. Bundled `fast` and `careful` templates

These are product defaults, not runtime invariants.

### 30.1 `fast`

```yaml
name: fast

stages:
  - id: deliberate
    type: agent
    profile: task-owner
    produces: [understanding, design, plan]

  - id: build
    type: agent
    profile: task-owner
    session:
      policy: resume-if-compatible

  - id: risk-review
    type: agent
    profile: reviewer
    session:
      policy: fresh
    when:
      expression: risk.requiresFreshReview == true

  - id: verify
    type: verify

  - id: publish
    type: publish
```

### 30.2 `careful`

```yaml
name: careful

stages:
  - id: understand-design
    type: agent
    profile: designer
    produces: [understanding, design]

  - id: critique
    type: agent
    profile: critic
    session:
      policy: fresh

  - id: revise-plan
    type: agent
    profile: designer
    session:
      policy: resume-if-compatible
    produces: [design-revision, plan]

  - id: plan-review
    type: agent
    profile: plan-reviewer
    session:
      policy: fresh
    when:
      expression: risk.requiresPlanReview == true

  - id: build
    type: agent
    profile: builder

  - id: code-review
    type: agent
    profile: code-reviewer
    session:
      policy: fresh

  - id: verify
    type: verify

  - id: publish
    type: publish
```

---

## 31. Product metrics and local evaluation

The product records local metrics necessary to validate its value:

- total model sessions per task;
- cold starts;
- fused-stage count;
- smart continuation count;
- input/output/cache usage where available;
- elapsed time;
- aggregate worker time;
- artifact re-reads;
- reviewer findings and accepted/rejected findings;
- retries and repairs;
- wave parallelism;
- merge conflicts;
- human questions;
- provider availability failures.

No fixed token-reduction claim is part of v1. The product should make it possible to compare:

- one persistent deliberation versus cold staged sessions;
- same-model versus cross-model review;
- fast versus careful;
- sequential versus parallel task waves;
- direct CLI use versus orchestrated use.

---

## 32. Development-time Kombajn extraction charter

The new repository treats `davebream/kombajn` as prior art and a development-time reference. It is not a runtime dependency and does not have architectural authority unless a concept is explicitly accepted below.

### 32.1 Borrow as principles

| Concept | Preserve |
|---|---|
| Deterministic stage computation | Pure, testable next-state decisions instead of LLM memory |
| Artifact-first durability | Artifact committed before completion state |
| Canonical state plus event history | Current projection plus append-only audit |
| Requirements preservation | Verbatim source requirements and stable traceability IDs |
| Executor-grade plans | Exact context, files, done conditions, verification |
| Independent critique/review | Distinct evaluation posture and fresh context |
| Evidence before completion | Worker claims never substitute for tests or checks |
| Worktree isolation | One writer per concrete checkout |
| Dependency-aware task scheduling | Task DAGs, blocking propagation, wave computation |
| HITL and autonomous modes | Same core runtime with different approval policies |
| Model/session boundary separation | One authoring context may emit several logical artifacts |
| Cross-task coherence | Combined verification after integration |

### 32.2 Borrow but redesign

| Kombajn form | New form |
|---|---|
| JSON manifest | SQLite projection plus immutable artifacts |
| JSONL audit file | Structured event journal |
| Hardcoded stage matrix | YAML pipeline graph |
| Claude model aliases in agents | Provider-neutral named profiles |
| Skill-driven orchestration loops | Daemon-owned deterministic scheduler |
| `.kombajn` runtime state | Global application home |
| tmux/AgentAPI fleet | Replaceable `ExecutionBackend` |
| per-task worktree | composite Codebase workspace and variants |
| `/land` skill | `ForgeBackend` and publish stage |
| expert roster | optional roles/profiles, not mandatory fan-out |
| depth tiers | two bundled presets plus configurable pipelines |
| direct manifest mutation | transactional runtime API |
| provider-specific session handling | backend adapter |

### 32.3 Do not borrow

- the 70-skill/60-agent surface;
- repeated cold stage processes as the default;
- stage-level wave scheduling;
- duplicated orchestration across skill prose, shell, hooks, and TypeScript;
- wrapper-agent ceremony that adds no independent capability;
- giant effective prompts and repeated rereading;
- mandatory review fan-out;
- repository-local runtime sentinels;
- control flow implicit in prose;
- overlapping standalone, fleet, epic, and in-session implementations;
- hardcoded model assignments;
- historical compatibility machinery unrelated to the new product;
- CLI wrappers around operations that standard tools already perform reliably;
- an assumption that every repository needs a separate design or plan.

### 32.4 Required extraction workflow

Before implementing a subsystem derived from Kombajn:

1. Read the relevant source paths.
2. State the useful invariant.
3. State the complexity/failure being rejected.
4. Define the new provider-neutral contract.
5. Implement against the new contract.
6. Add a regression test for the preserved invariant.

### 32.5 Primary source map

Development should consult, at minimum:

- `docs/kombajn-dev-architecture-overview.md`
- `plugins/dev/skills/implement/SKILL.md`
- `plugins/dev/skills/implement/autonomous-wave-loop.md`
- `plugins/dev/skills/understand/SKILL.md`
- `plugins/dev/skills/plan/SKILL.md`
- `plugins/dev/skills/build/SKILL.md`
- `plugins/dev/skills/verify/SKILL.md`
- `plugins/dev/skills/land/SKILL.md`
- `plugins/dev/reference/epic-schema.md`
- `plugins/dev/reference/project-config.md`
- `cli/src/task-stage.ts`
- `cli/src/dag.ts`
- `cli/src/reconcile-state.ts`
- `docs/audits/2026-07-28-kombajn-synthesis-audit-v3.md`

---

## 33. Phased implementation plan

The public v1 scope remains full epic orchestration, but implementation should proceed through vertical milestones.

### Milestone 1 — Local kernel

- application home;
- SQLite schema and event journal;
- daemon/socket;
- CLI;
- Codebase registration;
- single-repository managed workspace;
- one external backend profile;
- one stage and artifact transaction.

### Milestone 2 — Profiles and multi-engine execution

- accounts/workers/roles/profiles;
- Claudexor adapter;
- Claude external, Codex, Cursor;
- questions and continuation;
- capability catalogue;
- subscription guard;
- native Claude bridge.

### Milestone 3 — Pipelines

- YAML parser/schema;
- stage types;
- conditions;
- HITL/autonomous;
- completion and repair contracts;
- one-off graphs;
- bundled fast/careful.

### Milestone 4 — Multi-root Codebases

- composite workspaces;
- repository-specific setup;
- product-level understand/design/plan;
- multi-repository tasks;
- smart continuation;
- combined verification.

### Milestone 5 — Epic task waves

- autonomous graph revision;
- task DAG;
- whole-task waves;
- workspace variants;
- integration branches;
- hidden-dependency replanning;
- reconciliation.

### Milestone 6 — GitHub delivery

- issue source/sync;
- forge abstraction;
- draft PRs;
- linked multi-repository PRs;
- existing PR adoption.

### Milestone 7 — Product surfaces and hardening

- TUI;
- web dashboard;
- backup/export;
- notifications;
- macOS/Linux packaging;
- compatibility matrix;
- full acceptance scenario.

---

## 34. Risks and mitigation

### Claudexor churn

**Risk:** Young dependency and fast provider changes.  
**Mitigation:** Narrow adapter, exact pin, compatibility suite, mirror/fork escape path.

### External Claude subscription policy

**Risk:** Provider policy for programmatic third-party usage may change.  
**Mitigation:** Reverify policy before public release, surface auth route, keep native Claude path, make backend replaceable.

### Context metrics are incomplete

**Risk:** Not every CLI reports exact context utilization.  
**Mitigation:** Conservative approximate accounting and early handoff thresholds.

### Full v1 breadth

**Risk:** Full epic engine plus three UIs, three providers, two OSes, GitHub, and multi-repo workspaces is a large v1.  
**Mitigation:** Vertical milestones and one canonical acceptance scenario; do not declare v1 before all commitments work.

### Multi-repository integration cannot be atomic

**Risk:** Partial ref updates or publication.  
**Mitigation:** prepare/verify/publish protocol, expected-SHA guards, reconciliation state, no false atomicity claim.

### Autonomous GitHub mutation

**Risk:** Incorrect or conflicting issue edits.  
**Mitigation:** source snapshots, optimistic concurrency, idempotency, explicit supersession, complete audit.

### YOLO execution

**Risk:** Agents have broad workspace capabilities.  
**Mitigation:** isolation, protected branches, one-writer rule, deterministic gates, product-level confirmations, confidential local operation.

### Over-engineering from Kombajn

**Risk:** Recreating a large Claude-specific orchestration system.  
**Mitigation:** extraction charter, no stage-level waves, no giant roster, no repo-local runtime, fixed v1 stage types, backend boundaries.

---

## 35. Definition of done for the specification phase

This specification is ready to turn into architecture/design work when:

- domain terminology is accepted;
- v1 scope is accepted;
- the canonical end-to-end acceptance scenario is accepted;
- the Kombajn extraction charter is accepted;
- unresolved implementation risks are converted into explicit spikes;
- no client surface contains unique orchestration logic;
- no provider-specific type leaks into pipeline state.

Naming remains intentionally open and does not block implementation.
