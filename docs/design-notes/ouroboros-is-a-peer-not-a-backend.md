# Ouroboros is a peer, not a backend

Design note. Explains why Heniek does not adopt
[Ouroboros](https://github.com/razzant/ouroboros) as an execution backend even
though the two projects overlap heavily, what Heniek takes from it instead, and
what that choice costs.

Normative scope lives in
[Product Specification v0.2 §22 and §23](../product/product-spec-v0.2.md). This
note is explanatory and carries no authority over either.

## The question

Ouroboros is an open-source agent orchestrator that drives Claude Code, Codex,
and Cursor subscriptions. So does Heniek. Ouroboros reaches those CLIs through
Claudexor. So does Heniek. Both are local-first, both keep durable state outside
the repositories they operate on, and both organise work as a task tree with
review stages. Ouroboros is MIT-licensed and its README documents a headless CLI
and a local HTTP gateway.

On that description it looks like something Heniek could plug in — a ready-made
engine behind the `ExecutionBackend` interface, or at minimum a component to
lift review orchestration from. The overlap is real, and the question recurs, so
it is worth writing down why the answer is no.

The short version: the overlap is not at the layer it appears to be. Ouroboros
occupies the same position in the stack as Heniek, not the position below it.

## What Ouroboros actually is

Ouroboros is a general-purpose agent with persistent identity that modifies its
own source code, where each self-modification is a commit to its own repository.
Its README describes a swarm of specialist subagents — repository scout,
research lane, builder, adversarial eye, verifier, review panel — coordinated
over a task tree, plus reflection that runs outside the request/response cycle.

The part that matters here is how it executes code changes. It does not
implement a coding-agent loop. It drives Claude Code, Codex, and Cursor through
Claudexor, which it bundles as a multi-harness engine.

That single fact settles the layering question:

```text
Heniek     ──> Claudexor /v2 ──> Claude Code / Codex / Cursor
Ouroboros  ──> Claudexor     ──> Claude Code / Codex / Cursor
```

The two systems are siblings over a shared kernel. Adopting one into the other
produces:

```text
Heniek ──> Ouroboros ──> its bundled Claudexor ──> Claude Code / Codex / Cursor
              └── a second orchestrator, doing the job Heniek exists to do
```

Heniek would be delegating pipeline orchestration to a second pipeline
orchestrator, then reasoning about the result through two layers of state it
does not own.

## Why the backend contract cannot hold it

`ExecutionBackend` (§22) is deliberately narrow and stateless between calls:

```text
start · status · interactions · answer · resume · result · cancel
```

The contract assumes the backend runs one bounded unit of work, reports typed
status, surfaces pending questions, and returns a result envelope with changed
repositories and artifacts. Everything durable — the pipeline graph, the
canonical run state, the profile and role model, the artifact store — belongs to
Heniek. §23.1 states this explicitly for Claudexor: it supplies process and
session handling, and it is not the pipeline graph, the state model, or the
artifact store.

Ouroboros inverts every one of those assumptions. It holds durable identity and
memory across restarts by design; it reflects between requests; it revises its
own prompts and code. A backend that carries its own persistent history is not a
backend, because two systems then hold conflicting canonical state about the
same work and neither is authoritative.

There is also no slot for it. §3.2 lists both "an implementation of a
coding-agent loop" and "a generic public runtime-plugin API for new stage types"
as v1 non-goals. Ouroboros is neither a coding-agent loop nor a stage type; it
is a peer, and the abstraction has no seat for a peer.

## Why the Claudexor pin collides

Even setting the layering aside, the dependency does not compose.

| Heniek commitment | Ouroboros behaviour |
|---|---|
| §23.3 — Claudexor is a managed dependency pinned at `~/.heniek/runtimes/claudexor/<pinned-version>/`, and upgrades must pass compatibility tests before activation. | Ships its own reviewed Claudexor build inside its release artifacts. |
| §23.2 — the daemon talks only to the versioned `/v2` control API through an anti-corruption adapter, and does not import internal packages. | Exposes private endpoints such as `GET /api/claudexor/status` and `POST /api/claudexor/wake`, with no compatibility promise. |

Adopting Ouroboros would place two uncoordinated builds of the same execution
kernel on one machine, and the only integration surface it offers for the shared
component is the unversioned one. §23.5's compatibility gate would have nothing
to gate.

## What Heniek takes instead

The decision is not to ignore the project. Ouroboros has shipped, in public,
working implementations of several mechanisms that Heniek has only recently
built or has not built yet: reviewer panels with quorum, delegated-run custody
records, restart recovery for in-flight delegated work, a monetary usage ledger,
and delivery of changes to a hosting forge such as GitHub. It then files
unusually precise defects against those implementations, naming files, line
ranges, and measured magnitudes.

That tracker is prior art. Three recurring shapes in it are worth stating,
because they are failure modes of the architecture rather than of the language:

- **Silent fallback instead of failing closed.** Malformed reviewer
  configuration resolving to a default panel; an unavailable gate returning an
  empty result and dropping a reviewer without a trace. The run reports success
  while reviewing to a different standard than the one configured.
- **Two definitions of one concept, drifting apart.** Two terminal-status sets,
  where the event stream used the one containing a non-terminal cancellation
  latch and could therefore end without emitting the authoritative terminal
  envelope. Separately, ledger settlement and observability using different
  usage extractors, so the recorded spend and the displayed spend disagree.
- **Recovery re-resolving rather than replaying.** A route re-derived from the
  current environment instead of the stored invocation; a failed versioned
  update retrying `latest` rather than the version originally chosen. Stored
  intent is the only safe input to a retry.

Each of these is directly reachable in Heniek's own design space — §19 review
and verification, §16 canonical run state, §18 durability and recovery — and
none of them requires adopting a line of Ouroboros code to learn from.

The project is also a second heavy consumer of Claudexor `/v2`. §23.4 already
names Claudexor's youth, provider-adapter fragility, and maintainer bus-factor
as accepted risks. An independent consumer hitting the same seams is free early
warning, and costs nothing but attention.

## What it costs

Three things, stated plainly.

Heniek rebuilds review orchestration that exists in working form elsewhere.
Reviewer slots, quorum, and model-diversity preference under §19.4 are real
work, and a peer project has already paid for a version of it.

Heniek forgoes the autonomy features outright. Persistent cross-task identity
and self-directed evolution are not on the roadmap, and this note should not be
read as deferring them — they are incompatible with a control plane whose value
is that its behaviour is determined by checked-in configuration and inspectable
afterwards.

The prior-art channel is manual and decays. Nothing enforces that the tracker
gets read, and its relevance drops as both projects diverge.

Against that: the alternative costs a second orchestrator's state model, a
duplicate execution kernel, and an unversioned integration surface, inside a
product whose stated promise is a dependable and inspectable delivery system.
The trade is not close.

## A note on scope

This note argues architecture, and the architecture is sufficient on its own.

Ouroboros additionally documents residual containment gaps in its own README —
it describes its repository write fence as a convenience boundary against the
agent's own mistakes rather than containment against a determined writer.
Readers evaluating the project for other purposes should read those disclosures
directly rather than rely on a summary here. They did not drive this decision
and are not needed to support it.

## Where to look

- [Product Specification v0.2 §22](../product/product-spec-v0.2.md) — the
  `ExecutionBackend` contract.
- [Product Specification v0.2 §23](../product/product-spec-v0.2.md) — Claudexor
  role, integration surface, managed dependency, maturity posture, and
  compatibility tests.
- [Product Specification v0.2 §3.2](../product/product-spec-v0.2.md) — v1
  non-goals.
- [`packages/execution-claudexor`](../../packages/execution-claudexor) and
  [`packages/runtime-claudexor`](../../packages/runtime-claudexor) — the
  adapter and the managed runtime this note describes.
- [razzant/ouroboros](https://github.com/razzant/ouroboros) — its README, its
  issue tracker as referenced above, and `BIBLE.md`, the constitutional document
  that governs what the agent is permitted to change about itself.
