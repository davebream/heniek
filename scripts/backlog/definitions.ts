export interface MilestoneDefinition {
  id: string;
  title: string;
  description: string;
}

export interface IssueDefinition {
  id: `Q${string}`;
  milestone: string;
  title: string;
  tier: "T0-evidence" | "T1-foundation" | "T2-capability" | "T3-acceptance";
  anchors: string[];
  outcome: string;
  constraints: string[];
  exclusions: string[];
  acceptance: string[];
  tests: string[];
  evidence: string[];
}

export const milestones: MilestoneDefinition[] = [
  {
    id: "M0",
    title: "Contracts and proof spikes",
    description:
      "Freeze provider-neutral contracts and retire the highest-risk subscription-execution assumptions.",
  },
  {
    id: "M1",
    title: "Local kernel",
    description:
      "Deliver durable local state, daemon transport, Codebase registration, workspaces, and one real external stage.",
  },
  {
    id: "M2",
    title: "Profiles and multi-engine execution",
    description:
      "Make Claude Code, Codex, Cursor, accounts, interactions, queues, and billing guards production-ready.",
  },
  {
    id: "M3",
    title: "Pipeline runtime",
    description:
      "Implement deterministic YAML pipelines, fixed stage runners, repair policy, fusion, and bundled templates.",
  },
  {
    id: "M4",
    title: "Multi-root Codebases",
    description:
      "Prove and implement safe orchestration across composite workspaces containing many repositories.",
  },
  {
    id: "M5",
    title: "Epic task waves",
    description:
      "Implement task hierarchy, graph revision, parallel waves, integration branches, and reconciliation.",
  },
  {
    id: "M6",
    title: "GitHub delivery",
    description:
      "Implement GitHub task synchronization and recoverable single- and multi-repository draft PR delivery.",
  },
  {
    id: "M7",
    title: "Surfaces and hardening",
    description:
      "Complete client surfaces, operations, packaging, security, compatibility, and full v1 acceptance.",
  },
];

export const issues: IssueDefinition[] = [
  {
    id: "Q001",
    milestone: "M0",
    title: "Establish Heniek domain IDs, state vocabulary and versioned JSON contracts",
    tier: "T1-foundation",
    anchors: [
      "§5 Core domain terminology",
      "§16 Canonical run state and artifacts",
      "§22 ExecutionBackend abstraction",
    ],
    outcome:
      "A provider-neutral contracts package defines branded domain IDs, canonical state vocabularies, and versioned JSON contracts for execution backends, task sources, forge backends, runs, interactions, and artifacts.",
    constraints: [
      "Use TypeBox and Ajv with stable schema identifiers and explicit version fields.",
      "Keep provider DTOs and transport details outside domain contracts.",
    ],
    exclusions: [
      "No database implementation, daemon transport, or provider adapter.",
      "No unversioned public payload.",
    ],
    acceptance: [
      "All public contract families compile to TypeScript and deterministic checked-in JSON Schema.",
      "Every state transition vocabulary has documented terminal and non-terminal values.",
      "Compatibility tests reject unknown versions and provider-specific field leakage.",
    ],
    tests: [
      "Schema round-trip and invalid-payload table tests.",
      "Property tests for ID namespaces and state-enum exhaustiveness.",
    ],
    evidence: ["Generated-schema manifest and hashes.", "Contract compatibility test output."],
  },
  {
    id: "Q002",
    milestone: "M0",
    title: "Add the real-engine conformance harness and deterministic fake backends",
    tier: "T1-foundation",
    anchors: [
      "§22 ExecutionBackend abstraction",
      "§23.5 Required compatibility tests",
      "§29 v1 end-to-end acceptance scenario",
    ],
    outcome:
      "A reusable conformance kit runs the same lifecycle assertions against deterministic fake ExecutionBackend, TaskSource, and ForgeBackend implementations and opt-in real providers.",
    constraints: [
      "Fake time, IDs, provider events, and failures must be seedable and reproducible.",
      "Real subscription tests must be explicitly enabled and clearly report their auth route.",
    ],
    exclusions: [
      "No real provider is required in ordinary CI.",
      "No network access in deterministic test suites.",
    ],
    acceptance: [
      "The harness covers start, status, interaction, answer, resume, result, cancellation, and malformed responses.",
      "Fake backends model disconnects, rate limits, stale refs, conflicts, and crash recovery.",
      "Adding a backend requires implementing one shared conformance contract rather than copying tests.",
    ],
    tests: [
      "Seed-replay determinism tests.",
      "Contract tests against all fake backends and one opt-in smoke adapter.",
    ],
    evidence: ["Conformance matrix artifact.", "Recorded deterministic failure replay."],
  },
  {
    id: "Q003",
    milestone: "M0",
    title: "Spike A: Claudexor long-run handles, questions, resume and parent independence",
    tier: "T0-evidence",
    anchors: [
      "§17 Interactions and questions",
      "§18 Durability and recovery",
      "§23.5 Required compatibility tests",
    ],
    outcome:
      "An evidence-backed ADR establishes whether pinned Claudexor `/v2` handles survive parent disconnects and support durable questions, answers, cancellation, and same-session resume.",
    constraints: [
      "Test the exact pinned Claudexor revision through `/v2`; do not import internals.",
      "Run at least one 20-minute external Claude session and kill the launching parent.",
    ],
    exclusions: [
      "No production adapter beyond minimal spike code.",
      "No inference from documentation without an executable canary.",
    ],
    acceptance: [
      "The ADR records observed handle, process, session, and interaction semantics.",
      "Parent termination, daemon restart, answer/resume, cancellation, and cleanup outcomes are classified.",
      "Any unsupported behavior has a bounded fallback that preserves public contracts.",
    ],
    tests: [
      "Scripted parent-kill and resume canary.",
      "Question/answer and process-tree cleanup canaries.",
    ],
    evidence: [
      "Redacted event trace with timestamps and process IDs.",
      "ADR with pin, commands, results, and decision.",
    ],
  },
  {
    id: "Q004",
    milestone: "M0",
    title:
      "Spike B: isolated subscription-only Claude and Codex profiles under hostile ambient env",
    tier: "T0-evidence",
    anchors: ["§9.1 Accounts", "§10.4 Billing guard", "§27.4 Secrets and logs"],
    outcome:
      "A reproducible isolation recipe proves Claude Code and Codex use named subscription credentials even when the parent environment contains conflicting API keys and credentials.",
    constraints: [
      "Use dedicated temporary config homes and an allowlisted environment.",
      "Prove billing route from provider-visible identity or CLI diagnostics, not process exit alone.",
    ],
    exclusions: [
      "No metered API request.",
      "No copying the user's general-purpose credential stores into test fixtures.",
    ],
    acceptance: [
      "Claude runs with Max/subscription auth and no ANTHROPIC_API_KEY exposure.",
      "Codex runs with saved ChatGPT auth and no OPENAI_API_KEY or CODEX_API_KEY exposure.",
      "Hostile ambient keys, config precedence, expiry, and logout paths have regression coverage.",
    ],
    tests: [
      "Hostile-environment matrix with sentinel credentials.",
      "Credential expiry and revocation canaries.",
    ],
    evidence: ["Redacted environment diff.", "Billing-route attestation and canary transcripts."],
  },
  {
    id: "Q005",
    milestone: "M1",
    title: "Implement global application-home resolution, YAML layers and secret-store abstraction",
    tier: "T1-foundation",
    anchors: ["§7 Global application home", "§8 Configuration model", "§27.4 Secrets and logs"],
    outcome:
      "Heniek resolves one global application home, loads validated YAML configuration layers with deterministic precedence, and accesses secrets through a platform-neutral abstraction.",
    constraints: [
      "Honor HENIEK_HOME, Linux XDG settings, then the `.heniek` fallback exactly.",
      "Keep secrets out of YAML, logs, snapshots, and repository-local state.",
    ],
    exclusions: ["No runtime database schema.", "No cloud secret manager integration in v1."],
    acceptance: [
      "Resolution is deterministic on macOS and Linux and rejects invalid relative overrides.",
      "Configuration diagnostics identify source layer, winning value, and material conflicts.",
      "Secret-store adapters include secure file fallback and test doubles with restrictive permissions.",
    ],
    tests: [
      "Cross-platform path/preference table tests.",
      "YAML merge, conflict, permission, and secret-redaction tests.",
    ],
    evidence: [
      "Resolved-config diagnostic snapshot.",
      "Filesystem permission evidence on both platforms.",
    ],
  },
  {
    id: "Q006",
    milestone: "M1",
    title: "Implement SQLite migrations, canonical projections and append-only event journal",
    tier: "T1-foundation",
    anchors: ["§16.1 One canonical state per run", "§16.2 Hybrid mutability", "§16.3 Storage"],
    outcome:
      "Built-in Node SQLite stores versioned migrations, transactional current projections, and an append-only event journal from which audited state can be reconstructed.",
    constraints: [
      "Migrations are append-only and forward-tested.",
      "Event ordering and projection updates share one transaction.",
    ],
    exclusions: [
      "No provider transcript storage policy beyond references.",
      "No distributed database or remote coordination.",
    ],
    acceptance: [
      "Fresh, upgraded, interrupted, and rolled-forward databases produce the same canonical schema.",
      "Every mutable projection change has an immutable causative event and correlation IDs.",
      "Rebuild tooling detects divergence between journal replay and stored projections.",
    ],
    tests: [
      "Migration fixture matrix across every schema version.",
      "Crash-at-transaction-boundary and journal replay property tests.",
    ],
    evidence: ["Schema and migration manifest.", "Deterministic replay report."],
  },
  {
    id: "Q007",
    milestone: "M1",
    title: "Implement immutable artifacts and transactional stage completion",
    tier: "T1-foundation",
    anchors: [
      "§4.4 Artifact before completion state",
      "§16.2 Hybrid mutability",
      "§16.6 Transactional stage completion",
    ],
    outcome:
      "Immutable, content-addressed artifacts are durably written and validated before a stage completion transaction can release dependent work.",
    constraints: [
      "Use atomic file publication plus SQLite metadata transaction.",
      "Preserve media type, schema version, producer, and source lineage.",
    ],
    exclusions: ["No artifact interpretation by downstream models.", "No remote artifact store."],
    acceptance: [
      "A successful stage cannot reference a missing, partial, or schema-invalid artifact.",
      "Retries create new immutable attempts without mutating earlier artifacts.",
      "Crash recovery removes or classifies orphan temporary files without losing committed data.",
    ],
    tests: [
      "Fault injection before and after each durability boundary.",
      "Content hash, immutability, and concurrent-reader tests.",
    ],
    evidence: ["Transactional sequence test trace.", "Artifact inventory with verified hashes."],
  },
  {
    id: "Q008",
    milestone: "M1",
    title: "Implement daemon single-instance lifecycle, local authentication and crash recovery",
    tier: "T1-foundation",
    anchors: [
      "§6.1 Local daemon",
      "§6.3 Local transports and authentication",
      "§18 Durability and recovery",
    ],
    outcome:
      "The `heniek` daemon enforces a single authenticated local instance, owns durable work independently of clients, and reconciles state after clean or unclean shutdown.",
    constraints: [
      "Use restrictive runtime-file permissions and rotating local credentials.",
      "Never infer provider-process survival without reconciliation.",
    ],
    exclusions: [
      "No remote daemon access.",
      "No promise to resurrect every provider process after reboot.",
    ],
    acceptance: [
      "Concurrent starts converge on one healthy instance and stale PID/socket files recover safely.",
      "Unauthenticated or replayed clients cannot call daemon methods.",
      "Restart classification distinguishes resumable, failed, cancelled, and unknown external work.",
    ],
    tests: [
      "Parallel-start, stale-file, auth replay, SIGTERM, and SIGKILL tests.",
      "Recovery tests against deterministic backend handles.",
    ],
    evidence: ["Lifecycle state-transition trace.", "Permission and authentication test report."],
  },
  {
    id: "Q009",
    milestone: "M1",
    title: "Implement Unix-socket JSON-RPC and minimal CLI handshake/status",
    tier: "T1-foundation",
    anchors: [
      "§6.2 Client surfaces",
      "§6.3 Local transports and authentication",
      "§22 ExecutionBackend abstraction",
    ],
    outcome:
      "An authenticated JSON-RPC 2.0 server over the daemon Unix socket and a minimal `heniek` CLI provide version negotiation, health, status, and machine-readable errors.",
    constraints: [
      "Frame requests unambiguously and cap payload size.",
      "Version protocol methods independently from domain contracts.",
    ],
    exclusions: ["No TUI, MCP facade, or full operational command set.", "No TCP fallback."],
    acceptance: [
      "CLI discovers the resolved socket and performs authenticated protocol negotiation.",
      "Malformed, oversized, unauthorized, unknown, and cancelled requests return stable JSON-RPC errors.",
      "Human and JSON output modes expose daemon, schema, and compatibility status.",
    ],
    tests: [
      "Protocol framing and error-code table tests.",
      "Real socket concurrent-client and disconnect integration tests.",
    ],
    evidence: [
      "JSON-RPC compatibility fixture.",
      "CLI handshake transcript with secrets redacted.",
    ],
  },
  {
    id: "Q010",
    milestone: "M1",
    title: "Implement Codebase detection, registration and instruction-conflict reporting",
    tier: "T1-foundation",
    anchors: [
      "§11 Codebases and repositories",
      "§4.5 Whole-Codebase reasoning",
      "§8.2 Configuration layers",
    ],
    outcome:
      "Heniek detects one or more repositories, registers a logical Codebase, discovers native agent instructions, and reports material precedence conflicts before execution.",
    constraints: [
      "Treat source-issue repository as provenance, not authority.",
      "Preserve instruction sources and hashes for every run.",
    ],
    exclusions: [
      "No composite workspace provisioning.",
      "No automatic semantic resolution of material instruction conflicts.",
    ],
    acceptance: [
      "Single-root and multi-root detection produce stable Codebase and repository IDs.",
      "Registration records remotes, default branches, paths, and instruction provenance.",
      "Conflict diagnostics distinguish additive guidance from incompatible requirements.",
    ],
    tests: [
      "Repository topology and remote normalization fixtures.",
      "Instruction precedence and conflict-classifier tests.",
    ],
    evidence: ["Registered-Codebase snapshot.", "Conflict report fixture with source anchors."],
  },
  {
    id: "Q011",
    milestone: "M1",
    title: "Implement single-repository workspace provisioning, base sync and writer leases",
    tier: "T1-foundation",
    anchors: ["§12 Workspace model", "§21.1 Single-repository epic", "§18 Durability and recovery"],
    outcome:
      "A managed single-repository workspace is provisioned from a fetched remote base SHA, configured reproducibly, and protected by renewable one-writer leases.",
    constraints: [
      "Never build from an unverified stale local branch.",
      "Lease ownership and expected SHA are durable and auditable.",
    ],
    exclusions: [
      "No multi-root workspace or variant integration.",
      "No forced cleanup of unclassified user changes.",
    ],
    acceptance: [
      "Provisioning records remote base, setup result, checkout path, and cleanliness.",
      "Base-sync policy implements notify, rebase/recreate, and fail-safe behavior as configured.",
      "Expired leases recover without allowing two live writers to the same checkout.",
    ],
    tests: [
      "Remote-advance and dirty-checkout integration tests.",
      "Concurrent lease acquisition, renewal, expiry, and recovery tests.",
    ],
    evidence: ["Workspace provisioning manifest.", "Lease contention trace."],
  },
  {
    id: "Q012",
    milestone: "M1",
    title: "Deliver one external Claudexor stage end-to-end with restart and doctor tests",
    tier: "T2-capability",
    anchors: [
      "§18 Durability and recovery",
      "§22 ExecutionBackend abstraction",
      "§23 Claudexor integration",
    ],
    outcome:
      "One external agent stage runs through the Claudexor `/v2` adapter from CLI request to validated artifact and durable completion, including daemon restart and diagnostics.",
    constraints: [
      "Pin the managed Claudexor build.",
      "Use subscription-only credentials established by Q004.",
    ],
    exclusions: ["No generalized pipeline graph.", "No second provider or native Claude path."],
    acceptance: [
      "Start, observe, question/answer, resume, cancel, result, and artifact retrieval map into Heniek contracts.",
      "Daemon restart reconciles the active handle without duplicate execution.",
      "`heniek doctor` identifies runtime, auth-route, compatibility, and cleanup failures.",
    ],
    tests: [
      "Fake-backend deterministic vertical test.",
      "Opt-in real Claude conformance and daemon-restart test.",
    ],
    evidence: ["End-to-end run export.", "Doctor report and redacted Claudexor event trace."],
  },
  {
    id: "Q013",
    milestone: "M2",
    title: "Implement managed, pinned and replaceable Claudexor runtime lifecycle",
    tier: "T2-capability",
    anchors: ["§23.2 Integration surface", "§23.3 Managed dependency", "§23.4 Maturity posture"],
    outcome:
      "Heniek installs, verifies, activates, upgrades, rolls back, and optionally adopts an external Claudexor runtime without coupling domain state to it.",
    constraints: [
      "Verify release identity and checksum before activation.",
      "Run compatibility tests before changing the active pin.",
    ],
    exclusions: [
      "No source import or runtime fetch from an unpinned branch.",
      "No silent automatic upgrade.",
    ],
    acceptance: [
      "Managed runtimes coexist by version under HENIEK_HOME and activation is atomic.",
      "External mode reports exact binary/version and passes the same compatibility gate.",
      "Failed install or promotion preserves the previous working runtime.",
    ],
    tests: [
      "Checksum mismatch, interrupted install, activation, rollback, and external-mode tests.",
      "Pinned `/v2` compatibility suite.",
    ],
    evidence: ["Runtime inventory and checksum report.", "Promotion/rollback conformance record."],
  },
  {
    id: "Q014",
    milestone: "M2",
    title: "Implement accounts, workers, roles, profiles and effort resolution",
    tier: "T2-capability",
    anchors: [
      "§9 Accounts, workers, roles, and profiles",
      "§8 Configuration model",
      "§10.1 v1 engines",
    ],
    outcome:
      "Named accounts, workers, roles, and profiles resolve deterministically into an auditable execution request with validated effort and override policy.",
    constraints: [
      "Accounts select explicit credential identities.",
      "Invocation overrides are allowlisted and precedence is visible.",
    ],
    exclusions: [
      "No automatic account pooling or quota rotation.",
      "No provider-specific fields in public profile contracts.",
    ],
    acceptance: [
      "Layered configuration resolves worker, role, engine, account, model, effort, and execution mode.",
      "Invalid engine/model/effort combinations fail before workspace mutation.",
      "Resolved profiles retain source provenance and a stable redacted fingerprint.",
    ],
    tests: [
      "Configuration precedence and override matrix.",
      "Cross-engine capability/effort validation table tests.",
    ],
    evidence: ["Resolved-profile snapshots.", "Invalid-combination diagnostics."],
  },
  {
    id: "Q015",
    milestone: "M2",
    title: "Implement capability catalogue, engine readiness and model discovery",
    tier: "T2-capability",
    anchors: [
      "§10 Engine and capability management",
      "§19.4 Model selection",
      "§23.5 Required compatibility tests",
    ],
    outcome:
      "A durable capability catalogue reports installed engines, authenticated accounts, supported models/features, and readiness without guessing from configuration.",
    constraints: [
      "Discovery results are timestamped and tied to engine/account/version.",
      "Stale or partial discovery must be explicit.",
    ],
    exclusions: [
      "No model recommendation service.",
      "No automatic installation or credential change.",
    ],
    acceptance: [
      "Catalogue distinguishes configured, installed, authenticated, compatible, rate-limited, and ready.",
      "Model and feature discovery normalize questions, resume, usage, effort, and tool capabilities.",
      "Selection errors explain which required capability is absent.",
    ],
    tests: [
      "Discovery normalization fixtures per engine.",
      "Staleness, partial failure, and capability-selection tests.",
    ],
    evidence: ["Capability matrix artifact.", "Doctor readiness output for all three engines."],
  },
  {
    id: "Q016",
    milestone: "M2",
    title: "Implement external Claude execution and profile adapter",
    tier: "T2-capability",
    anchors: [
      "§9.5 Native and external Claude modes",
      "§22 ExecutionBackend abstraction",
      "§23 Claudexor integration",
    ],
    outcome:
      "External Claude Code profiles execute through Claudexor with subscription auth, durable sessions, normalized events, interactions, cancellation, and resume.",
    constraints: [
      "Never use bare mode or API-key billing.",
      "Preserve Claude session identity without leaking raw provider payloads.",
    ],
    exclusions: [
      "No native Claude Agent-tool path.",
      "No Claude-specific fields in pipeline state.",
    ],
    acceptance: [
      "Named Claude account/model/effort resolves and runs non-interactively.",
      "Questions, rate limits, context pressure, cancellation, and resume map to public contracts.",
      "Process trees and temporary credentials are cleaned after every terminal state.",
    ],
    tests: [
      "Deterministic adapter fixtures and conformance suite.",
      "Opt-in subscription run, resume, rate-limit, and cleanup canaries.",
    ],
    evidence: ["Redacted execution trace and auth-route proof.", "Backend conformance report."],
  },
  {
    id: "Q017",
    milestone: "M2",
    title: "Implement Codex execution and profile adapter",
    tier: "T2-capability",
    anchors: [
      "§10.1 v1 engines",
      "§22 ExecutionBackend abstraction",
      "§23.5 Required compatibility tests",
    ],
    outcome:
      "Codex CLI profiles execute through the replaceable backend boundary using saved ChatGPT authentication, normalized sessions, results, usage, cancellation, and resume.",
    constraints: [
      "Scrub OPENAI_API_KEY and CODEX_API_KEY.",
      "Record exact Codex version and selected model/effort.",
    ],
    exclusions: [
      "No OpenAI API billing fallback.",
      "No parsing of unstable prose when structured output exists.",
    ],
    acceptance: [
      "Headless execution and resume pass the shared conformance lifecycle.",
      "Structured output, tool events, diffs, usage, errors, and cancellation normalize deterministically.",
      "Auth-route failure blocks before model work begins.",
    ],
    tests: [
      "Recorded structured-output and error fixtures.",
      "Opt-in ChatGPT-auth headless/resume and process-cleanup canaries.",
    ],
    evidence: ["Codex conformance report.", "Redacted auth and session-resume trace."],
  },
  {
    id: "Q018",
    milestone: "M2",
    title: "Spike C and implement Cursor execution and profile adapter",
    tier: "T0-evidence",
    anchors: [
      "§10.1 v1 engines",
      "§22 ExecutionBackend abstraction",
      "§23.5 Required compatibility tests",
    ],
    outcome:
      "A spike establishes Cursor CLI's current print/JSON/session semantics, followed by a production adapter that satisfies the shared execution contract with subscription login.",
    constraints: [
      "Pin and report the discovered Cursor CLI build.",
      "Remove CURSOR_API_KEY from the execution environment.",
    ],
    exclusions: [
      "No undocumented provider payload in Heniek state.",
      "No implementation before spike evidence resolves resume semantics.",
    ],
    acceptance: [
      "ADR records headless, JSON, session, resume, questions, usage, cancellation, and error behavior.",
      "Adapter passes shared conformance or documents bounded compatibility shims.",
      "Login identity, session reuse, and process cleanup are verifiable.",
    ],
    tests: [
      "CLI mode matrix and recorded-output fixtures.",
      "Opt-in subscription headless/resume/cancel canaries.",
    ],
    evidence: ["Cursor spike ADR with exact build.", "Backend conformance and auth-route reports."],
  },
  {
    id: "Q019",
    milestone: "M2",
    title: "Spike D: normalize context, usage and native-session telemetry",
    tier: "T0-evidence",
    anchors: [
      "§15.3 Smart continuation",
      "§23.5 Required compatibility tests",
      "§31 Product metrics and local evaluation",
    ],
    outcome:
      "An ADR defines truthful cross-engine context, usage, cache, duration, session, and native-stage telemetry, including confidence and unavailable values.",
    constraints: [
      "Never fabricate token/context precision.",
      "Retain raw evidence by reference while exposing provider-neutral metrics.",
    ],
    exclusions: ["No fixed token-reduction claim.", "No telemetry upload or cloud analytics."],
    acceptance: [
      "Claude, Codex, Cursor, and native Claude fields map to a versioned normalized schema.",
      "Exact, estimated, and unavailable metrics are distinguishable.",
      "Continuation policy can consume conservative context-pressure signals.",
    ],
    tests: [
      "Recorded telemetry fixture matrix.",
      "Missing, contradictory, overflow, and counter-reset tests.",
    ],
    evidence: ["Telemetry normalization ADR.", "Cross-engine metric coverage table."],
  },
  {
    id: "Q020",
    milestone: "M2",
    title: "Implement durable interactions, inbox, answer and resume",
    tier: "T2-capability",
    anchors: [
      "§17 Interactions and questions",
      "§18.1 Parent independence",
      "§25 Notifications and inbox",
    ],
    outcome:
      "Questions and approvals become durable interactions that appear in one inbox, accept validated answers exactly once, and resume the correct suspended execution.",
    constraints: [
      "Persist interaction before notifying.",
      "Use optimistic state/version checks for answers and resumes.",
    ],
    exclusions: [
      "No notification provider beyond internal events.",
      "No model-authored answer on behalf of a human in HITL mode.",
    ],
    acceptance: [
      "Free-text, single-choice, and multiple-choice interactions have stable lifecycle states.",
      "Duplicate, stale, unauthorized, and post-cancellation answers are rejected safely.",
      "Parent disconnect and daemon restart do not lose or duplicate a pending interaction.",
    ],
    tests: [
      "Interaction state-machine property tests.",
      "Concurrent answer, restart, cancel, and resume integration tests.",
    ],
    evidence: ["Inbox lifecycle trace.", "Exported run showing durable question provenance."],
  },
  {
    id: "Q021",
    milestone: "M2",
    title: "Implement account queues, concurrency, fallback chains and permissions",
    tier: "T2-capability",
    anchors: [
      "§9.6 Concurrency and queues",
      "§9.7 Execution permissions",
      "§24 Limits, retries, and safeguards",
    ],
    outcome:
      "Per-account queues, concurrency leases, explicit fallback chains, and broad-but-bounded workspace permissions schedule work without credential races or silent provider substitution.",
    constraints: [
      "Fallback order is configuration, not model choice.",
      "The strictest applicable limit wins.",
    ],
    exclusions: [
      "No automatic quota-based account rotation.",
      "No fine-grained per-tool permission DSL.",
    ],
    acceptance: [
      "Account concurrency is enforced across runs and survives restart.",
      "Fallback occurs only for classified eligible failures and records why each candidate was selected or rejected.",
      "Execution permissions cannot escape the assigned workspace or secret allowlist.",
    ],
    tests: [
      "Fairness, starvation, lease expiry, and fallback classification tests.",
      "Workspace escape and disallowed-secret integration tests.",
    ],
    evidence: ["Queue/fallback decision trace.", "Isolation test report."],
  },
  {
    id: "Q022",
    milestone: "M2",
    title: "Implement subscription billing guard, env scrubbing, redaction and process cleanup",
    tier: "T2-capability",
    anchors: [
      "§10.4 Billing guard",
      "§27 Security and privacy",
      "§23.5 Required compatibility tests",
    ],
    outcome:
      "A fail-closed guard verifies subscription routes, constructs a minimal environment, redacts sensitive data, and enforces the strongest lifecycle and process-cleanup evidence exposed by the versioned execution backend.",
    constraints: [
      "API-key variables are denied by default for subscription profiles.",
      "Secrets are never written to artifacts, exports, or diagnostics.",
    ],
    exclusions: [
      "No metered fallback.",
      "No broad inheritance of host environment or credential directories.",
    ],
    acceptance: [
      "Claude, Codex, and Cursor subscription profiles report a verified billing route before work.",
      "Known key names, token shapes, URLs, headers, and provider payloads are redacted.",
      "Success, failure, cancellation, and timeout settle only through the backend lifecycle; a cancellation acknowledgement alone is never treated as completion.",
      "Backend-disclosed unconfirmed termination and daemon-interrupted attempts map fail-closed to RECOVERY_REQUIRED, retain fenced capacity while execution may still exist, and are never silently retried.",
      "Process cleanup evidence is reported at the strength exposed by the versioned backend contract; Heniek never fabricates a tree-empty attestation from terminal status or an absent optional diagnostic.",
    ],
    tests: [
      "Hostile-env and redaction corpus tests.",
      "Cancellation-settlement, interrupted-recovery, and credential-revocation tests.",
      "An opt-in pinned-backend orphan-process compatibility scan, explicitly reported as indicative unless the backend exposes a versioned positive attestation.",
    ],
    evidence: [
      "Billing guard attestation.",
      "Redaction report and an honestly qualified orphan-process compatibility scan.",
    ],
  },
  {
    id: "Q023",
    milestone: "M2",
    title: "Spike G and implement the native Claude bridge",
    tier: "T0-evidence",
    anchors: [
      "§6 System architecture",
      "§9.5 Native and external Claude modes",
      "§18.3 Native stage boundary",
    ],
    outcome:
      "A session-bound bridge lets the Claude plugin dispatch native Agent-tool work and submit validated results to the daemon while explicitly handling parent absence.",
    constraints: [
      "The daemon never pretends it can invoke the Agent tool independently.",
      "Native results pass the same stage contract as external execution.",
    ],
    exclusions: [
      "No hidden dependence on one parent transcript.",
      "No automatic conversion of a native stage to external execution without configured fallback.",
    ],
    acceptance: [
      "ADR proves dispatch, question mediation, result submission, disconnect, reconnect, and cancellation semantics.",
      "Absent parent transitions the stage to WAITING_FOR_PARENT_SESSION.",
      "Rebinding cannot submit a result to the wrong run/stage/attempt.",
    ],
    tests: [
      "Bridge token, replay, reconnect, and stale-attempt tests.",
      "Plugin-to-daemon native-stage integration canary.",
    ],
    evidence: [
      "Native bridge ADR and sequence trace.",
      "Conformance result against stage lifecycle.",
    ],
  },
  {
    id: "Q024",
    milestone: "M3",
    title: "Implement YAML pipeline schema, parser and diagnostics",
    tier: "T1-foundation",
    anchors: [
      "§8 Configuration model",
      "§14.1 Arbitrary declarative graph",
      "§14.3 Illustrative stage definition",
    ],
    outcome:
      "Versioned YAML pipeline definitions parse into provider-neutral graph contracts with source-located diagnostics and deterministic normalized output.",
    constraints: [
      "Accept only the documented restricted YAML subset.",
      "Require fixed v1 stage types and explicit schema version.",
    ],
    exclusions: ["No scheduler or stage execution.", "No runtime plugin API for new stage types."],
    acceptance: [
      "Parser validates nodes, edges, profiles, conditions, policies, limits, modes, and outputs.",
      "Diagnostics identify file, path, line/column, violated rule, and suggested correction.",
      "Equivalent YAML normalizes to byte-identical graph JSON.",
    ],
    tests: [
      "Golden valid/invalid pipeline corpus.",
      "Parser fuzzing and canonicalization property tests.",
    ],
    evidence: ["Generated pipeline JSON Schema.", "Diagnostic corpus snapshot."],
  },
  {
    id: "Q025",
    milestone: "M3",
    title: "Implement deterministic graph scheduling and the fixed stage state machine",
    tier: "T1-foundation",
    anchors: [
      "§14 Pipeline model",
      "§16 Canonical run state and artifacts",
      "§20.2 Task-level DAG",
    ],
    outcome:
      "A pure deterministic scheduler computes eligible stages and transitions for agent, command, approval, integration, verify, and publish nodes.",
    constraints: [
      "Scheduling decisions depend only on canonical state and time inputs.",
      "Persist decisions before dispatching side effects.",
    ],
    exclusions: [
      "No stage-specific runner implementation.",
      "No model-driven control-flow mutation.",
    ],
    acceptance: [
      "State machine covers pending, ready, queued, running, waiting, retrying, succeeded, failed, cancelled, and blocked outcomes.",
      "Parallel eligibility, fan-in, cancellation, retry, and terminal-run computation are deterministic.",
      "Duplicate ticks and restart replay cannot dispatch the same attempt twice.",
    ],
    tests: [
      "State-transition and graph property tests.",
      "Randomized replay/idempotency tests with fake time.",
    ],
    evidence: ["State-machine table and generated diagram data.", "Seeded scheduler replay log."],
  },
  {
    id: "Q026",
    milestone: "M3",
    title: "Implement agent and command stage runners",
    tier: "T2-capability",
    anchors: [
      "§14.2 First-class stage types",
      "§19.5 Stage completion contract",
      "§24 Limits, retries, and safeguards",
    ],
    outcome:
      "Agent and command runners execute in isolated workspace variants, emit contract-valid artifacts/results, and obey cancellation, timeout, and evidence requirements.",
    constraints: [
      "Commands use explicit argv/cwd/env without shell interpolation by default.",
      "Agent runs resolve one approved profile and backend request.",
    ],
    exclusions: [
      "No approval, integration, verify, or publish behavior.",
      "No unbounded background process.",
    ],
    acceptance: [
      "Both runners implement prepare, start, observe, cancel, collect, validate, and finalize phases.",
      "Timeout or cancellation kills descendants and leaves a recoverable attempt record.",
      "Success requires declared outputs and verification evidence, not exit code alone.",
    ],
    tests: [
      "Runner lifecycle and fault-injection contract tests.",
      "Command quoting/env and agent-backend integration tests.",
    ],
    evidence: ["Stage attempt export for each runner.", "Cleanup and evidence-validation report."],
  },
  {
    id: "Q027",
    milestone: "M3",
    title: "Implement approval, integration, verify and publish stage runners",
    tier: "T2-capability",
    anchors: [
      "§14.2 First-class stage types",
      "§19 Review and verification",
      "§21 Git branch and delivery model",
    ],
    outcome:
      "The remaining fixed stage runners provide durable human gates, expected-SHA integration, independent verification, and ForgeBackend publication.",
    constraints: [
      "Approval waits durably; it never auto-answers in HITL mode.",
      "Integration and publish operations are idempotent and reconcile external state.",
    ],
    exclusions: ["No GitHub-specific logic outside adapters.", "No automatic post-v1 CI watcher."],
    acceptance: [
      "Approval records prompt, decision, actor, revision, and continuation.",
      "Integration verifies source/base SHAs and classifies conflicts without partial success claims.",
      "Verify and publish require explicit contracts and recover adopted external resources after restart.",
    ],
    tests: [
      "Per-runner lifecycle and idempotency suites.",
      "Stale SHA, conflict, rejected approval, duplicate publish, and restart tests.",
    ],
    evidence: [
      "Runner conformance matrix.",
      "Reconciliation traces for integration and publication.",
    ],
  },
  {
    id: "Q028",
    milestone: "M3",
    title: "Implement conditions, retry/session policy, limits and bounded repair",
    tier: "T2-capability",
    anchors: [
      "§14.4 Conditional transitions",
      "§19.6 Validation failure policy",
      "§24 Limits, retries, and safeguards",
    ],
    outcome:
      "Conditions, layered limits, fresh/resumed retry policy, failure classification, and bounded repair produce deterministic, auditable recovery decisions.",
    constraints: [
      "The strictest hard limit wins.",
      "Repair attempts consume explicit budgets and cannot loop on unchanged evidence.",
    ],
    exclusions: [
      "No heuristic infinite retry.",
      "No fallback for security or contract violations.",
    ],
    acceptance: [
      "Conditions evaluate against validated result/state fields with no arbitrary code execution.",
      "Retry policy distinguishes transient, provider, validation, conflict, security, and terminal failures.",
      "Repeated unchanged failure signatures block after the configured bound.",
    ],
    tests: [
      "Condition truth-table and limit precedence property tests.",
      "Retry/failure-signature/repair budget scenario tests.",
    ],
    evidence: ["Decision trace showing every retry input.", "Bounded-repair exhaustion fixture."],
  },
  {
    id: "Q029",
    milestone: "M3",
    title: "Implement segment fusion, smart continuation, capsules and incoming verification",
    tier: "T2-capability",
    anchors: [
      "§15 Logical stages and execution segments",
      "§19.3 Fresh review context",
      "§31 Product metrics and local evaluation",
    ],
    outcome:
      "Compatible adjacent stages share provider sessions, context pressure triggers a validated continuation capsule, and fresh segments verify incoming state before proceeding.",
    constraints: [
      "Logical artifacts remain durable boundaries even inside one segment.",
      "Continuation is conservative when telemetry confidence is low.",
    ],
    exclusions: [
      "No cross-profile session fusion.",
      "No raw transcript as the downstream contract.",
    ],
    acceptance: [
      "Fusion eligibility accounts for profile, permissions, workspace, review posture, and retry policy.",
      "Capsules contain bounded context, artifact references, unresolved risks, and exact continuation state.",
      "Incoming verification detects stale workspace, missing artifacts, and contradictory handoff claims.",
    ],
    tests: [
      "Fusion matrix and context-threshold tests.",
      "Capsule schema, truncation, tamper, and incoming-verification tests.",
    ],
    evidence: ["Fused versus split execution trace.", "Validated continuation capsule example."],
  },
  {
    id: "Q030",
    milestone: "M3",
    title: "Ship the bundled fast pipeline",
    tier: "T2-capability",
    anchors: ["§14.6 Bundled pipelines", "§30.1 `fast`", "§19.5 Stage completion contract"],
    outcome:
      "A versioned bundled `fast` YAML pipeline implements the specified lightweight path with explicit artifacts, checks, and bounded repair.",
    constraints: [
      "Use only fixed stage types and public profile names.",
      "Bundled content is overrideable without mutating the installed template.",
    ],
    exclusions: [
      "No careful critic/reviewer fan-out.",
      "No weakening of required tests or evidence.",
    ],
    acceptance: [
      "The template parses, normalizes, and passes pipeline conformance.",
      "A deterministic fake run reaches publication and exercises one repair.",
      "Documentation states intended use, tradeoffs, stage artifacts, and overrides.",
    ],
    tests: [
      "Golden schema and normalized-graph tests.",
      "End-to-end fake-backend fast-pipeline scenario.",
    ],
    evidence: ["Bundled YAML and normalized hash.", "Successful run export with repair trace."],
  },
  {
    id: "Q031",
    milestone: "M3",
    title: "Ship the careful pipeline using accepted predecessor review semantics",
    tier: "T2-capability",
    anchors: [
      "§19 Review and verification",
      "§30.2 `careful`",
      "§32 Development-time reference extraction charter",
    ],
    outcome:
      "A bundled `careful` pipeline preserves accepted predecessor critic, reviewer, verifier, evidence, and repair invariants through Heniek-native contracts.",
    constraints: [
      "Document each extracted invariant and rejected complexity.",
      "Review uses fresh posture/context and structured findings plus Markdown.",
    ],
    exclusions: [
      "No predecessor runtime dependency or giant role roster.",
      "No mandatory cross-provider diversity.",
    ],
    acceptance: [
      "Design critique, plan validation, implementation, code review, repair, and final verification have explicit artifacts.",
      "Findings carry severity, evidence, disposition, and verification state.",
      "A full fake run proves accepted/rejected findings and bounded repair.",
    ],
    tests: [
      "Pipeline conformance and finding-schema tests.",
      "Careful end-to-end scenario with seeded critic/reviewer failures.",
    ],
    evidence: [
      "Extraction record mapping invariants to contracts.",
      "Run export showing findings and repairs.",
    ],
  },
  {
    id: "Q032",
    milestone: "M3",
    title: "Implement one-off graphs, overrides, ad-hoc attachment and pipeline conformance",
    tier: "T2-capability",
    anchors: [
      "§14 Pipeline model",
      "§8.2 Configuration layers",
      "§16.1 One canonical state per run",
    ],
    outcome:
      "Users can validate and run one-off graphs, apply controlled overrides, and attach ad-hoc work to an existing pipeline without bypassing canonical state.",
    constraints: [
      "Overrides are allowlisted, source-traced, and resolved before execution.",
      "Attachment uses optimistic run revision checks.",
    ],
    exclusions: [
      "No mutation of bundled templates.",
      "No attaching completed work without required artifacts.",
    ],
    acceptance: [
      "One-off graphs pass the same schema and conformance checks as named pipelines.",
      "Effective graph and every override are preserved in the run snapshot.",
      "Ad-hoc results attach exactly once and release dependants only after validation.",
    ],
    tests: [
      "Override precedence and forbidden-field tests.",
      "Concurrent/stale attachment and one-off graph conformance tests.",
    ],
    evidence: ["Effective-graph snapshot.", "Attached ad-hoc stage lifecycle trace."],
  },
  {
    id: "Q033",
    milestone: "M4",
    title: "Spike E: prove a ten-repository composite workspace",
    tier: "T0-evidence",
    anchors: [
      "§11.2 Multi-root Codebase",
      "§12.2 Managed composite workspace",
      "§12.6 Provisioning",
    ],
    outcome:
      "A spike provisions, configures, inspects, modifies, verifies, and cleans a realistic ten-repository composite workspace on macOS and Linux.",
    constraints: [
      "Use independent Git repositories and remote base SHAs.",
      "Measure disk, time, process, and failure behavior.",
    ],
    exclusions: [
      "No production multi-root manager until evidence is accepted.",
      "No assumption that the composite root is a Git repository.",
    ],
    acceptance: [
      "All repositories are semantically visible while writes remain repository-scoped.",
      "Setup ordering, partial failure, cancellation, restart, and cleanup are exercised.",
      "ADR selects layout and provisioning mechanics without narrowing ten-repository support.",
    ],
    tests: [
      "Scripted ten-repository fixture on both supported OSes.",
      "Injected clone/setup/disk/cancel/restart failures.",
    ],
    evidence: [
      "Composite workspace manifest and metrics.",
      "Spike ADR with retained fixture and failure traces.",
    ],
  },
  {
    id: "Q034",
    milestone: "M4",
    title: "Implement multi-root Codebase configuration and base pins",
    tier: "T2-capability",
    anchors: [
      "§11.2 Multi-root Codebase",
      "§12.3 Base resolution",
      "§12.4 Active-base synchronization",
    ],
    outcome:
      "A Codebase can configure multiple independent repositories, provisioning strategies, setup commands, and immutable remote base pins.",
    constraints: [
      "Repository IDs and remotes are unique within a Codebase.",
      "Base pins are resolved before task execution.",
    ],
    exclusions: ["No composite checkout creation.", "No cross-repository atomicity claim."],
    acceptance: [
      "Configuration supports managed, current, existing, and custom strategies per repository.",
      "Resolution records requested ref, fetched remote, commit SHA, timestamp, and sync policy.",
      "Missing, ambiguous, moved, or unauthorized repositories fail with source-located diagnostics.",
    ],
    tests: [
      "Multi-root config and repository identity fixtures.",
      "Base resolution, remote movement, and precedence tests.",
    ],
    evidence: ["Resolved multi-root Codebase snapshot.", "Base-pin provenance table."],
  },
  {
    id: "Q035",
    milestone: "M4",
    title: "Implement composite provisioning, repository setup and instruction merge",
    tier: "T2-capability",
    anchors: [
      "§11.4 Repository instructions",
      "§12.2 Managed composite workspace",
      "§12.6 Provisioning",
    ],
    outcome:
      "Heniek materializes a composite workspace, runs repository setup deterministically, and merges global/Codebase/repository/provider instructions with conflict gates.",
    constraints: [
      "Each checkout retains repository ownership and base SHA.",
      "Setup output is redacted and bounded.",
    ],
    exclusions: [
      "No parallel writer variants.",
      "No silent resolution of material instruction conflicts.",
    ],
    acceptance: [
      "Provisioning is restartable and records per-repository phase/state.",
      "Setup dependency ordering, timeouts, and failures are isolated and visible.",
      "Effective instructions preserve source, precedence, hash, and unresolved conflicts.",
    ],
    tests: [
      "Composite success/restart/partial-failure integration tests.",
      "Setup ordering and instruction-merge matrix.",
    ],
    evidence: ["Composite provisioning manifest.", "Effective-instruction report."],
  },
  {
    id: "Q036",
    milestone: "M4",
    title: "Implement isolated variants, one-writer leases and expected-SHA integration",
    tier: "T2-capability",
    anchors: [
      "§12.7 Writer isolation",
      "§12.8 Variant integration",
      "§21 Git branch and delivery model",
    ],
    outcome:
      "Parallel work uses isolated composite variants with per-checkout writer leases, and integration updates refs only when expected SHAs still match.",
    constraints: [
      "One live writer per concrete checkout.",
      "Integration is repository-scoped and replay-safe.",
    ],
    exclusions: ["No task-wave scheduler.", "No force push over unexpected external changes."],
    acceptance: [
      "Variants clone or worktree every declared write target and share read-only context safely.",
      "Lease conflicts block before mutation and recover after verified owner death.",
      "Integration applies prepared commits with expected-SHA guards and classifies conflicts/partial progress.",
    ],
    tests: [
      "Parallel writer and lease recovery stress tests.",
      "Expected-SHA race, conflict, retry, and idempotency tests.",
    ],
    evidence: ["Variant/lease inventory.", "Integration transaction trace."],
  },
  {
    id: "Q037",
    milestone: "M4",
    title: "Implement whole-Codebase analysis and multi-repository tasks",
    tier: "T2-capability",
    anchors: [
      "§4.5 Whole-Codebase reasoning",
      "§11.3 Repository analysis",
      "§20.3 Tasks may span repositories",
    ],
    outcome:
      "Initial analysis sees the entire registered Codebase and may produce one coherent execution task with explicit read/write sets spanning repositories.",
    constraints: [
      "Issue repository is only a weak hint.",
      "Write-set changes require versioned task revision and lease revalidation.",
    ],
    exclusions: [
      "No epic wave scheduling.",
      "No separate plan merely because repositories differ.",
    ],
    acceptance: [
      "Analysis packet exposes all repositories, instructions, base pins, and bounded index data.",
      "Task contracts identify rationale, read set, write set, dependencies, artifacts, and verification across repositories.",
      "Undeclared writes are rejected or trigger controlled replanning.",
    ],
    tests: [
      "Wrong-issue-repository and cross-repository fixture scenarios.",
      "Read/write-set expansion and undeclared-write tests.",
    ],
    evidence: [
      "Whole-Codebase analysis artifact.",
      "Multi-repository task and workspace diff inventory.",
    ],
  },
  {
    id: "Q038",
    milestone: "M4",
    title: "Implement combined verification, cleanup and restart reconciliation",
    tier: "T2-capability",
    anchors: [
      "§19 Review and verification",
      "§20.6 Wave integration",
      "§18 Durability and recovery",
    ],
    outcome:
      "Composite workspaces run repository-local and whole-Codebase verification, reconcile interrupted operations, and clean variants without deleting unclassified work.",
    constraints: [
      "Verification commands and evidence are explicit.",
      "Cleanup requires terminal state and verified artifact/integration ownership.",
    ],
    exclusions: ["No epic task DAG.", "No destructive cleanup of adopted or user-owned checkouts."],
    acceptance: [
      "Combined verification aggregates results without hiding repository-local failures.",
      "Restart reconciles provisioning, setup, leases, processes, artifacts, and integration refs.",
      "Cleanup archives required evidence and preserves any ambiguous checkout for operator action.",
    ],
    tests: [
      "Cross-repository verification fan-in tests.",
      "Kill-at-each-phase reconciliation and cleanup safety tests.",
    ],
    evidence: ["Combined verification report.", "Recovery/cleanup decision trace."],
  },
  {
    id: "Q039",
    milestone: "M5",
    title: "Implement TaskSource, handoffs, snapshots, revisions and hierarchy",
    tier: "T1-foundation",
    anchors: [
      "§13 Task sources and task hierarchy",
      "§16 Canonical run state and artifacts",
      "§4.10 Every decision has provenance",
    ],
    outcome:
      "Versioned TaskSource contracts ingest parent handoffs and external tasks into immutable snapshots, mutable revisions, and explicit tracker/execution hierarchies.",
    constraints: [
      "Preserve verbatim source requirements and source version.",
      "Separate external tracker identity from execution task identity.",
    ],
    exclusions: ["No GitHub adapter.", "No graph scheduling or external issue mutation."],
    acceptance: [
      "Task snapshots retain source URI, content hash, requirements, attachments, and observed version.",
      "Revisions link predecessor, author/reason, diff, and supersession state.",
      "Parent/child tracker hierarchy can differ from execution dependencies without ambiguity.",
    ],
    tests: [
      "Snapshot immutability and revision-chain property tests.",
      "Handoff validation and hierarchy mapping fixtures.",
    ],
    evidence: ["Task snapshot/revision export.", "Requirement traceability matrix."],
  },
  {
    id: "Q040",
    milestone: "M5",
    title: "Implement task DAG validation, wave eligibility and capacity gates",
    tier: "T1-foundation",
    anchors: [
      "§20.2 Task-level DAG",
      "§20.4 Wave eligibility",
      "§24 Limits, retries, and safeguards",
    ],
    outcome:
      "A validated whole-task DAG computes deterministic waves subject to dependencies, workspace conflicts, account capacity, and configured concurrency.",
    constraints: [
      "Tasks, not internal stages, are epic scheduling nodes.",
      "Eligibility is a pure decision over versioned state.",
    ],
    exclusions: ["No task execution.", "No stage-level epic interleaving."],
    acceptance: [
      "Validation rejects cycles, missing nodes, impossible write conflicts, and invalid terminal dependencies.",
      "Wave computation respects dependencies, writer leases, profile/account capacity, and run limits.",
      "Every deferred task has an explicit blocking reason.",
    ],
    tests: [
      "DAG/cycle and topological-order property tests.",
      "Capacity, write-conflict, failure, and cancellation wave fixtures.",
    ],
    evidence: ["Versioned DAG and wave plan.", "Eligibility decision trace."],
  },
  {
    id: "Q041",
    milestone: "M5",
    title: "Implement autonomous graph revision and provenance",
    tier: "T2-capability",
    anchors: [
      "§13.6 Autonomous graph revision",
      "§20.7 Hidden dependency discovery",
      "§4.10 Every decision has provenance",
    ],
    outcome:
      "Analysis may propose versioned task-graph revisions that deterministic validation accepts or rejects with complete requirement and provenance tracking.",
    constraints: [
      "Models propose; deterministic code validates and commits.",
      "Committed/merged task history is immutable.",
    ],
    exclusions: [
      "No silent deletion of source requirements.",
      "No direct model mutation of canonical graph state.",
    ],
    acceptance: [
      "Revisions can add, split, merge, reorder, or supersede unstarted tasks within policy.",
      "Every change records rationale, evidence, requirement mapping, affected waves, and validator decision.",
      "Invalid, stale, or commitment-narrowing revisions are rejected without partial mutation.",
    ],
    tests: [
      "Graph-revision operation and stale-version property tests.",
      "Requirement-loss, cycle, started-task, and policy-violation fixtures.",
    ],
    evidence: ["Before/after graph revision artifact.", "Provenance and validation decision log."],
  },
  {
    id: "Q042",
    milestone: "M5",
    title: "Implement whole-task parallel scheduling and failure propagation",
    tier: "T2-capability",
    anchors: [
      "§20.5 Parallel-wave execution",
      "§20.8 Failure propagation",
      "§24 Limits, retries, and safeguards",
    ],
    outcome:
      "Eligible tasks run their complete internal pipelines in parallel, with durable capacity ownership and explicit dependency-aware failure propagation.",
    constraints: [
      "A task is one schedulable unit even when its internal stages fuse or retry.",
      "No dependent task starts before required predecessor integration/verification.",
    ],
    exclusions: [
      "No cross-machine cluster scheduling.",
      "No opportunistic execution past a blocking required task.",
    ],
    acceptance: [
      "Wave dispatch is idempotent across ticks and daemon restarts.",
      "Task success, retry, failure, cancellation, and blocked states propagate according to edge policy.",
      "Global, account, workspace, and repository capacity are acquired/released without leaks.",
    ],
    tests: [
      "Parallel deterministic fake-backend stress tests.",
      "Kill/restart, failure-propagation, and capacity-leak tests.",
    ],
    evidence: ["Parallel wave timeline.", "Capacity and propagation audit events."],
  },
  {
    id: "Q043",
    milestone: "M5",
    title: "Implement repository epic branches and serialized integration",
    tier: "T2-capability",
    anchors: [
      "§20.6 Wave integration",
      "§21.1 Single-repository epic",
      "§21.2 Multi-repository epic",
    ],
    outcome:
      "Each changed repository receives one epic integration branch, and completed task changes integrate serially with expected-SHA verification.",
    constraints: [
      "Branches and commits remain repository-scoped.",
      "Integration order and observed refs are durable.",
    ],
    exclusions: [
      "No global Git branch or atomic multi-repository merge.",
      "No final PR publication.",
    ],
    acceptance: [
      "Epic branches start from recorded remote base SHAs and are adopted idempotently after restart.",
      "Task commits integrate in deterministic order with combined verification gates.",
      "Unexpected remote/local ref changes stop before overwrite and enter reconciliation.",
    ],
    tests: [
      "Single/multi-repository integration sequence tests.",
      "Concurrent ref movement, conflict, duplicate tick, and restart tests.",
    ],
    evidence: ["Repository integration ledger.", "Expected-SHA and verification trace."],
  },
  {
    id: "Q044",
    milestone: "M5",
    title: "Spike F and implement partial multi-repository reconciliation",
    tier: "T0-evidence",
    anchors: [
      "§21.2 Multi-repository epic",
      "§21.7 Cross-repository delivery",
      "§34 Multi-repository integration cannot be atomic",
    ],
    outcome:
      "A spike defines failure-safe prepare/verify/publish reconciliation when a multi-repository operation partially succeeds, followed by deterministic implementation.",
    constraints: [
      "Never claim cross-repository atomicity.",
      "Use observed external state and expected SHAs, not remembered intent alone.",
    ],
    exclusions: [
      "No destructive rollback of externally consumed commits.",
      "No automatic choice under genuine semantic ambiguity.",
    ],
    acceptance: [
      "ADR enumerates partial integration/publication states and safe forward/compensating actions.",
      "Reconciler reaches a truthful terminal or typed-blocked state after restart.",
      "Repeated reconciliation is idempotent and records every external observation.",
    ],
    tests: [
      "Failure injection after each repository operation.",
      "External mutation, retry, restart, and irreconcilable-state scenarios.",
    ],
    evidence: [
      "Partial-state ADR and state table.",
      "Reconciliation traces for every failure point.",
    ],
  },
  {
    id: "Q045",
    milestone: "M5",
    title: "Implement hidden-dependency replanning and the T1→T2–T5 epic scenario",
    tier: "T3-acceptance",
    anchors: [
      "§20.7 Hidden dependency discovery",
      "§29 v1 end-to-end acceptance scenario",
      "§13.6 Autonomous graph revision",
    ],
    outcome:
      "The runtime discovers a hidden dependency, pauses affected work, revises the task graph, and completes the canonical T1-blocks-T2-through-T5 epic scenario.",
    constraints: [
      "Already integrated evidence is preserved.",
      "Replanning must revalidate requirements, write sets, waves, and capacities.",
    ],
    exclusions: [
      "No GitHub delivery requirement yet.",
      "No fabricated continuation when a technical decision is genuinely ambiguous.",
    ],
    acceptance: [
      "T1 completes before T2–T5 and the latter run in a valid parallel wave.",
      "A seeded hidden dependency produces a versioned graph revision and safe wave recomputation.",
      "Failure, cancellation, retry, question/resume, and combined verification paths remain truthful.",
    ],
    tests: [
      "Full deterministic five-task, three-repository scenario.",
      "Hidden-dependency race and partial-wave failure scenarios.",
    ],
    evidence: [
      "End-to-end run export and task timeline.",
      "Graph revision and requirement traceability report.",
    ],
  },
  {
    id: "Q046",
    milestone: "M6",
    title: "Implement GitHub TaskSource, synchronization and update-conflict handling",
    tier: "T2-capability",
    anchors: [
      "§13.1 TaskSource abstraction",
      "§13.7 GitHub synchronization",
      "§13.8 External materialization policy",
    ],
    outcome:
      "A GitHub TaskSource snapshots issues and synchronizes approved graph/task updates using optimistic concurrency and explicit conflict handling.",
    constraints: [
      "Use least-privilege GitHub credentials.",
      "Preserve source snapshot, ETag/version, and mutation provenance.",
    ],
    exclusions: ["No branch or pull-request operations.", "No automatic overwrite of human edits."],
    acceptance: [
      "Issues, comments/attachments required by contract, hierarchy, labels, and state normalize into TaskSource payloads.",
      "Updates are idempotent and use observed-version guards.",
      "Concurrent human edits produce a mergeable proposal or typed conflict, never silent loss.",
    ],
    tests: [
      "Recorded GitHub API fixtures and contract tests.",
      "Rate limit, pagination, stale ETag, duplicate delivery, and conflict tests.",
    ],
    evidence: [
      "TaskSource conformance report.",
      "Before/after synchronization audit with redacted API trace.",
    ],
  },
  {
    id: "Q047",
    milestone: "M6",
    title: "Implement GitHub ForgeBackend issue, branch and PR primitives",
    tier: "T2-capability",
    anchors: [
      "§21.5 Draft PR default",
      "§21.6 Forge abstraction",
      "§21.7 Cross-repository delivery",
    ],
    outcome:
      "A GitHub ForgeBackend implements idempotent issue, ref, branch, pull-request, and status primitives behind provider-neutral contracts.",
    constraints: [
      "Use expected SHAs and least-privilege tokens.",
      "Default product publication creates draft PRs.",
    ],
    exclusions: [
      "No full delivery workflow or CI repair watcher.",
      "No GitHub DTO leakage into domain state.",
    ],
    acceptance: [
      "Create/read/update/adopt operations return stable external references and observed versions.",
      "Branch creation/update rejects unexpected refs and never force-overwrites by default.",
      "PR primitives support draft state, linkage, base/head identity, checks summary, and mergeability observation.",
    ],
    tests: [
      "ForgeBackend fake and recorded-API conformance suites.",
      "Temporary-repository idempotency, permission, stale-ref, and rate-limit tests.",
    ],
    evidence: ["Forge conformance report.", "Redacted GitHub operation/reconciliation trace."],
  },
  {
    id: "Q048",
    milestone: "M6",
    title: "Implement external materialization and existing branch/PR adoption",
    tier: "T2-capability",
    anchors: [
      "§13.4 Existing branch or PR adoption",
      "§13.8 External materialization policy",
      "§21 Git branch and delivery model",
    ],
    outcome:
      "Task graph nodes can materialize as external issues by policy, and runs can safely adopt compatible existing branches or pull requests.",
    constraints: [
      "Adoption verifies repository, base, head, ownership markers, and commit ancestry.",
      "Materialization records stable bidirectional identity.",
    ],
    exclusions: [
      "No guessing ownership from similar names.",
      "No mutation of incompatible existing work.",
    ],
    acceptance: [
      "Materialization modes none, selected, and all behave deterministically and idempotently.",
      "Existing issue/branch/PR identity survives restart and duplicate discovery.",
      "Ambiguous or incompatible candidates block with actionable evidence.",
    ],
    tests: [
      "Materialization policy and mapping tests.",
      "Adoption success, ambiguity, wrong-base, moved-ref, closed-PR, and restart scenarios.",
    ],
    evidence: ["External identity map.", "Adoption decision report with observed refs."],
  },
  {
    id: "Q049",
    milestone: "M6",
    title: "Implement linked single- and multi-repository draft PR delivery and recovery",
    tier: "T3-acceptance",
    anchors: [
      "§21 Git branch and delivery model",
      "§29 v1 end-to-end acceptance scenario",
      "§34 Multi-repository integration cannot be atomic",
    ],
    outcome:
      "Heniek publishes one linked draft PR per changed repository, reconciles partial publication, and recovers adopted/open delivery after restart.",
    constraints: [
      "Draft is the product default.",
      "Each PR is self-contained and links the parent run plus sibling deliveries without claiming atomicity.",
    ],
    exclusions: [
      "No automatic post-PR CI repair or review-thread handling.",
      "No auto-merge by default.",
    ],
    acceptance: [
      "Single-repository delivery produces one recoverable draft PR from the epic branch.",
      "Multi-repository delivery creates linked PRs with exact base/head SHAs and truthful partial state.",
      "Restart, duplicate invocation, closed/reopened PR, moved branch, and partial API failure reconcile safely.",
    ],
    tests: [
      "Deterministic delivery workflow tests.",
      "Temporary GitHub repository end-to-end single/multi-repo and failure-injection tests.",
    ],
    evidence: [
      "Linked PR delivery manifest.",
      "Recovery traces for every partial publication state.",
    ],
  },
  {
    id: "Q050",
    milestone: "M7",
    title: "Implement Claude MCP/plugin handoff, status, answer and native-stage surface",
    tier: "T2-capability",
    anchors: [
      "§6.2 Client surfaces",
      "§13.2 Parent conversation handoff",
      "§17.3 Native Claude questions",
    ],
    outcome:
      "A Claude Code plugin and MCP facade provide structured handoff, run/status/artifact access, inbox answers, and native-stage dispatch over the authenticated daemon API.",
    constraints: [
      "MCP remains a thin client with no orchestration state.",
      "Bound conversation context and pass artifacts by reference.",
    ],
    exclusions: [
      "No daemon ownership inside Claude hooks.",
      "No mandatory live parent for external stages.",
    ],
    acceptance: [
      "Plugin can create a validated handoff and start/inspect an external run.",
      "MCP tools list status/artifacts/interactions and submit authorized answers.",
      "Native stages bind to the correct parent session and enter waiting state on disconnect.",
    ],
    tests: [
      "MCP schema, auth, and daemon-contract tests.",
      "Claude plugin handoff/native-stage/resume canaries.",
    ],
    evidence: [
      "MCP tool manifest and compatibility report.",
      "Redacted end-to-end plugin session trace.",
    ],
  },
  {
    id: "Q051",
    milestone: "M7",
    title: "Complete deterministic CLI operations",
    tier: "T2-capability",
    anchors: [
      "§6.2 Client surfaces",
      "§25 Notifications and inbox",
      "§26 Retention, backup, and export",
    ],
    outcome:
      "The `heniek` CLI covers setup, Codebases, profiles, pipelines, runs, interactions, recovery, diagnostics, logs, backup, and export with stable JSON output.",
    constraints: [
      "CLI is a thin JSON-RPC client.",
      "Every mutating command supports clear confirmation/idempotency semantics.",
    ],
    exclusions: [
      "No unique orchestration logic.",
      "No output that depends on terminal color or prose for automation.",
    ],
    acceptance: [
      "All specified operational actions are discoverable and documented.",
      "JSON output has versioned envelopes and stable exit-code classes.",
      "Cancellation, retries, stale revisions, missing daemon, and incompatible versions produce actionable errors.",
    ],
    tests: [
      "Command/exit-code golden tests.",
      "Real daemon CLI lifecycle and shell-completion tests on macOS/Linux.",
    ],
    evidence: ["CLI command matrix.", "Machine-readable end-to-end transcript."],
  },
  {
    id: "Q052",
    milestone: "M7",
    title: "Implement the operational TUI",
    tier: "T2-capability",
    anchors: [
      "§6.2 Client surfaces",
      "§17.4 Durable inbox and notifications",
      "§25 Notifications and inbox",
    ],
    outcome:
      "An Ink-based operational TUI shows active runs, stages, workers, logs, artifacts, and inbox items and performs authorized start/cancel/retry/resume/answer actions.",
    constraints: [
      "Use the same JSON-RPC contracts as CLI/MCP.",
      "Remain usable over SSH and narrow terminals.",
    ],
    exclusions: [
      "No graph editor or web-dashboard duplication.",
      "No hidden orchestration state in the UI process.",
    ],
    acceptance: [
      "Reconnect and daemon restart preserve view consistency without duplicate mutations.",
      "Keyboard navigation, confirmation, resize, color fallback, and accessibility labels are documented/tested.",
      "Pending interactions can be answered with revision-safe feedback.",
    ],
    tests: [
      "Ink component/state tests with deterministic event streams.",
      "Pseudo-terminal reconnect, resize, keyboard, and SSH smoke tests.",
    ],
    evidence: [
      "TUI interaction recording/screenshots.",
      "Accessibility and terminal-compatibility report.",
    ],
  },
  {
    id: "Q053",
    milestone: "M7",
    title: "Implement authenticated localhost HTTP/SSE and web dashboard",
    tier: "T2-capability",
    anchors: [
      "§6.2 Client surfaces",
      "§6.3 Local transports and authentication",
      "§27 Security and privacy",
    ],
    outcome:
      "Hono serves an authenticated loopback HTTP/SSE API and React/Vite dashboard for Codebases, graphs, runs, artifacts, diffs, interactions, delivery, and diagnostics.",
    constraints: [
      "Bind only to loopback by default.",
      "Use short-lived sessions, origin checks, and no secret/provider-payload logging.",
    ],
    exclusions: [
      "No cloud hosting or remote-node control.",
      "No unique orchestration logic in browser state.",
    ],
    acceptance: [
      "Authentication, CSRF/origin protection, session rotation, and logout are fail-closed.",
      "SSE reconnects with event IDs and reconciles gaps from canonical state.",
      "Dashboard supports required inspection/actions and explicit confirmation for high-impact mutations.",
    ],
    tests: [
      "HTTP auth/origin/session/SSE contract tests.",
      "Browser end-to-end reconnect, artifact/diff, inbox, and destructive-confirmation tests.",
    ],
    evidence: [
      "Security header/auth test report.",
      "Dashboard acceptance screenshots and SSE recovery trace.",
    ],
  },
  {
    id: "Q054",
    milestone: "M7",
    title: "Implement durable inbox, product notifications and macOS notifications",
    tier: "T2-capability",
    anchors: [
      "§17.4 Durable inbox and notifications",
      "§25 Notifications and inbox",
      "§27.1 Confidential-code default",
    ],
    outcome:
      "A durable notification projection drives in-product inbox events and privacy-preserving macOS notifications with deduplication and acknowledgement.",
    constraints: [
      "Notification payloads omit confidential task content by default.",
      "Persist before delivery and record delivery/ack state.",
    ],
    exclusions: ["No cloud push service.", "No notification as canonical interaction state."],
    acceptance: [
      "Questions, approvals, failures, recoveries, and completion create deduplicated events.",
      "macOS permission denial or helper failure does not block runs.",
      "Read/ack/dismiss state remains consistent across CLI, TUI, web, and restart.",
    ],
    tests: [
      "Notification projection/idempotency property tests.",
      "macOS adapter permission, failure, privacy, and restart tests.",
    ],
    evidence: ["Notification event matrix.", "Redacted macOS delivery and fallback report."],
  },
  {
    id: "Q055",
    milestone: "M7",
    title: "Implement retention, archive, export/import and backup/restore",
    tier: "T2-capability",
    anchors: [
      "§26 Retention, backup, and export",
      "§27.4 Secrets and logs",
      "§18 Durability and recovery",
    ],
    outcome:
      "Retention and archive policy safely prune eligible data, while portable run/workspace exports and full backup/restore preserve integrity without secrets.",
    constraints: [
      "Exports are versioned, checksummed, and previewable.",
      "Destructive retention requires eligibility proof and audit events.",
    ],
    exclusions: [
      "No credential export.",
      "No promise to resume live provider processes from a portable bundle.",
    ],
    acceptance: [
      "Archive/prune decisions respect active references, legal holds, and configured retention.",
      "Export/import round-trips contracts, artifacts, events, snapshots, and repository/base metadata.",
      "Backup/restore handles schema migration, corruption detection, and atomic replacement.",
    ],
    tests: [
      "Retention eligibility and reference-reachability property tests.",
      "Cross-version export/import and backup corruption/fault-injection tests.",
    ],
    evidence: ["Round-trip checksum manifest.", "Backup restore and retention audit report."],
  },
  {
    id: "Q056",
    milestone: "M7",
    title: "Spike H and ship macOS/Linux standalone plus npm packaging/update path",
    tier: "T0-evidence",
    anchors: [
      "§28 Installation and distribution",
      "§23.3 Managed dependency",
      "§27 Security and privacy",
    ],
    outcome:
      "A spike selects a packaging strategy and ships verified macOS/Linux standalone artifacts plus an unpublished-but-testable npm installation/update path.",
    constraints: [
      "Node.js is not required for standalone users.",
      "Do not publish npm or add an OSS license in this issue.",
    ],
    exclusions: ["No Windows build.", "No silent update or unsigned artifact activation."],
    acceptance: [
      "ADR compares candidate packagers against native SQLite, daemon, MCP, TUI, and web asset requirements.",
      "Apple Silicon, macOS x64 where supported, Linux x64, and Linux arm64 artifacts run doctor and a fake pipeline.",
      "Checksums/signatures, version reporting, explicit update, rollback, and npm pack smoke tests work.",
    ],
    tests: [
      "Clean-machine/container install and upgrade/rollback matrix.",
      "Standalone fake acceptance and npm tarball content tests.",
    ],
    evidence: [
      "Packaging ADR and compatibility matrix.",
      "Artifact checksum/signature and smoke-test report.",
    ],
  },
  {
    id: "Q057",
    milestone: "M7",
    title: "Complete security hardening, compatibility matrix and full platform acceptance",
    tier: "T3-acceptance",
    anchors: [
      "§27 Security and privacy",
      "§29 v1 end-to-end acceptance scenario",
      "§35 Definition of done",
    ],
    outcome:
      "Heniek satisfies the complete v1 product specification on macOS and Linux with hardened boundaries, documented compatibility, and the full three-repository/five-task/three-engine scenario.",
    constraints: [
      "No acceptance criterion may be waived by documentation.",
      "Real-provider conformance remains explicit and subscription-only.",
    ],
    exclusions: [
      "No post-v1 CI repair watcher, cloud control plane, Windows, or public release.",
      "No false success for partially verified paths.",
    ],
    acceptance: [
      "Threat model and tests cover local auth, secret handling, workspace escape, supply chain, logs, exports, web, plugins, and provider processes.",
      "Compatibility matrix records supported OS/architecture, engine/Claudexor versions, features, and known bounded limitations.",
      "The full three-repository, T1→T2–T5, Claude/Codex/Cursor scenario passes questions/resume, parent disconnect, continuation, parallel integration, linked draft PRs, export/import, and specified failures.",
    ],
    tests: [
      "Security regression suite and dependency/artifact verification.",
      "Full real-provider acceptance on macOS and Linux plus deterministic failure replay.",
    ],
    evidence: [
      "Signed acceptance dossier with requirement traceability.",
      "Security report, compatibility matrix, run export, and linked PR evidence.",
    ],
  },
];
