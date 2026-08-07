<!-- heniek-queue revision=1 sha256=b29fc62f94d7810be5f065d73934504848dab9000997f141351242bc104af908 count=57 -->

# EPIC — Heniek v1

Deliver every fixed v1 commitment in Product Specification v0.2 through the
strict revision-1 queue. The queue is a total order: an item becomes claimable
only after its predecessor is merged, closed, and independently visible on
remote `main`.

Queue SHA-256: `b29fc62f94d7810be5f065d73934504848dab9000997f141351242bc104af908`

## M0 — Contracts and proof spikes

Freeze provider-neutral contracts and retire the highest-risk subscription-execution assumptions.

- [ ] Q001 — Establish Heniek domain IDs, state vocabulary and versioned JSON contracts
- [ ] Q002 — Add the real-engine conformance harness and deterministic fake backends
- [ ] Q003 — Spike A: Claudexor long-run handles, questions, resume and parent independence
- [ ] Q004 — Spike B: isolated subscription-only Claude and Codex profiles under hostile ambient env

## M1 — Local kernel

Deliver durable local state, daemon transport, Codebase registration, workspaces, and one real external stage.

- [ ] Q005 — Implement global application-home resolution, YAML layers and secret-store abstraction
- [ ] Q006 — Implement SQLite migrations, canonical projections and append-only event journal
- [ ] Q007 — Implement immutable artifacts and transactional stage completion
- [ ] Q008 — Implement daemon single-instance lifecycle, local authentication and crash recovery
- [ ] Q009 — Implement Unix-socket JSON-RPC and minimal CLI handshake/status
- [ ] Q010 — Implement Codebase detection, registration and instruction-conflict reporting
- [ ] Q011 — Implement single-repository workspace provisioning, base sync and writer leases
- [ ] Q012 — Deliver one external Claudexor stage end-to-end with restart and doctor tests

## M2 — Profiles and multi-engine execution

Make Claude Code, Codex, Cursor, accounts, interactions, queues, and billing guards production-ready.

- [ ] Q013 — Implement managed, pinned and replaceable Claudexor runtime lifecycle
- [ ] Q014 — Implement accounts, workers, roles, profiles and effort resolution
- [ ] Q015 — Implement capability catalogue, engine readiness and model discovery
- [ ] Q016 — Implement external Claude execution and profile adapter
- [ ] Q017 — Implement Codex execution and profile adapter
- [ ] Q018 — Spike C and implement Cursor execution and profile adapter
- [ ] Q019 — Spike D: normalize context, usage and native-session telemetry
- [ ] Q020 — Implement durable interactions, inbox, answer and resume
- [ ] Q021 — Implement account queues, concurrency, fallback chains and permissions
- [ ] Q022 — Implement subscription billing guard, env scrubbing, redaction and process cleanup
- [ ] Q023 — Spike G and implement the native Claude bridge

## M3 — Pipeline runtime

Implement deterministic YAML pipelines, fixed stage runners, repair policy, fusion, and bundled templates.

- [ ] Q024 — Implement YAML pipeline schema, parser and diagnostics
- [ ] Q025 — Implement deterministic graph scheduling and the fixed stage state machine
- [ ] Q026 — Implement agent and command stage runners
- [ ] Q027 — Implement approval, integration, verify and publish stage runners
- [ ] Q028 — Implement conditions, retry/session policy, limits and bounded repair
- [ ] Q029 — Implement segment fusion, smart continuation, capsules and incoming verification
- [ ] Q030 — Ship the bundled fast pipeline
- [ ] Q031 — Ship the careful pipeline using accepted predecessor review semantics
- [ ] Q032 — Implement one-off graphs, overrides, ad-hoc attachment and pipeline conformance

## M4 — Multi-root Codebases

Prove and implement safe orchestration across composite workspaces containing many repositories.

- [ ] Q033 — Spike E: prove a ten-repository composite workspace
- [ ] Q034 — Implement multi-root Codebase configuration and base pins
- [ ] Q035 — Implement composite provisioning, repository setup and instruction merge
- [ ] Q036 — Implement isolated variants, one-writer leases and expected-SHA integration
- [ ] Q037 — Implement whole-Codebase analysis and multi-repository tasks
- [ ] Q038 — Implement combined verification, cleanup and restart reconciliation

## M5 — Epic task waves

Implement task hierarchy, graph revision, parallel waves, integration branches, and reconciliation.

- [ ] Q039 — Implement TaskSource, handoffs, snapshots, revisions and hierarchy
- [ ] Q040 — Implement task DAG validation, wave eligibility and capacity gates
- [ ] Q041 — Implement autonomous graph revision and provenance
- [ ] Q042 — Implement whole-task parallel scheduling and failure propagation
- [ ] Q043 — Implement repository epic branches and serialized integration
- [ ] Q044 — Spike F and implement partial multi-repository reconciliation
- [ ] Q045 — Implement hidden-dependency replanning and the T1→T2–T5 epic scenario

## M6 — GitHub delivery

Implement GitHub task synchronization and recoverable single- and multi-repository draft PR delivery.

- [ ] Q046 — Implement GitHub TaskSource, synchronization and update-conflict handling
- [ ] Q047 — Implement GitHub ForgeBackend issue, branch and PR primitives
- [ ] Q048 — Implement external materialization and existing branch/PR adoption
- [ ] Q049 — Implement linked single- and multi-repository draft PR delivery and recovery

## M7 — Surfaces and hardening

Complete client surfaces, operations, packaging, security, compatibility, and full v1 acceptance.

- [ ] Q050 — Implement Claude MCP/plugin handoff, status, answer and native-stage surface
- [ ] Q051 — Complete deterministic CLI operations
- [ ] Q052 — Implement the operational TUI
- [ ] Q053 — Implement authenticated localhost HTTP/SSE and web dashboard
- [ ] Q054 — Implement durable inbox, product notifications and macOS notifications
- [ ] Q055 — Implement retention, archive, export/import and backup/restore
- [ ] Q056 — Spike H and ship macOS/Linux standalone plus npm packaging/update path
- [ ] Q057 — Complete security hardening, compatibility matrix and full platform acceptance

Any mismatch between this marker/order, the manifest, or an issue marker pauses
the factory. The controller never skips or guesses.
