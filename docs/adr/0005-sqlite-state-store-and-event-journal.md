# 5. SQLite state store, migrations and append-only event journal

- Status: accepted
- Date: 2026-08-01
- Issue: davebream/heniek#7 (Q006, T1-foundation, milestone M1)
- Spec anchors: §16.1 One canonical state per run, §16.2 Hybrid mutability, §16.3 Storage
  categories, §16.4 No direct projection edits, §16.6 Atomic event-plus-projection pair,
  §18.2 Restart boundary, §28.1 Distribution
- Evidence: [`evidence/0005-sqlite-state-store-evidence.md`](evidence/0005-sqlite-state-store-evidence.md)

## Context

Q006 gives Heniek the thing every later milestone-1 issue needs and none of them can build for
itself: one durable, local, canonical state store, with a schema that can be migrated forward
safely and an event journal that cannot be edited after the fact.

Before this issue the repository had contracts (Q001), a conformance harness (Q002), two engine
spikes (Q003/Q004) and configuration plus a secret store (Q005) — but nothing that persisted a run.
§16.1 requires "one canonical state per run"; §16.2 splits that state into immutable and mutable
classes; §16.4 forbids editing a projection directly; §16.6 requires an event and the projection
change it causes to land as one atomic pair. Those four sentences, taken together, decide most of
what follows: they rule out an ORM-shaped "just update the row" store, and they rule out a journal
that is append-only only by convention.

The acceptance criteria sharpen it further. AC1 requires that four different migration lineages —
fresh, upgraded, interrupted, and interrupted-then-rolled-forward — converge on one canonical
schema, which forces a *comparison object* for schemas rather than an eyeballed diff. AC2 requires
that every projection change have an immutable causative event with correlation IDs. AC3 requires a
tool that replays the journal and **detects** divergence, which is a much stronger claim than one
that merely reports agreement.

This ADR records the seventeen decisions that answer those requirements, each with the alternative
it rejected and why. The measured evidence sits in the companion evidence file; the argument sits
here.

## Decisions

### D1 — `@heniek/state` under `packages/state`, dependency-free beyond Node built-ins

A new workspace package depending only on `@heniek/contracts` and Node built-ins (`node:sqlite`,
`node:crypto`, `node:fs`). `@heniek/contracts` is a real runtime dependency, not a type-only one:
`RunStatus.values` is the runtime vocabulary the run projection's row narrower validates against.

**Rejected: also depending on `@heniek/config`.** Only a `string` path would be taken from it. The
caller supplies the database path, which mirrors the direction ADR 0004 already established for
secrets and configuration. A dependency edge for one string is a coupling with no payload.

### D2 — Migrations: an append-only array, `PRAGMA user_version`, one transaction per step, forward-only

`MIGRATIONS` is a frozen array of `{ version, name, statements }`. Each step runs inside its own
`BEGIN IMMEDIATE` transaction that wraps both the DDL **and** the `PRAGMA user_version` bump, so an
interrupted migration leaves the database at the last fully-applied version and nothing in between.
There is deliberately no `down` member on the `Migration` type: forward-only is enforced by the type,
not by a convention a future migration could quietly ignore.

**Rejected: a `schema_migrations` table.** It needs bootstrapping (a migration to create the
migrations table), and it can be corrupted by a stray `DELETE` in a way a PRAGMA cannot.
`user_version` is transactional with the DDL — verified, not assumed.

**Rejected: one transaction for all pending migrations.** AC1 describes four lineages; batching them
collapses the lineage space to two and stops testing the resume path at all.

### D3 — AC1's comparison object: a two-part fingerprint, PRAGMA-structural plus declared-DDL

`schemaFingerprint()` returns two sha256 digests. `structural` is built from PRAGMA introspection
(table list, column xinfo, index list and xinfo, foreign key list) plus the normalised DDL of every
trigger and view. `declared` hashes the whitespace-normalised `sql` of every schema object, tables
included, closing `structural`'s blind spots: `AUTOINCREMENT`, table- and column-level `CHECK`,
column-level `COLLATE`, a partial index's predicate, a generated column's expression, an expression
index's column text, and foreign-key deferrability.

**Rejected: literal `sqlite_master.sql` equality.** Measured to fail: an `ALTER`-built table's stored
DDL text differs from fresh `CREATE` text for the identical logical schema. **Rejected:
normalised-DDL-only** — still fails the hand-written-equivalent case. **Rejected: `serialize()` byte
comparison** — page images embed free-list layout and never match. **Rejected: structural only** —
blind to `CHECK`/`COLLATE`/`AUTOINCREMENT`.

The two digests are not redundant: this issue's own migration 3 makes them disagree for the
hand-written witness fixture, which is exactly the discrimination the pair exists to provide.

### D4 — Journal table shape, and `sequence` as the ordering key

`state_event` is `STRICT`, keyed by `sequence INTEGER PRIMARY KEY` — the rowid alias, giving one
global total order with no `AUTOINCREMENT` and no separate counter. `recorded_at` is an ISO-8601
`TEXT` column and is explicitly **not** an ordering key. Every integer read from SQLite routes
through a safe-integer assertion.

**Rejected: a per-run sequence or a separate counter.** A global total order needs no tie-break.
**Rejected: ULID/UUIDv7 ordering** — time-sortable identifiers smuggle wall-clock ordering back into
a store whose whole point is that replay is a pure function of the journal. **Rejected:
`setReadBigInts(true)`** — it is per-statement and converts *every* integer column of that statement,
dragging `revision`, `cid` and every PRAGMA integer into `bigint` and making `JSON.stringify` throw
on the payload path. Reading an integer above 2^53 throws `ERR_OUT_OF_RANGE` rather than silently
losing precision, so the safe-integer assertion turns a deep `RangeError` into a typed error at a
known statement.

### D5 — Journal immutability is enforced by triggers, not by discipline

Two `BEFORE UPDATE`/`BEFORE DELETE` triggers raise `ABORT` on any attempt to modify or remove a
journal row. `recursive_triggers` is set and verified on every open, because it gates whether the
delete trigger fires for the row-removal half of a `REPLACE` conflict.

**Rejected: API discipline alone.** It binds only callers who go through the API. **Rejected:
`enableDefensive`/`setAuthorizer`.** Both are connection-scoped; a trigger lives in the file and
binds every writer, including a `sqlite3` prompt during incident response.

Dropping a trigger remains possible and is a *named, deliberate* escape hatch: the layered answer to
tampering is D11's divergence checker, not a guard that pretends to be unbreakable.

### D6 — Correlation and causation defined here, because the spec does not

Every event carries `correlationId` (never null) and `causationEventId` (null only at a chain root).
`commitStateChange` copies the correlation ID **from the parent event**, read inside the same
transaction; a caller cannot supply one because there is no parameter for it.

**Rejected: accepting a caller-supplied correlation ID.** The propagation rule is then documentation,
and the first caller to get it wrong produces a chain that looks correct and is not. Executing the
rule instead of documenting it costs one parameter that does not exist.

### D7 — Payload is JSON `TEXT`, `CHECK (json_valid(...))`, capped at 64 KiB

Payloads are canonical JSON text, structurally validated by the column's own `CHECK` and
semantically validated by the reducer. The cap is 65 536 UTF-8 **bytes**, from CloudEvents' size
limits. The error names the event type and the byte count and never the payload.

**Rejected: `BLOB` payloads.** Unreadable at a `sqlite3` prompt during incident response and
defeats `json_extract`. **Rejected: schema validation on append.** `json_valid` is the structural
floor and the reducer is the semantic one; a third validator with no distinct failure mode is
ceremony.

### D8 — The projection substrate: FK to the journal, causal-guard triggers, explicit INSERT/UPDATE

Every projection row cites the journal event that last moved it, foreign-key enforced against
`state_event(sequence)`, and carries a `revision`. Two triggers per table enforce that an insert
starts at revision 1 and that an update advances the revision by exactly one while citing a strictly
newer event. Writes are explicit `INSERT` or `UPDATE … WHERE key = ? AND revision = ?` statements,
where `changes !== 1` is the optimistic-concurrency failure.

**Rejected: `INSERT … ON CONFLICT DO UPDATE`.** Measured: SQLite evaluates `BEFORE INSERT` triggers
*before* conflict resolution, so the natural upsert formulation is refused by the first-revision
guard even when the conflict resolves to the UPDATE branch — freezing every projection at revision 1
and reporting an error that points at the wrong thing entirely. This is pinned as regression R-V9,
and pinned in *both* directions: a second upsert formulation is **not** blocked, so "the upsert is
banned" is a rule about which SQL the command unit may emit, not a property the schema enforces
unconditionally.

### D9 — Scope: the substrate, the run projection, and the identity rows — argued, not asserted

X4 forbids speculative *reduction* as much as over-reach, so the boundary is an argument. The
fourteen-row analysis is reproduced in "Not in scope" below.

In scope: the migration framework; the **generic** event journal (an event has an id, a sequence, a
type, a correlation/causation pair, a timestamp and a JSON payload — it is not per-domain); the
projection substrate; the run projection and the `codebase`/`repository`/`workspace` identity rows
with their relationships; and the replay/divergence tooling.

The journal being generic over `type` is the load-bearing scope decision: **later issues add event
types and projection tables by appending a migration, without touching Q006's core.** That is what
makes this a foundation rather than a first draft.

### D10 — `commitStateChange` is the only mutation path, and no `DatabaseSync` escapes

One exported function performs the whole unit: refuse a caller-opened transaction, `BEGIN IMMEDIATE`,
resolve the correlation ID, append the event, read the scoped projection state *inside* the
transaction, fold it with the pure reducer, diff, write explicit statements, `COMMIT`, with a guarded
`ROLLBACK` on any throw. `appendEvent`, `readEventById`, `internalHandle`,
`loadScopedProjectionState` and `diffProjectionState` are module-visible but **not** exported from
the package barrel.

**Rejected: exporting the handle "for advanced use".** Every advanced use imagined so far is a read
that belongs in the package as a named function, and adding one later is additive and cheap.
**Rejected: a `withTransaction(db, fn)` callback.** Inside `fn` the caller has exactly the
unconstrained write access the foreign keys and triggers exist to prevent. **Rejected: batching
several events per transaction.** §16.6's atomic unit is one event plus one projection update; a
batch API is additive later, and designing multi-event causality semantics with no consumer to
constrain them is guesswork.

### D11 — Replay and divergence: a pure reducer, an in-memory fold, and a structured report

`applyEvent` is pure — no I/O, no clock, no randomness, no database handle in its signature. Replay
folds the journal from an empty state into an in-memory `ProjectionState`.
`compareProjectionToReplay` walks all four tables and emits one `Divergence` per differing field (or
one per row present on a single side), sorted, with a reproducible digest for each side and the
schema fingerprint attached so a captured report is self-describing.

Crucially, the command path and the replay path call the **same** reducer. A divergence can
therefore only mean stored state was reached by some route other than that reducer — which is
precisely what AC3 asks the tool to detect.

**Rejected: two independent reducer implementations.** "Converged" would then mean "two
implementations agree", a weaker and much less useful claim. **Rejected: replay into a scratch
database via `serialize`/`deserialize`.** The scratch database must carry the journal too, because
the projection's foreign key requires it, so it either copies every event or `ATTACH`es the source:
real complexity for no gain when the comparison is between two values. **Rejected:
`createSession`/`applyChangeset`** — it detects byte differences between two databases, not
reducer-versus-stored disagreement.

**Rejected: a `volatileFields` exemption.** None is needed under any clock: `updatedAt` is set by the
reducer to `event.recordedAt` on both paths with no post-processing, so it is byte-identical whether
the injected clock advances or not. An exemption would only create somewhere for a real divergence
to hide.

### D12 — Durability: WAL, `synchronous=FULL` per connection, `BEGIN IMMEDIATE`, `busy_timeout`

WAL is set once (it is persistent); `synchronous=FULL` and `foreign_keys` are asserted on **every**
open, because both are connection-scoped. Write transactions use `BEGIN IMMEDIATE`.

**Rejected: `synchronous=NORMAL`.** §18.2 forbids losing acknowledged writes, which is exactly what
NORMAL trades away. **Rejected: the `DELETE` journal mode** — no reader/writer concurrency and no
benefit here. **Rejected: a deferred `BEGIN`.** Measured: it succeeds and then fails on the *first
write* with `SQLITE_BUSY`, after the caller has done work, at a statement unrelated to the real
cause.

### D13 — `state.sqlite` and its sidecars are `0600`, achieved by creating the file **before** SQLite opens it

`openStateDatabase` pre-creates the database file at `0o600` *before* handing the path to
`DatabaseSync`, uses `lstat` (never `stat`), refuses a symlink or a foreign-uid file, and refuses a
group- or world-writable parent directory.

**Rejected: open first, then `chmod`.** Measured, and pinned as regression R-V6: the sidecars are
created by SQLite at open time and a later `chmod` of the main file does not reach them, leaving
`-wal` and `-shm` at the umask-derived mode. The `-wal` can hold committed rows not yet
checkpointed, so this is a real exposure of real state. **Rejected: relying on the `0700` parent
directory alone** — defence in depth is cheap here and the parent is not always ours.

**Accepted residual risk (TOCTOU).** A directory or file swap between the `lstat` checks and
`new DatabaseSync(path)` is **not** closable with `node:sqlite` as it stands: `DatabaseSync` takes a
path, not a file descriptor, so there is no fd-relative (`openat`-style) open available to bind the
open to the same inode the check inspected. "Symlink refused" and "group/world-writable parent
refused" are therefore point-in-time checks, not an airtight guarantee against a concurrent
adversary who already has write access to the parent directory. This is recorded as an accepted
residual risk, not a closed one. **Named revisit trigger:** an fd-accepting API surfacing from
`node:sqlite`.

### D14 — Clock and IDs are injected; a determinism scan enforces it

`Clock` and `IdGenerator` are **required** parameters of `openStateDatabase`. An optional parameter
with a wall-clock default would make the deterministic path the one callers must remember to opt
into. A local scan asserts that no file under `src/` contains a wall-clock, random, or network
source.

**Rejected: optional ports with real defaults.** The first caller who forgets makes the replay report
irreproducible, and nothing fails until much later. **Rejected: importing the scan's pattern from
`@heniek/conformance`.** The duplication is deliberate: each package owns its own scan and its own
copy of the pattern, at a cost of a few dozen lines and *zero* cross-package coupling — the same
trade-off already made for the seeded generator in this package's test helpers.

### D15 — No new `versioned()` contract schemas; the pinned manifest stays at 14, byte-identical

No cross-package consumer exists for a `StateEventV1`. `SCHEMA_REGISTRY.size` remains 14 and every
pinned `sha256` is byte-identical to its pre-Q006 value.

**Rejected: adding `StateEventV1` now.** Q001 set the identical precedent in its own scope note, and
a contract with no second party is a guess about a consumer's needs. **Named future trigger:** Q009's
CLI emitting `MigrationManifest` or `ReplayDivergenceReport` across a process boundary over JSON-RPC
is the point at which these shapes earn versioned contracts.

### D16 — Property tests are hand-rolled on a seeded generator; zero new dependencies

Five properties run over three fixed seeds × 40 generated commands, on the splitmix32 generator this
repository already uses. The seeds are constants in the file — a property test that picks its own
seed is a flaky test with extra steps.

**Rejected: `fast-check`.** Shrinking earns its keep when counterexamples are large and opaque; here
a failure is "this seed, at command N" against a readable command list. The cost is a workspace
catalog entry, a lockfile delta, and the supply-chain review ADR 0004 D1 sets as the bar. **Named
revisit trigger: if a replay counterexample ever exceeds roughly 20 commands, reopen this
decision.**

### D17 — `node:sqlite` is a Release Candidate, and that is recorded rather than glossed

`node:sqlite` is **Stability 1.2 — Release candidate** (Node ≥ v24.15.0). Its API may still change
under semver-minor. Every behaviour this package relies on is **pinned by a test in this package**
rather than merely used: PRAGMA posture and introspection shapes, `RAISE(ABORT)` error codes and
verbatim messages, `changes`/`lastInsertRowid` typing, transaction-open state after an abort, upsert
trigger ordering, and sidecar permission behaviour.

**Rejected: `better-sqlite3` or another native binding.** It reintroduces a native build step and a
supply-chain dependency for a capability the runtime now ships. **Rejected: using the module without
pinning its behaviours.** A release candidate whose behaviour is assumed rather than asserted turns
a future Node upgrade into an unbounded debugging session; the pins convert it into a failing test
naming the exact behaviour that moved.

## Testing strategy

Six layers, each aimed at a claim rather than at coverage:

- **Schema lineage (AC1).** Fresh, upgraded, and interrupted-then-rolled-forward lineages are
  asserted pairwise byte-equal on both digests at the terminal version; the interrupted database is
  asserted equal to the *previous* version's committed pin. A hand-written `terminal-schema.sql`
  witness, authored independently of the migration DDL, must match on `structural` — and must
  **not** match on `declared`, because migration 3's `ALTER TABLE ADD COLUMN` rewrites the stored
  text. Digests, migration statement hashes, and the SQLite/Node versions are committed fixtures.
- **Schema constraints (AC2).** The journal's immutability and STRICT behaviour, then the projection
  guards, driven entirely by **raw SQL** through the package-private handle — because AC2 has to
  hold against *any* writer, not only against the command unit.
- **Command and transaction boundary (C2).** Correlation propagation, the payload cap at its exact
  boundary, the input guards, and the C2 seam: an injected clock whose second read throws, sitting
  precisely where the event row exists and the projection row does not. That case asserts **both**
  tables are empty — a suite asserting only the projection would pass against an implementation that
  leaked orphan events.
- **Replay and divergence (AC3).** Convergence, plus **two mandatory injection cases**: a doctored
  reducer, and out-of-band surgery on a copy with the guard trigger dropped. A suite that only ever
  asserts `converged` proves the comparison runs, not that it discriminates.
- **Properties.** Replay convergence, gapless ascending sequences, resolvable event references with
  revisions matching write counts, prefix-plus-remainder equalling a whole replay, and correlation
  IDs constant along acyclic causal chains.
- **Crash matrix.** Three real child processes, killed with `SIGKILL` at the C2 boundary, after
  `COMMIT`, and inside a migration. These prove **that this code never places a projection write
  outside the transaction carrying its event** — not that SQLite is atomic, which is SQLite's claim
  and is relied upon here.

Two source scans run over `src/`: no ambient non-determinism, and no credential-shaped field names.
Each carries a negative control, so a regex that silently stopped matching cannot make a scan pass
vacuously.

## Consequences

Later issues gain a transaction primitive they can build on without re-deciding durability,
permissions, or causality: adding a projection is appending a migration plus extending the reducer.
The closed command API means no consumer can accidentally write a projection row without its event,
because there is no exported way to do so.

The cost is real and worth naming. Every new event type is a change in three places — the reducer,
the scope function, and the divergence comparison. The package deliberately offers no escape hatch,
so a consumer needing an unanticipated read must add a named function here rather than reaching for
a handle. And `node:sqlite` being a release candidate means a Node upgrade can require revisiting the
pinned behaviours; the pins make that a failing test rather than a mystery.

**Standing obligation.** *Every future issue that adds a projection table or an event type must
extend **both** the reducer (`applyEvent` and `eventScope`) **and** `compareProjectionToReplay`.*
Extending only the reducer silently narrows the divergence checker: replay would keep converging
while an entire table went unchecked. This is the single most important maintenance rule this
package has.

### Open questions carried forward

1. **STD-8 — standards-coverage gap.** The migration-versioning question (`user_version` versus a
   migrations table) could **not** be checked against an external comparative source: `WebSearch` and
   `WebFetch` were unavailable to the design agent and sandbox egress to upstream documentation hosts
   was blocked. D2 is argued from measured SQLite behaviour and repository convention. Every *other*
   standards item was closed against a primary source or direct measurement. The risk if D2 is wrong
   is low and reversible — the version store sits behind one PRAGMA read — but the gap is real and is
   recorded rather than papered over.
2. **`workspace_id` nullability.** `RunV1.workspaceId` is required, but a run necessarily exists for
   a moment before its workspace is provisioned. The column is modelled nullable here. If Q011
   concludes a run may never exist without a workspace, this becomes `NOT NULL` in a later
   **additive** migration.
3. **`codebase_id` denormalised onto `run_projection`.** Duplicated for query convenience and kept
   consistent by the reducer, with no foreign key to `codebase`. If Q010 introduces a run→codebase
   relation table, this column is the one to revisit.

### Review coverage obtained, and not obtained

The design stage's `security-auditor` dispatch — triggered by keyword match on
credential/permission handling — was **suppressed** by an explicit instruction in the dispatching
prompt not to spawn sub-agents, as was the expert-consultation gate. The compensating measures were a
self-review against the same checklist and mechanical enforcement where possible: the credential-field
scan, the payload-redaction rules on every error type, the permission tests, and the R-V6 regression
pin. A reviewer should treat the permission and payload-handling surface as **self-reviewed only**,
and the TOCTOU residual under D13 as the known open item on that surface.

## Not in scope

The §16.1 enumeration, cross-referenced against §16.2's mutability split and the backlog's own
assignments:

| # | §16.1 category | §16.2 class | Owning queue item | In Q006? | Why not, concretely |
|---|---|---|---|---|---|
| 1 | source task and revisions | immutable snapshots (§13.3) | Q010 / Q037 | Identity reference only | `SourceWorkItemId` exists and is referenced by `RunV1`; the *revision snapshot* semantics are Q010's. Building a revisions table now means guessing its shape. |
| 2 | Codebase and repository bases | identity/relationship | Q010, Q034 | **Yes — identity rows** | §16.3's first bullet is "identities and relationships"; `CodebaseId`/`RepositoryId` already exist. Omitting them would be the speculative *reduction* X4 bans. |
| 3 | workspace and variants | identity + lifecycle status | Q011, Q036 | **Identity + `workspaceId` — yes**; provisioning/lease state — no | `WorkspaceId` exists and `RunV1.workspaceId` already references it. Leases are §16.3's "locks and leases", explicitly Q008/Q011. |
| 4 | graph versions and waves | immutable graph revisions | Q024 / Q025 | No | No contract family exists; the graph model is the subject of its own issues. |
| 5 | stage states and attempts | attempts immutable, status mutable | Q025 | No | §16.6's stage transaction is Q007's. Q006 supplies the transaction *primitive* it will use. |
| 6 | resolved profiles | immutable frozen JSON (§8.2) | Q014 | No | ADR 0004 already deferred profile document schemas to Q014 by name. |
| 7 | provider sessions | mutable | Q016–Q019 | No | Provider payloads stay inside execution-backend adapters. |
| 8 | decisions | immutable | Q025+ | No | No contract family. |
| 9 | questions and answers | immutable | Q020 | No | `Interaction`/`InteractionAnswer`/`PendingInteraction` contracts exist, but §16.3's "interactions" is Q020's storage charter. |
| 10 | artifacts | immutable; "artifact metadata" per §16.3 | **Q007** | No | Q007 is *titled* "immutable artifacts and transactional stage completion". Building artifact tables here collides head-on. |
| 11 | commits and diffs | immutable | Q037+ | No | Delivery-tier. |
| 12 | verification evidence | immutable | Q027 | No | No contract family. |
| 13 | publication state | mutable | Q037+ | No | Delivery-tier. |
| 14 | usage and timing | mutable | Q019 | No | Accounting-tier. |

The two §16.3 categories **not** in §16.1 — "locks and leases", and "scheduling"/"account queues" —
likewise belong to Q008/Q011 and Q021/Q025.

Also explicitly out of scope, with their owners: no daemon or single-instance enforcement (Q008); no
CLI (Q009); no artifact storage (Q007); no locks or leases (Q008/Q011); no interactions (Q020); no
scheduling (Q024/Q025); no squashed baseline migration (the lineage tests depend on the real
sequence, and squashing is a decision to take when migration count actually hurts); and no
`fast-check` (D16).

Not simulated anywhere, and stated rather than faked: power loss and lying `fsync`, filesystem
corruption, and concurrent writers from a second process.
