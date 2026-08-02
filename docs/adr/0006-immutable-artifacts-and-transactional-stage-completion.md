# 6. Immutable artifacts and transactional stage completion

- Status: accepted
- Date: 2026-08-02
- Issue: davebream/heniek#8 (Q007, T1-foundation, milestone M1)
- Spec anchors: §4.4 Artifact before completion state, §16.1 One canonical state per run,
  §16.2 Hybrid mutability, §16.3 Storage categories, §16.5, §16.6 Atomic event-plus-projection pair
- Evidence: [`evidence/0006-immutable-artifacts-evidence.md`](evidence/0006-immutable-artifacts-evidence.md)

## Context

Q006 (ADR 0005) landed the SQLite spine — migrations, the append-only `state_event` journal, the
projection substrate, and `commitStateChange` as the package's only mutation path. Nothing yet
wrote an artifact. `ArtifactRefV1` existed with only `artifactId`/`path`/`contentHash`/`createdAt`
and had zero non-test consumers.

§4.4 states the binding obligation this issue answers: a stage artifact must be completely
persisted and validated **before** the transaction that marks the stage attempt successful and
releases dependants. That single sentence forces two halves of one operation — a filesystem
publication and a SQLite metadata transaction — into one atomic unit, and forces the question of
where that unit is allowed to live.

**A note on provenance.** The original 84 KB design document for this issue was lost to a
workspace re-provisioning partway through the build. D1–D11, D11a, D12n, D13n, D14n, D5a, D17, and
S1–S3 below are restated in full from the surviving plan and design-doc reconstruction, each with
the alternative it rejected.
**D12–D16 (the original numbering) were lost and are not recoverable.** They are not silently
dropped: every acceptance criterion this issue owns traces to a surviving decision below, nothing
in the shipped code depends on the lost numbers, and this ADR records the loss explicitly rather
than renumbering around it. Any content those decisions held that later proves load-bearing must
be re-derived and recorded under a new number — `D12n`, `D13n`, `D14n` below are exactly that: the
three that had to be re-derived because the plan's own normative text depended on their exact
shape.

## Decisions

### D1 — Everything lives in `packages/state`, not a sibling `packages/artifacts`

**Decision.** The artifact store (`packages/state/src/artifact/**`) is a subtree of the existing
`@heniek/state` package, not a new workspace package.

**Rationale (decisive).** `internalHandle` — the only way to reach the open `DatabaseSync` and
join its transaction — is exported from `database/open.ts` but deliberately **absent from the
package barrel** (`src/index.ts`). No sibling package can join a transaction on `state.sqlite`
without either re-exporting that handle or accepting an already-open one from a caller. The issue
constraint is "atomic file publication **plus** SQLite metadata transaction" — a single atomic
unit — so the transactional half is forced inside `packages/state` by the same invariant Q006 set:
`commitStateChange` (and its Q007-internal sibling `commitStateChangeInternal`) is the only
mutation path.

**Rejected: a `packages/artifacts` library receiving an already-open handle.** This is exactly the
`withTransaction(db, fn)` shape ADR 0005's D10 already rejected for its own callers: inside `fn` a
caller has the unconstrained write access the foreign keys and triggers exist to prevent. It would
also require re-exporting `internalHandle`, dissolving the invariant that `commitStateChange` (and
now `completeStage`) is the only mutation path — a second package with direct SQL access to
`state.sqlite` is a second place every future invariant has to be re-verified.

### D2 — Extend `ArtifactRefV1` in place; do not mint a v2

**Decision.** `ArtifactRefV1` gains six fields (`name`, `byteLength`, `mediaType`,
`contentSchemaId`, `producer`, `sourceLineage`) as a breaking, in-place edit to a closed schema
(`versioned()` produces `additionalProperties: false`, so any new field is a schema-shape change
under the contract package's own compatibility test). No `ArtifactRefV2` is minted.

**Rationale.** The conformance package's `contracts-compatibility.test.ts` pins all schema ids and
their sha256 digests — this is the mechanism that turns "we changed a contract" from a fact someone
might not notice into a failing test someone has to deliberately fix, which is exactly why this had
to be an explicit decision rather than an incidental one. The compatibility question this pin
raises is empirical, and the answer was measured, not assumed: `ArtifactRefV1` is `private: true`
(unpublished) with **zero non-test consumers** — `grep -c artifactId packages/conformance/generated/*.json`
returns 0, and there is no artifact table, no blob store, and no publication path anywhere in the
pre-Q007 tree. There is no payload anywhere that this edit could break, because nothing has ever
emitted one. Extending a contract nobody has ever produced a value of breaks no wire compatibility;
minting a v2 would be versioning a distinction with no consumer on either side of it.

**Rejected: `ArtifactRefV2`, keeping v1 frozen.** Versioning exists to protect a consumer from a
breaking change to a payload it already depends on. With zero consumers, a v2 buys nothing but a
second schema id to maintain, and — per ADR 0005's D15 — this package's own precedent is not to
mint a contract shape ahead of an actual second party. The exercise of updating exactly one pin
(`ArtifactRef/v1`) while the other 13 stay byte-identical **is** the deliberate-versioning act
AC-4's gate exists to force; a v2 would let that gate pass without anyone having to look at the
diff.

`contentSchemaId` is deliberately not named `schemaVersion` — in this repository `schemaVersion`
already means the **contract** revision (the `versioned()` wrapper's own field), and reusing it for
a payload's content-schema identity would make the ref self-contradictory about which "version" it
was reporting.

**`path` is pinned to the store's on-disk layout — a deliberate coupling, stated rather than left
implicit.** `completeStage` sets `ArtifactRefV1.path` directly from the publication receipt's
`relativePath` (`complete-stage.ts`: `path: artifact.receipt.relativePath`), which is itself
`blobs/sha256/<hex>` — the exact directory convention `publishArtifact` writes to. There is no
translation layer between "where the store puts a blob" and "what the public contract calls
`path`"; they are the same string. That means a future change to the store's on-disk layout (a
different blob directory scheme, a sharded prefix, a different addressing scheme entirely) is not
an internal refactor — it is a **breaking change to `ArtifactRefV1`**, subject to the same AC-4
gate this issue's own `contentSchemaId`/`producer`/`sourceLineage` additions went through. This is
accepted deliberately rather than papered over with an indirection: `path` is documented as
output-only and a caller-supplied value that disagrees with the derived one is refused, so the
coupling is one-directional and cannot be forced open by a caller, but it is real and future
maintainers changing the store's directory layout must treat that change as contract-versioning
work, not a private implementation detail. See Q5 in "Open questions carried forward" below for
the related `path`/`contentHash` redundancy question.

### D3 / D14n — Publication uses `link()`, never `rename()`; `unlink` of the temp follows the directory `fsync`

**Decision.** `publishArtifact` moves a validated temp file into its immutable, content-addressed
final location with `link(temp, blobs/sha256/<hex>)`, never `rename(temp, dest)`. The temp file is
`unlink`ed only after the containing directory's `fsync` succeeds — never before.

**Rationale — `link` vs. `rename`.** `rename` **atomically replaces an existing target** if one is
present. For a mutable-in-place store that would be the whole point; for an immutable,
content-addressed store it is catastrophic: two publications racing to the same content hash (a
legitimate, expected event — dedup is a feature here, not an edge case) would have the second
`rename` silently clobber the file the first publication, and everything that already reads it,
depends on being byte-stable. `link` instead fails with `EEXIST` when the destination exists. That
failure is not a defect to work around — it is the **correct signal**: it tells the caller unarmed
"this content is already published," which is exactly the information an idempotent-adopt path
needs (re-open the existing blob, re-verify its digest, and treat it as the caller's own result
rather than an error).

**Rationale — ordering.** `fsync(fd)` on the temp file happens before the digest is trusted for
publication, and the containing directory is `fsync`ed after the `link` succeeds, **before** the
temp file is `unlink`ed. An `unlink`-before-`fsync` ordering can lose the artifact bytes entirely:
if the process (or the machine) dies between the `unlink` and the directory `fsync`, the only
proof that the directory entry (and, transitively, the bytes it points at) is durable is the
`fsync` that has not yet happened — removing the temp's own directory entry first leaves nothing to
recover from if that `fsync` never completes. Publishing the durability guarantee before removing
the last un-durable reference to the same content is the entire reason this ordering, and not its
reverse, is correct.

**Rejected: `rename()`.** Rejected outright, not merely deprioritized — see the paragraph above. No
variant of "check first, then rename" closes the race, because the check and the rename are not
atomic with each other; `link`'s `EEXIST` is atomic with the operation it guards.

### D4 — §16.6 steps 4 and 5 are one transaction, and that is recorded here rather than amending the product spec

**Decision.** `completeStage` performs §16.6 steps 4 (append the stage-result event) and 5 (update
the projection: an `artifact` row per published ref, plus the `stage_artifact_alias` row) inside
**one** SQLite transaction, via a new internal `commitStateChangeInternal(db, command, { assertions,
primaryTable, artifactRelativePaths })`. The product specification's own numbering, which lists
them as two separate steps, is **not** amended.

**Rationale.** §16.6's own governing sentence — the same one ADR 0005 built `commitStateChange`
around — is that an event and the projection change it causes must land as **one atomic pair**.
Steps 4 and 5 are exactly one event and the projection change it causes; numbering them separately
in the spec is a presentational choice about how to describe the operation to a reader, not a
claim that they are two separately-committable units. Splitting them into two transactions would
recreate precisely the hazard §16.6 exists to forbid: an event committed with no matching
projection update, or a projection update with no causative event, if the process died between the
two commits. This ADR is the place to record that reading, rather than editing the product
specification's step numbering to match the implementation — the specification's numbering is a
narrative device, the transaction boundary is an engineering decision, and conflating the two by
editing the spec would risk a future reader assuming every future numbered sub-step must also be
its own transaction, which is not the intended reading.

Step 6 (release dependants) is **not** part of this transaction — see D7.

### D5 — Blob GC/retention is out of scope; unreferenced blobs are retained and classified, never reclaimed

**Decision.** A blob under `blobs/sha256/<hex>` with no `artifact` row referencing it is classified
`unreferenced` by `recoverArtifacts`/`listArtifacts` and **reported**, never deleted.

**Rationale.** Reclaiming an unreferenced blob is a retention-policy decision — how long to keep
content nothing currently points at, under what pressure, with what audit trail — and none of that
policy exists yet anywhere in this codebase. Building a reclamation path now means guessing a
policy with no requirement driving its shape, which is the same speculative-reduction hazard ADR
0005's D9 argued against in the other direction (building tables nobody asked for). The schema
already makes "retained but classified" cheap and safe: a committed `artifact` row can only ever
name a path under `blobs/`, by migration-4 `CHECK` construction (see D11), so classification is a
pure set-difference between what is on disk and what the database references — no risk of
misclassifying a referenced blob as reclaimable. The follow-up issue for blob GC/retention is filed
separately (plan Task 6.6); this ADR records the boundary, not the eventual policy.

### D5a — Opening a store never deletes anything; recovery is explicit and unconditional

**Decision.** `createArtifactStore` never sweeps `incoming/`, gated or otherwise — opening a store
is purely idempotent layout construction. `recoverArtifacts(store, db)` is the **only** place a
sweep ever runs, has exactly **one** mode (unconditional removal of every `incoming/` entry present
when the call starts), and is invoked exclusively by an explicit operator entry point, documented
as requiring the caller to hold a single-writer precondition for the duration of the call. No
`minAgeMs`/`Clock`-gated mode exists anywhere in the shipped code.

**Rationale.** No-loss is a schema invariant, not a runtime check: migration 4's `CHECK
(relative_path = 'blobs/sha256/' || content_hash)` on `artifact` makes it structurally impossible
for a committed row to reference anything under `incoming/`, so sweeping `incoming/` unconditionally
can never delete something a row points at. Given that, gating the sweep buys nothing — there is no
data-loss risk left for a gate to prevent — while the specific gate that was tried and removed
introduced its own, worse risk.

**Rejected in full: gating the automatic sweep by comparing an injected `Clock` against
`lstat().mtimeMs`.** An earlier revision shipped exactly this — `createArtifactStore`'s on-open
sweep removed only `incoming/` entries whose `mtimeMs` was older than a caller-supplied `minAgeMs`,
measured against the store's injected `Clock`. It was removed for three independent reasons, each
sufficient on its own:

1. **Category error — two different time domains.** `Clock.nowIso()` is the package's injected,
   deterministic notion of "now" (real wall-clock in production, an arbitrary fixed or
   test-controlled value under a fake clock). `lstat().mtimeMs` is the kernel's own wall-clock
   timestamp, set by the filesystem at write time, with no relationship to the injected `Clock`
   whatsoever. Comparing them is not comparing two measurements of the same quantity — it is
   comparing two unrelated numbers that happen to both look like timestamps. Under a fake `Clock`
   held at a fixed instant, every real filesystem entry is either always "older" or always
   "newer" than that fixed instant depending on which side of it the fake clock sits, making the
   gate **inert** (never fires) or vacuous in a way no test could distinguish from "working
   correctly." Under real clock skew between the process's belief about time and the kernel's,
   the same comparison can become **destructive** — removing an `incoming/` entry a live, correct
   writer produced only moments ago, because the two clocks disagreed about what "moments ago"
   meant.
2. **Fail-open on a malformed value.** A malformed or `NaN`-producing comparison (`NaN - mtimeMs <
   minAgeMs`, or equivalent) evaluates `false` in JavaScript's numeric comparisons, which makes the
   *safe* branch — "leave it alone" — the one that gets skipped, not the one that runs. A
   defensive gate that fails toward "delete everything" on bad input is not a defensive gate.
3. **`mtime` cannot distinguish an abandoned temp from a slow live writer**, at any floor value
   that is simultaneously safe and useful. A generous floor (seconds) is still an arbitrary
   guess about how slow a legitimate write/hash/link/fsync sequence is allowed to be under load; a
   tight floor is unsafe for exactly the writer it is meant to tolerate.

A later fix cycle within this same build tried a narrower version of the same idea — moving the
`Clock`-vs-`mtimeMs` comparison into the explicit `recoverArtifacts` entry point instead of the
automatic on-open path, on the theory that "the caller opted in explicitly" changes the analysis.
It does not: **the caller choosing to invoke the comparison does not make the two time domains
comparable.** Reasons 1–3 above are properties of comparing an injected `Clock` against real kernel
`mtimeMs` — they hold regardless of who triggers the comparison or how deliberately. "The caller
opted in" answers a question about consent, not about whether the underlying comparison is sound;
it does not fix a category error, it just relocates it to a call site that looks more deliberate.

The safety property `recoverArtifacts` relies on instead is a **documented precondition, not a
runtime check**: the caller is responsible for serializing any call to `recoverArtifacts` against
every publisher of the same store (a file lock, a single-process scheduler, a maintenance window —
whatever the deployment provides) before calling it. Cross-process single-writer enforcement is
chartered to Q008 and is explicitly out of scope here; this package neither takes nor can take a
filesystem-level lock across processes today. This was chosen deliberately over an in-process
liveness signal (e.g., a non-blocking lock on each temp file) — a liveness lock is still only
advisory against a genuinely hostile or crashed writer, adds a cross-process contract this issue
never scoped, and duplicates work Q008 already owns.

### D6 — Step 6 ("release dependants") ships as derived state only; no dispatch call exists

**Decision.** §16.6 step 6 is implemented as **derived** state — a later reader can compute what is
unblocked by querying the projection — with **no exported release/dispatch call** anywhere in this
package, and a test (`complete-stage-derived.test.ts`) asserting that no such call exists.

**Rationale.** There is no stage lifecycle (status, attempts, a dependency graph, a scheduler) to
release dependants *into* yet — those contracts do not exist in this repository as of this issue.
Shipping a dispatch call now would mean inventing the shape of an API for a consumer that does not
exist, which is exactly the speculative-reduction-in-reverse hazard ADR 0005's D9 argued against:
guessing a future consumer's needs produces an API someone else then has to either honor or break.
The explicit no-release-call test exists so a later issue cannot silently reintroduce a post-commit
dispatcher without a deliberate decision to do so — it converts "nobody got around to building
this yet" into "this is a checked invariant," which is a stronger and more honest claim.

### D7 — The AC-1 guard is structural: keyed off the closed `ProjectionTable` union, not an event-type blacklist

**Decision.** `assertGuardedWritesAreVerified` (in `command/commit.ts`) refuses any write the
reducer actually produces into `artifact` or `stage_artifact_alias` unless that write's
`relativePath` was pre-verified by an S2 filesystem assertion. The guard is keyed off
`ARTIFACT_GUARDED_TABLES`, a `ReadonlySet<ProjectionTable>` — `ProjectionTable` being the closed
union `command/commit.ts` already exhaustively switches on in `TABLE_SQL` — and it inspects the
**writes the reducer actually produced** (`ProjectionWrite[]`), not the incoming command's declared
`type`.

**Rationale.** `StateCommand.type` is an unconstrained `string` at the type level — nothing stops a
future event type from being added that happens to write into `artifact` or `stage_artifact_alias`.
A guard keyed on `event.type` (a blacklist: "refuse these specific type strings from writing to
these tables") is a rule that a seventh event type could silently reopen simply by not being on the
list — the list is exactly as complete as whoever last edited it remembered to make it, forever.
Keying the guard on the **table a write actually touches** instead cannot be reopened that way: it
does not matter what a new event type is named or what its payload looks like — if the reducer it
drives ever produces a `ProjectionWrite` targeting `artifact` or `stage_artifact_alias`, the guard
sees that write and refuses it unless the caller supplied a matching, verified assertion. Widening
the guarded surface requires an explicit edit to `ARTIFACT_GUARDED_TABLES` itself, which is a
visible, reviewable change to the one place this invariant lives — not a silent gap in an
enumeration that has to be kept in sync with every event type by convention.

`commitStateChange` (the public entry point) always calls the internal path with an empty verified
set, so *any* write into either table through the public API is refused unconditionally, regardless
of event type — only `completeStage`'s own internal call, which supplies S2-verified assertions,
can ever succeed.

### D8 — The residual TOCTOU window between the under-lock assertion and `COMMIT` (stated honestly)

**Decision.** The window between S2's under-lock filesystem assertion returning and the
transaction's `COMMIT` — and again between `COMMIT` and `completeStage`'s own `finally` closing the
receipt fd — is **not closed** by this design, and is documented as an accepted residual gap rather
than an eliminated one.

**Rationale.** `BEGIN IMMEDIATE`'s write lock is a SQLite-internal construct: it protects
**the database** — no other SQLite writer can take a competing write lock while it is held — but it
takes and protects nothing at the filesystem layer. Nothing in `command/commit.ts` or
`artifact/complete-stage.ts` acquires any filesystem-level lock. Between S2's assertion returning
`true` and the surrounding transaction's `COMMIT`, a hostile or merely buggy concurrent process
with filesystem access to the store root can still `unlink` the blob S2 just verified — the pinned
fd (S1) keeps the **inode's bytes** alive for as long as this process holds that fd open, but it
neither keeps nor can keep the **directory entry** (the name a later reader resolves) alive. Once
the fd is closed, the inode itself can be freed too, leaving a committed row that names a path with
nothing there.

This is stated honestly rather than glossed because no design inside this module can beat a hostile
unlinker holding filesystem access to the same root — that is a filesystem-permissions and
process-isolation problem, not a transaction-design problem, and is out of this issue's scope. What
this design *does* provide is detection after the fact: `listArtifacts` (Task 5.2) re-verifies every
row's content hash against the bytes currently on disk and reports `verified: false` for a row whose
blob has vanished or changed, precisely so this residual window has a way to be caught rather than
being invisible.

### D9 / D13n — `ArtifactFileSystem` is a package-private port, wired to a thin `node:fs` adapter

**Decision.** An `ArtifactFileSystem` interface abstracts every filesystem primitive the artifact
store touches (`open`/`read`/`write`/`fsync`/`link`/`lstat`/`fstat`/`unlink`/`readdir`/`mkdir`).
Production code wires a thin `node:fs`-backed adapter; `createArtifactStoreInternal` — the variant
that accepts an injected port for testing — is **module-visible only**, exported from
`artifact/store.ts` but never from `src/index.ts`, mirroring `database/open.ts`'s
`openStateDatabaseInternal` discipline.

**Rationale.** Fault injection at each durability boundary (post-write, post-fsync, post-link,
post-directory-fsync) needs a seam that can fail on command, and it needs that seam to not exist as
a production-reachable code path. A port with a production adapter plus a fake adapter gives tests
that seam without shipping any test-only branch inside the code every real caller executes. Every
port method throws the underlying `node:fs` `ErrnoException` unchanged rather than a package-typed
error — the store layer narrows by `.code` at its own boundary — matching the discipline ADR 0005's
`command/commit.ts` already established for not wrapping raw SQLite errors before the package's own
boundary. `openExclusive`'s `EEXIST` and `link`'s `EEXIST` are the two signals this port's callers
are expected to branch on; every other error from every method is fatal to the calling operation.

### D10 — Migration 4: `artifact` and `stage_artifact_alias`, with guard triggers matching every other projection table

**Decision.** One migration, version 4, name `artifact`, adds two tables:

- `artifact` — one immutable row per published artifact, `artifact_id` PK, with `CHECK
  (relative_path = 'blobs/sha256/' || content_hash)` and `CHECK (relative_path NOT LIKE
  'incoming/%')` tying the row's location to its own content hash by construction. Immutability is
  enforced by `BEFORE UPDATE`/`BEFORE DELETE` triggers raising `RAISE(ABORT, 'artifact is
  append-only')`, mirroring `state_event`'s own immutability triggers (ADR 0005 D5).
- `stage_artifact_alias` — the §16.2 "active artifact alias," keyed `(run_id, stage_id, name)` →
  `artifact_id`. This is the **one deliberately mutable** row in this issue's schema — the artifact
  it points at is immutable, but which artifact a given `(run, stage, name)` currently names can
  advance on a retry.

**Rationale — why the guard-trigger *set* differs between the two tables.** `artifact` and
`stage_artifact_alias` are both **projection** tables, not journals, so the template that governs
them is ADR 0005's projection-table pattern (a `*_first_revision` trigger and a `*_causal_update`
trigger, present on every existing projection table), not `state_event`'s append-only pattern.
`artifact` carries the projection pair **and** the append-only immutability pair, because an
artifact row, once written, must never move to a new revision at all — there is no legitimate
"update" of an artifact row, only a new row for a new attempt. `stage_artifact_alias` carries only
the projection pair, because it is the one row that is supposed to advance — its causal-update
guard is what keeps that advancement well-formed (revision must increase by exactly one, citing a
strictly newer event), the same invariant every other mutable projection table in this package
already enforces.

The two `CHECK` constraints on `artifact` tying `relative_path` to `content_hash` and banning
`incoming/%` are what make D5a's no-loss claim a schema property rather than a claim about this
package's own code being bug-free: SQLite itself refuses any row that would violate the invariant,
independent of what code path tried to write it.

### D11 — `node:sqlite`'s pinned behaviours (ADR 0005 D17) extend to this issue's new surface without re-argument

**Decision.** Every `node:sqlite` behaviour ADR 0005's D17 already pins by test — PRAGMA posture,
`RAISE(ABORT)` error codes and verbatim messages, `changes`/`lastInsertRowid` typing, transaction-
open state after an abort, upsert trigger ordering — continues to be relied upon here without
re-litigating the choice of `node:sqlite` itself. This issue adds new pins where its own schema
introduces new surface: migration 4's statement hash, the version-4 schema fingerprint, the
regenerated `terminal-schema.sql` witness, and `crash.test.ts`'s `SCHEMA_FINGERPRINTS["4"]`.

**Rationale.** ADR 0005 already recorded that `node:sqlite` is a Release Candidate whose behaviour
is pinned by test rather than assumed, and already rejected `better-sqlite3` and unpinned reliance
on the RC's behaviour for reasons that do not change between issues. Re-arguing the same choice
here would duplicate that ADR's reasoning for no new information; this issue's obligation is to
extend the pinned surface to cover what it adds, which it does.

### D11a — Guard triggers on the new tables, named as their own decision

**Decision.** `artifact` carries four triggers: `*_first_revision` and `*_causal_update` (the
standard projection-table pair) **plus** `BEFORE UPDATE`/`BEFORE DELETE` `RAISE(ABORT)` (the
append-only pair). `stage_artifact_alias` carries only the standard projection pair.

**Rationale.** This is called out as its own decision, separate from D10's DDL, because getting the
*template* wrong here is the specific, previously-measured failure mode: `state_event` (ADR 0005's
journal) is append-only and mirroring its trigger set alone onto `artifact`/`stage_artifact_alias`
would have been the wrong template for `stage_artifact_alias`, and stopping at the append-only pair
for `artifact` alone would have left it without the first-revision/causal-update guards every other
projection table in this package carries — silently exempting the newest projection table from an
invariant `command/commit.ts`'s own docblock states must hold "against any writer." Choosing
projection-pair-only for `stage_artifact_alias` and projection-pair-plus-append-only-pair for
`artifact` is the one combination that is faithful to what each table actually is: one mutable
projection row, and one table of immutable rows that also happens to be projected onto (revision-
and event-cited) rather than journaled.

### D12n — Six typed error classes, each naming only caller-supplied or already-derived-safe values

**Decision.** Every failure mode this issue introduces gets its own class, all extending
`StateStoreError` (ADR 0005's existing hierarchy) and exported from `errors.ts` alongside it:
`ArtifactValidationError` (the generic publication-step failure, wrapping the underlying
`ArtifactFileSystem` error via `cause`, carrying `relativePath` and which step failed);
`ArtifactDigestMismatchError` (carries `expectedHash`/`actualHash`, both hex strings); the
publication-quarantine failure `ArtifactQuarantinedError` (carries `relativePath`, raised only when
D3's quarantine-and-retry sequence itself fails to vacate the address); `StageAssertionFailedError`
(the S2/S3 assertion failure, carrying `relativePath` and `reason`); `ArtifactRecoveryError` (a
recovery-sweep failure, carrying `path` and `reason`); and `ArtifactCountExceededError` (the
per-`completeStage` artifact-count cap, carrying `count` and `limit`).

**Rationale.** `errors.ts`'s existing house rule (ADR 0005) is that a typed error names only
caller-supplied or already-derived-and-safe values — never artifact bytes, never an ambient value.
Six classes, not one generic `ArtifactError` with a `reason` string, because each carries a
genuinely different shape of caller-actionable detail (a hash pair to compare, a path plus a step
name, a count plus a limit), and collapsing them into one class with an untyped payload would push
every catch site back to string-matching a `reason` field — exactly the kind of stringly-typed
dispatch this package's typed-error discipline exists to avoid.

### D17 — `packages/secrets/src/file-store.ts`'s directory-fsync gap is a real, unrelated follow-up

**Decision.** A directory-fsync gap in `packages/secrets/src/file-store.ts`, discovered while
building this issue's own directory-fsync discipline (D3), is recorded as a follow-up issue rather
than fixed inline here.

**Rationale.** The gap is real — `file-store.ts` predates this issue's directory-fsync discipline
and does not apply it — but it belongs to `@heniek/secrets`, a package this issue does not touch
and has no charter to modify. Fixing it inline would be exactly the unrelated-backlog-work this
issue's own exclusions forbid ("no unrelated backlog work or speculative scope reduction").
Recording it and moving on, rather than either fixing it out of scope or silently ignoring it
because it was inconvenient to notice, is the correct-sized response.

## S1–S3 — the three cross-cutting structural rules

These three rules recur across D3/D4/D9 above; they are named once here because each closes a
specific, measured hole rather than being a stylistic preference.

**S1 — the receipt fd is pinned from `openExclusive`, and is never re-opened.** `openExclusive`
uses `O_RDWR|O_CREAT|O_EXCL`, not `O_WRONLY|…`, because the hash-and-size-stability validation
step does positional reads (`readAt`) on that same fd — `readAt` on an `O_WRONLY` fd is `EBADF`.
The publication receipt carries that exact fd forward; re-opening the final path afterward to
obtain a fresh "read-only fd" is forbidden, because a re-opened fd has no proven relationship to
the specific bytes that were validated — it names whatever is at that path *now*, which silently
degrades AC-1's "exact validated bytes" claim to "some bytes at this path, presumably the same
ones."

**S2 — the under-lock assertion checks `nlink >= 1`, never `nlink === 1`.** A crashed publisher's
`incoming/` residue is a hard link to a blob that is otherwise fully committed, durable, and
correct — that residue makes `nlink === 2` on a perfectly good blob. Requiring `nlink === 1` would
refuse that receipt permanently until an operator happened to run recovery, which would put AC-1
(no missing/partial/invalid artifact) in direct conflict with AC-3 (crash recovery does not lose
committed data) — the strict check would be "correct" about the count and wrong about the
consequence. `nlink >= 1` still catches the case that actually matters — a full unlink, `nlink ===
0` — while the separate `lstat(root/relativePath)` `ino`/`dev` equality check is what proves the
blob's *name* still resolves to the *inode* the fd was validated against, closing the gap `nlink
>= 1` alone leaves open (a same-count but different-identity swap).

**S3 — assertion-to-artifact pairing is a bijection on `relativePath`, checked before `BEGIN
IMMEDIATE`.** Pairing assertions to payload artifacts by array length or index would accept a
payload `[A, B]` paired with assertions `[assert(B), assert(A)]` — silently swapped, where each
individual `assert()` call still succeeds (both blobs genuinely exist and are genuinely valid)
while validating a blob that the row it is paired with does not actually record. The pairing is
instead: every payload artifact has exactly one assertion whose `relativePath` equals it, and no
assertion is left unmatched — a multiset equality, not an order-preserving one, since a legitimate
payload can cite the same content twice under two different names. This check is pure, in-memory,
and runs **before** `BEGIN IMMEDIATE`, so a malformed call is refused without ever taking the
RESERVED lock and burning a concurrent writer against the busy timeout for a call that was always
going to fail.

## Testing strategy

Six layers, matching ADR 0005's convention of aiming each layer at a specific claim:

- **Content-addressing and idempotency (AC-1, AC-2).** `link`-not-`rename`, `EEXIST` idempotent
  adopt, digest-mismatch quarantine (never permanent poisoning), caller-supplied `path`/
  `contentHash` disagreement refused.
- **Transaction boundary and the AC-1 guard (§16.6, D4, D7).** The under-lock S2 assertion, the
  pre-lock S3 bijection, `assertGuardedWritesAreVerified`'s structural refusal of any unverified
  write into `artifact`/`stage_artifact_alias` — through the public `commitStateChange`, not only
  through `completeStage`.
- **Fault injection at each durability boundary.** Post-write, post-fsync, post-link,
  post-directory-fsync failures on the `ArtifactFileSystem` port, each asserted to leave no
  half-committed state.
- **Crash matrix.** Real child processes, `SIGKILL`ed at each durability boundary (post-write,
  post-fsync, post-link, post-event, post-projection), reopened and inspected for classification
  correctness and retry success with no committed-data loss.
- **Concurrency and immutability (R9).** A filesystem-only concurrent-reader case (stable bytes
  under adoption), a bounded concurrent-writer case (typed busy error within the 5 s timeout, never
  a hang), and `UPDATE`/`DELETE` on `artifact` raising `ABORT`.
- **Inventory re-verification (D8's detection half).** `listArtifacts` re-hashes every row's
  current on-disk bytes against its recorded `content_hash` and reports `verified: false` — without
  removing the row — for a tampered or vanished blob, which is what the residual TOCTOU window
  relies on for after-the-fact detection rather than prevention.

## Consequences

Later issues that add a stage lifecycle (status, attempts, a dependency graph, a scheduler) gain a
proven publication-and-completion primitive to build on: publishing an artifact and completing the
stage that produced it are already one atomic, content-addressed, crash-safe unit, and the AC-1
guard means no future event type can accidentally acquire write access to `artifact` or
`stage_artifact_alias` without an explicit, reviewable edit to the guarded-table set.

The cost is real and worth naming. `completeStage` owns filesystem-assertion evaluation inside a
SQL transaction, which is a genuinely unusual shape — most of this package's other invariants live
entirely inside SQLite. That shape is where the residual TOCTOU window (D8) lives, and it is not
closable without filesystem-level locking this issue deliberately leaves to Q008. Blob GC/retention
(D5) and cross-process single-writer enforcement (D5a) are both real, deferred obligations with
named owners, not abandoned scope.

### Open questions carried forward

1. **Q1 — §16.6 steps 4 and 5 read as two numbered steps but ship as one transaction.** Handled by
   construction (D4); the product specification's numbering is deliberately not amended, for the
   reasons D4 states.
2. **Q2 — Is step 6 meant to be an actual dispatch call?** Out of scope for this issue; shipped as
   derived state only (D6), with a test asserting no release/dispatch call exists.
3. **Q3 — Unreferenced blobs are never reclaimed.** Out of scope (D5); the blob GC/retention
   follow-up issue is filed separately.
4. **Q4 — Should `<root>` be refused when it sits inside a git checkout?** Rejected, for
   consistency with how this package's sibling stores (e.g. `packages/secrets`) already handle
   their own root paths — introducing a git-awareness check here would be a one-off inconsistency
   with the rest of the repository's storage packages, not a safety property this issue's
   acceptance criteria require.
5. **Q5 — `ArtifactRefV1` keeps both `path` and `contentHash`, which looks redundant.** Kept
   deliberately (D2/D8): this mirrors an OCI-style descriptor (digest *and* locator), keeping the
   ref self-describing without a second lookup. `path` is output-only — a caller-supplied `path`
   that disagrees with the derived one is refused outright, so the redundancy can never become a
   source of disagreement between the two fields.

### Review coverage obtained, and not obtained

As with ADR 0005, sub-agent dispatch (expert consultation, a dedicated concurrency reviewer for
D5a's time-domain reasoning) was suppressed by explicit instruction during this build. The
compensating measures were the mechanical gates already in place — the determinism scan, the
credential-field scan, the fault-injection and crash-matrix suites, and the multiple in-build fix
cycles visible in this package's own commit history (each documented inline at its call site: H1,
H2, J1–J4, Q1, S1–S3) — plus the explicit, adversarial re-derivation of D5a's rejected alternative
recorded above. A reviewer should treat D5a's time-domain argument and D8's TOCTOU-window scope as
**self-reviewed only**, in the same sense ADR 0005 flagged its own permission surface.

## Not in scope

- Stage lifecycle (status, attempts, a dependency graph, a scheduler) — none of these contracts
  exist yet in this repository; step 6 (D6) ships as derived state with nothing to release into.
- Blob garbage collection / retention (D5) — a retention-policy decision with no requirement yet.
- Cross-process single-writer enforcement (D5a) — chartered to Q008.
- Any CLI surface (Q009). Any remote or network-backed store.
- Semantic interpretation of artifact content by downstream models.
- `packages/secrets/src/file-store.ts`'s directory-fsync gap (D17) — real, unrelated, follow-up
  only.

Not simulated anywhere, and stated rather than faked: power loss and lying `fsync`, filesystem
corruption from outside this process, and a hostile process with filesystem access to the store
root deliberately racing the TOCTOU window D8 describes.
