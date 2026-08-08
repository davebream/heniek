# Heniek revision-1 backlog approval artifact

Status: **approved for publication; factory launch remains readiness-gated**

This document is the cold-read queue artifact for the single launch approval.
The repository owner recorded approval of this exact queue revision on 31 July
2026. Publication is authorized; the bounded seven-day factory may start only
when the separate machine-readable readiness report is also `ready: true`.

## Canonical inputs

| Artifact | SHA-256 |
|---|---|
| Product Specification v0.1 | `c3b2d70578c9a74435dfb407a432636759415a53c5928924ea6680f83a3a5ddd` |
| Product Specification v0.2 | `f3c5b12b1b2cca6c6739333ae00a1ecb746ed91464f095a89bb4b355f39e628c` |
| Brand report v0.1 | `2fb3fd9b9a7ac7f6444f32af033dae8a6ba6244e3e5e4cdc8dc08a401a3ec0d9` |
| Decision audit v0.1 | `ccc310ab7897431649173d4b8913aa01cccd2fb2d0442ed2b71443afdbd9e3fa` |
| Ordered queue revision 1 | `b29fc62f94d7810be5f065d73934504848dab9000997f141351242bc104af908` |

The two originally attached v0.1 product-spec files were byte-identical with
SHA-256 `c3b2d70578c9a74435dfb407a432636759415a53c5928924ea6680f83a3a5ddd`; one canonical copy is preserved.

## Queue invariant

- 57 issue packets, eight milestones, one parent epic.
- Strict total order from Q001 through Q057.
- Every issue depends on its predecessor; there is no skip action.
- Manifest, epic marker/order, and issue markers must agree on queue hash.
- A mismatch pauses the factory before claim or mutation.

## Ordered backlog

| Sequence | Milestone | Tier | Title |
|---|---|---|---|
| Q001 | M0 | T1-foundation | Establish Heniek domain IDs, state vocabulary and versioned JSON contracts |
| Q002 | M0 | T1-foundation | Add the real-engine conformance harness and deterministic fake backends |
| Q003 | M0 | T0-evidence | Spike A: Claudexor long-run handles, questions, resume and parent independence |
| Q004 | M0 | T0-evidence | Spike B: isolated subscription-only Claude and Codex profiles under hostile ambient env |
| Q005 | M1 | T1-foundation | Implement global application-home resolution, YAML layers and secret-store abstraction |
| Q006 | M1 | T1-foundation | Implement SQLite migrations, canonical projections and append-only event journal |
| Q007 | M1 | T1-foundation | Implement immutable artifacts and transactional stage completion |
| Q008 | M1 | T1-foundation | Implement daemon single-instance lifecycle, local authentication and crash recovery |
| Q009 | M1 | T1-foundation | Implement Unix-socket JSON-RPC and minimal CLI handshake/status |
| Q010 | M1 | T1-foundation | Implement Codebase detection, registration and instruction-conflict reporting |
| Q011 | M1 | T1-foundation | Implement single-repository workspace provisioning, base sync and writer leases |
| Q012 | M1 | T2-capability | Deliver one external Claudexor stage end-to-end with restart and doctor tests |
| Q013 | M2 | T2-capability | Implement managed, pinned and replaceable Claudexor runtime lifecycle |
| Q014 | M2 | T2-capability | Implement accounts, workers, roles, profiles and effort resolution |
| Q015 | M2 | T2-capability | Implement capability catalogue, engine readiness and model discovery |
| Q016 | M2 | T2-capability | Implement external Claude execution and profile adapter |
| Q017 | M2 | T2-capability | Implement Codex execution and profile adapter |
| Q018 | M2 | T0-evidence | Spike C and implement Cursor execution and profile adapter |
| Q019 | M2 | T0-evidence | Spike D: normalize context, usage and native-session telemetry |
| Q020 | M2 | T2-capability | Implement durable interactions, inbox, answer and resume |
| Q021 | M2 | T2-capability | Implement account queues, concurrency, fallback chains and permissions |
| Q022 | M2 | T2-capability | Implement subscription billing guard, env scrubbing, redaction and process cleanup |
| Q023 | M2 | T0-evidence | Spike G and implement the native Claude bridge |
| Q024 | M3 | T1-foundation | Implement YAML pipeline schema, parser and diagnostics |
| Q025 | M3 | T1-foundation | Implement deterministic graph scheduling and the fixed stage state machine |
| Q026 | M3 | T2-capability | Implement agent and command stage runners |
| Q027 | M3 | T2-capability | Implement approval, integration, verify and publish stage runners |
| Q028 | M3 | T2-capability | Implement conditions, retry/session policy, limits and bounded repair |
| Q029 | M3 | T2-capability | Implement segment fusion, smart continuation, capsules and incoming verification |
| Q030 | M3 | T2-capability | Ship the bundled fast pipeline |
| Q031 | M3 | T2-capability | Ship the careful pipeline using accepted predecessor review semantics |
| Q032 | M3 | T2-capability | Implement one-off graphs, overrides, ad-hoc attachment and pipeline conformance |
| Q033 | M4 | T0-evidence | Spike E: prove a ten-repository composite workspace |
| Q034 | M4 | T2-capability | Implement multi-root Codebase configuration and base pins |
| Q035 | M4 | T2-capability | Implement composite provisioning, repository setup and instruction merge |
| Q036 | M4 | T2-capability | Implement isolated variants, one-writer leases and expected-SHA integration |
| Q037 | M4 | T2-capability | Implement whole-Codebase analysis and multi-repository tasks |
| Q038 | M4 | T2-capability | Implement combined verification, cleanup and restart reconciliation |
| Q039 | M5 | T1-foundation | Implement TaskSource, handoffs, snapshots, revisions and hierarchy |
| Q040 | M5 | T1-foundation | Implement task DAG validation, wave eligibility and capacity gates |
| Q041 | M5 | T2-capability | Implement autonomous graph revision and provenance |
| Q042 | M5 | T2-capability | Implement whole-task parallel scheduling and failure propagation |
| Q043 | M5 | T2-capability | Implement repository epic branches and serialized integration |
| Q044 | M5 | T0-evidence | Spike F and implement partial multi-repository reconciliation |
| Q045 | M5 | T3-acceptance | Implement hidden-dependency replanning and the T1→T2–T5 epic scenario |
| Q046 | M6 | T2-capability | Implement GitHub TaskSource, synchronization and update-conflict handling |
| Q047 | M6 | T2-capability | Implement GitHub ForgeBackend issue, branch and PR primitives |
| Q048 | M6 | T2-capability | Implement external materialization and existing branch/PR adoption |
| Q049 | M6 | T3-acceptance | Implement linked single- and multi-repository draft PR delivery and recovery |
| Q050 | M7 | T2-capability | Implement Claude MCP/plugin handoff, status, answer and native-stage surface |
| Q051 | M7 | T2-capability | Complete deterministic CLI operations |
| Q052 | M7 | T2-capability | Implement the operational TUI |
| Q053 | M7 | T2-capability | Implement authenticated localhost HTTP/SSE and web dashboard |
| Q054 | M7 | T2-capability | Implement durable inbox, product notifications and macOS notifications |
| Q055 | M7 | T2-capability | Implement retention, archive, export/import and backup/restore |
| Q056 | M7 | T0-evidence | Spike H and ship macOS/Linux standalone plus npm packaging/update path |
| Q057 | M7 | T3-acceptance | Complete security hardening, compatibility matrix and full platform acceptance |

## Reference pins

| Component | Approved pin |
|---|---|
| TAKT | `ee15089b276e9c66c115c7864d64b6c47c986291` |
| Claudexor | `v3.1.2`; `bb5efee24132aa3d65e417040df201e08da44c8c` |
| Claude Code | `2.1.220` |
| Codex CLI | `0.146.0` |
| Cursor CLI | `2026.06.12-01-15-52-7244546` |

## Approval meaning

Approval is not a waiver of the readiness gate. The launch dossier must include
this queue hash, document hashes, verified tool pins, billing attestation,
`ready: true` evidence, and exact start/deadline. Without that complete dossier
the issues remain previews and the schedule remains disabled.
