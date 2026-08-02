# 7. Daemon single-instance lifecycle and local authentication

- Status: accepted
- Date: 2026-08-02
- Issue: davebream/heniek#9 (Q008, T1-foundation, milestone M1)
- Spec anchors: §6.1 §6.3 §7 §16.3 §18
- Evidence: [evidence/0007-daemon-lifecycle-evidence.md](evidence/0007-daemon-lifecycle-evidence.md)

## Context

Q007 (ADR 0006) landed the artifact store and made `completeStage` the package's only mutation
path that also touches the filesystem. It left one obligation explicitly unclosed: "cross-process
single-writer enforcement is chartered to Q008 and explicitly out of scope" (ADR 0006 D5a). §6.1
requires the daemon to "enforce a single authenticated local instance, own durable work
independently of clients, and reconcile state after clean or unclean shutdown". §6.3 requires
authenticated JSON-RPC 2.0 over a Unix domain socket, restrictive local-secret permissions, and
auditability. §18 requires durability and recovery — §18.2 in particular maps an unresolvable run
to `recovery_required`. This issue answers all three obligations by shipping `@heniek/daemon`
(`packages/daemon`): a filesystem-authoritative single-instance claim, a challenge-response
authenticated NDJSON JSON-RPC control surface on `runtime/daemon.sock`, and a pre-bind
crash-recovery reconciliation pass.

## Decisions

### C-1 — Restart classification is a result type, not a `RunStatus` value

**Decision.** `RunRecoveryClass = "resumable" | "failed" | "cancelled" | "unknown"`, shipped as a
plain tuple in `packages/contracts/src/daemon/state.ts` (not `defineStates` — that helper enforces
a terminal/non-terminal partition a classification result does not have) and carried on the wire by
`RunRecoveryClassification/v1`. `RunStatus` (`Run/v1`, pinned `be0a661b93de…`) is referenced, never
extended. `classify.ts` (`packages/daemon/src/recovery/classify.ts`) is a total, pure function from
one probe outcome to one `(RunRecoveryClass, RunStatus)` pair: `"failed"` → `failed`/`failed`;
`"cancelled"` → `cancelled`/`cancelled`; `"succeeded"` → `resumable`/`succeeded` (immediately
settled); `"queued"`/`"running"`/`"waiting_on_user"` → `resumable`/the probed status unchanged;
`"recovery_required"`, a probe throw, or an unresolvable run → `unknown`/`recovery_required`
(§18.2 verbatim).

**Rationale.** Adding `resumable` to `RunStatus` would move `Run/v1`'s pinned digest for a schema
that has real consumers (`packages/state/src/projection/run.ts` narrows on it and raises
`StateDatabaseCorruptionError` on an unrecognised value) — the pin's own governing rule
(`packages/conformance/test/contracts-compatibility.test.ts:22-27`) permits that only with recorded
proof of an empty consumer set, which does not exist here. A classification result also is not
durably queryable state a run can sit in: it is re-derived by probing fresh on every restart, which
is the honest behaviour — a stale classification surviving in the database would be exactly the
kind of stored-liveness inference OR-8 forbids.

**Rejected: adding `resumable` (or a fourth value generally) to `RunStatus` directly.** See
`## Alternatives Considered` row E in the design; rejected for the digest-churn reason above, and
because §17.1's state diagram never contemplates "resumable" as a state a run sits in.

**AC-3 scoping note, stated honestly.** Against real stored state today, every non-terminal run
resolves "backend does not know the run" → `unknown`, because nothing in this repository yet
persists a backend-native run id anywhere `run_projection` or the reducer can read back — `run.runId`
(this package's own identifier) is the only value this pass has to offer `backend.status()`. This is
recorded as an honest residual (OR-8), not a defect: the four-way split is proven exhaustively
against the deterministic scripted handle (C-2), and the production handle-bearing set being empty
today is sequencing, not a narrowed commitment.

### C-2 — A local scripted `ExecutionBackend` handle, not a Claudexor adapter

**Decision.** `packages/daemon/test/helpers/scripted-backend.ts` implements all seven
`ExecutionBackend` methods; the four the reconciler must never call throw on invocation, which is
itself the proof that the restart pass never calls `start`. It is a **local** helper, not an import
of `packages/conformance/src/fakes/execution-backend.ts` — a workspace dependency from
`@heniek/daemon` onto `@heniek/conformance` would invert the intended dependency direction and
contradict the no-cross-package-coupling decision already recorded at
`packages/state/test/no-ambient-sources.test.ts:9-21`. It contains no wall clock, randomness,
timers, process spawning, filesystem, or network access — every answer is scripted, so a recovery
run is reproducible byte-for-byte.

**Rationale.** OR-17 ("recovery tests against deterministic backend handles") names no existing
artifact in this repository. `packages/conformance/src/smoke/claudexor/daemon-handle.ts` was
considered and rejected: it is real-process and real-time, and is explicitly exempt from the
determinism ban (`packages/conformance/test/no-wall-clock.test.ts:41-59`) for reasons that do not
transfer to this issue's own pure recovery core. Defining "deterministic backend handle" concretely,
inside this package, is what lets `classify.ts`'s total function be exercised against every branch
of its own table without ever touching a real engine.

### C-3 — `INTERRUPTED_MAPPING_IS_PROVISIONAL` is explicitly re-deferred, not resolved

**Decision.** `packages/conformance/src/smoke/claudexor/state-map.ts`'s
`INTERRUPTED_MAPPING_IS_PROVISIONAL` stays `true`; the `interrupted → recovery_required` mapping is
unchanged. The docblock is rewritten to record two things: (i) Heniek's own daemon restart, as
shipped by this issue, does **not** decide it — the flag concerns what **Claudexor** reports, and
deciding it requires observing a real engine after a restart, which this issue does not build (C-2);
and (ii) a sharpened deciding criterion — after Q008, `recovery_required` has a precise operational
meaning, "the probe did not return a status the backend asserts with knowledge", so a Claudexor
`interrupted` that **is** asserted with knowledge should map to `failed` or `cancelled` instead, and
the deciding experiment must determine which. The stale "Canary 4 (daemon restart / recovery)"
pointer is replaced accordingly.

**Rationale.** Q008 consumes `ExecutionBackend` as a port and tests exclusively against the scripted
handle (C-2); it structurally cannot produce the evidence the old pointer implied it would. Leaving
the pointer in place would have quietly turned a real, unresolved question into an apparently
closed one the day this issue shipped, without anyone having actually observed the engine.

### C-5 — `@heniek/daemon` ships as a library in `packages/*`, with a permanent typecheck-coverage guard

**Decision.** The package lives at `packages/daemon`, `"private": true`, `"exports": {".": "./src/index.ts"}`,
identical in shape to `packages/state/package.json`. No root `tsconfig.json` edit was made:
`include` (`tsconfig.json:23-28`) already covers `packages/*/{src,test,scripts}/**/*.ts`, so
`tsc --noEmit` typechecks every new file with zero configuration change. A permanent guard,
`packages/daemon/test/typecheck-coverage.test.ts`, reads the root `tsconfig.json` at runtime and
asserts by `globSync` file-membership that `packages/daemon/src/index.ts` and
`packages/daemon/test/typecheck-coverage.test.ts` are both matched by some `include` glob, plus an
inert-today assertion that fires the day an `apps/*/src` directory exists without a matching
`include` entry.

**Rationale.** This buys coverage rather than merely asserting it: a future edit that narrows
`include` breaks the guard immediately, instead of silently un-typechecking the package. Direct
proof that the coverage is real, not merely claimed, is the deliberate-type-error probe recorded in
the evidence sidecar (OR-21): a type error injected into a new `packages/daemon/src` file is caught
by `pnpm typecheck`, naming that file, and the injection was reverted immediately after capture.

**Rejected: `apps/heniek-daemon` plus an `include` edit.** (`## Alternatives Considered` row I.)
Literal compliance with `AGENTS.md:18`'s deployable-unit language, but it would edit a root config
shared by every package for a unit with no deployable surface yet, and would newly let vitest
discover `apps/**` tests with no scripts wired (there is no root `vitest.config.*`). `AGENTS.md:18`'s
clause is read here as being about deployable units — a library a future binary imports is exactly
its "focused library" case — and the guard above closes the gap the moment an `apps/*` unit exists
without one.

### C-6 — `src/runtime/**` is the package's single determinism-gate exemption

**Decision.** `packages/daemon/test/no-ambient-sources.test.ts` carries a local copy of
`FORBIDDEN_PATTERN` (mirroring the deliberate no-cross-package-coupling decision at
`packages/state/test/no-ambient-sources.test.ts:5-21`) and scans `packages/daemon/src/**`. The
carve-out is modelled on `packages/conformance/test/no-wall-clock.test.ts:41-59`: a
separator-independent `relative(srcRoot, file).split(sep)` whose **first** segment must be exactly
`runtime`. Three assertions keep the exemption auditable: a non-vacuity lower bound on the count of
scanned non-exempt files; a negative control proving the pattern still matches every construct it
claims to forbid; and an exemption-scope assertion that the set of files under `src/runtime/**`
equals an explicit allowlist, with no file outside it importing `node:net`, `node:crypto`, or
reading `process.platform`. The shipped `src/runtime/**` tree carries eleven adapters: `clock`,
`compose`, `host-witness`, `lock-filesystem`, `mac`, `process-liveness`, `random-source`, `signals`,
`socket-probe`, `socket-server`, `trace-sink`.

**The `MacProvider` port (plan-review round 1 reviewer B, finding M5) is a deliberate, ratified
addition to C10's port list, not an incidental one.** `src/auth/verify.ts` stays pure over an
injected `MacProvider` rather than importing `node:crypto` directly, which is what lets it remain
outside `src/runtime/**` and be exercised deterministically. The rejected alternative was narrowing
the determinism gate's assertion to cover only `node:net` and letting `verify.ts` import
`node:crypto` directly for HMAC and constant-time comparison; that would have weakened C10's own
"pure core over injected ports" claim for the one component whose correctness this issue's threat
model most depends on. The compensating control is the RFC 4231 HMAC-SHA256 known-answer test suite
plus at least one full authenticated request/response pair run against the real
`createHmacSha256MacProvider()` adapter (`packages/daemon/src/runtime/mac.ts`), so the pure core and
the real cryptography are each independently proven correct.

### C-7 — Filesystem-authoritative single-instance claim; bind is last

**Decision.** Single-instance authority is the filesystem, not SQLite: an atomic-publish claim at
`runtime/daemon.pid`. The complete, LF-terminated claim record is written to an `O_EXCL` temp file,
`fsync`ed, and `link(2)`ed onto `daemon.pid` — never `openSync(daemonPidFile, "wx")` followed by a
second `writeSync`, and never `rename(2)` onto the published name (see the two withdrawn shapes
below). `link`'s `EEXIST` supplies the same exclusion `O_EXCL` would; because the published name only
ever appears as a hard link to an already-complete, already-durable inode, `daemon.pid` is
atomically complete-or-absent and can never be observed torn or zero-length. Startup is strictly
ordered: **claim → probe → reclaim → open DB → migrate → recover → classify → bind → publish →
attach handler.** Binding last makes "connectable implies fully recovered" true — no readiness
protocol is needed, because no client can observe an intermediate state. Holding the claim across
the whole path makes the socket reclaim and the recovery pass single-threaded by construction.
Takeover of an orphaned claim is `rename(2)`-aside: exactly one racer's rename lands, every other
gets `ENOENT`, so there is no lock file that can become a poison pill after a `SIGKILL`. Publishing
`serving` is a single positional rewrite of the claim record's fixed-width 8-byte `state` field
(`claiming` and `serving␠` are both exactly eight bytes) through the file descriptor held since claim
time — never a `rename` of a new inode onto the claim path. `bind()`'s kernel-atomic `EADDRINUSE` is
the final arbiter for the residual skew case: claim absent while a socket is nonetheless already
live.

**Two withdrawn shapes, each reopening a previously rejected mechanism in part and recorded here so
neither is silently reintroduced.**

- **Temp-plus-`link` claim, not `openSync("wx")` plus a second `writeSync`**
  (`## Alternatives Considered` row Q). The two-syscall form leaves a window in which a `SIGKILL`, an
  `ENOSPC`, or an unclean host shutdown between the open and the write leaves a zero-length or
  unterminated record at the published name with no living claimant — and because "no trailing LF
  means claim-in-progress, never stale" is itself correct and load-bearing, every subsequent start
  would concede with exit 10 forever: a permanent brick with no operator-visible remedy. Writing the
  complete record to an `O_EXCL` temp first, `fsync`ing it, then `link`ing it onto the published name
  makes a partial record unobservable at that name. This reopens `link(2)` in a form distinct from
  the two previously rejected uses of it (restoring a renamed-aside file, and a dedicated `O_EXCL`
  reclaim-token file) — neither rejection is weakened, because here `link` publishes a fully-written
  inode under its final name and leaves no artifact whose mere existence means "locked".
- **In-place field rewrite for publish, not temp-file-plus-`rename`**
  (`## Alternatives Considered` row R). `rename`ing a temp file onto `daemon.pid` installs a new
  inode while the held claim file descriptor still refers to the old, now-unlinked one, so
  `fstat(claimFd).ino !== lstat(daemonPidFile).ino` permanently from that instant —
  `assertStillHeld()`, which runs on every accepted connection, would kill the daemon on its first
  client, and `release()` would silently refuse to unlink the published record. Padding `serving` to
  `serving␠` so both states are eight bytes makes publish a single positional write at a fixed offset
  through the already-held fd: the inode never changes, so the claim identity is continuously the
  `link`-established one for the whole process lifetime. The rejected alternative was to keep the
  `rename` and re-anchor the guard onto the new inode afterward; rejected because it is strictly
  weaker (a window exists in which the guard vouches for an inode the process no longer holds), it
  needs a new `adoptIdentity` mutator whose mis-ordering could silently reintroduce the original bug,
  and it retains the successor-clobbering `rename`.

**A well-formed `claiming` record with a matching boot witness and a live pid is the *ordinary*
contended case, not an exotic one.** The design deliberately publishes `claiming` for the entire
startup path — DB open, migration, `recoverArtifacts`, and the full reconciliation loop — and writes
`serving` only at the very end, so in a four-way parallel start, three of the four losers observe
exactly this record while the winner is still starting. This concedes unconditionally at exit 10
(`ClaimInProgress`) with no socket probe needed to decide it, and is never folded into the
`serving`-record branch.

**Startup exit codes.** `0` success; `10` conceded (`AlreadyRunning`, `ClaimInProgress`,
`BindRaced`); `11` refused (`PidFileNamesLiveProcess`, `ForeignSocketOccupied`,
`InsecureRuntimeDirectory`, `InsecureClaimFile`, `InsecureSocketPath`, `ClaimContended`); `12`
recovery failure (state DB open/migrate or `recoverArtifacts` failed). Every non-zero startup exit
leaves the filesystem exactly as it found it — no losing or refusing path mutates any path it does
not own.

### The §16.3 reading — reconciled, not narrowed

**Decision.** §16.3's list of SQLite-authoritative categories, which names "locks and leases" among
its members, is read as the *domain*-lease catalogue — its siblings in that same list are
interactions, scheduling, and account queues — and is **reconciled with, not narrowed by**, this
issue's filesystem-authoritative single-instance claim. `docs/adr/0005-…:385-388` already encodes
exactly this split: "locks and leases" assigned to Q008/Q011, "scheduling"/"account queues" assigned
to Q021/Q025. The standing invariant this ADR records: **SQLite leases are intra-daemon leases; they
presuppose the instance lock and never arbitrate it.** A row inside `state.sqlite` cannot decide who
may open and migrate `state.sqlite` in the first place, nor who may run `recoverArtifacts` (a
`readdir`/`unlink` pass over `incoming/` entirely outside any SQL transaction) — those are exactly
the two operations the instance claim exists to gate, and gating them with a mechanism that itself
requires opening and migrating the database first (SQLite lease row, `## Alternatives Considered`
row B) is bootstrap-circular: the loser would have to perform the very writes the lock exists to
prevent, in order to learn that it lost.

### The §6.3 bullet-2 deferral — sequencing, not narrowing

**Decision.** §6.3's second bullet (the local web UI: bind to `127.0.0.1`, authenticated session,
Server-Sent Events) is deferred. `## Alternatives Considered` row F records why: no dashboard
consumer exists yet, so an authenticated network-facing listener today would be attack surface with
zero consumer, directly against §27.4's protection of local web tokens; §33 places `daemon/socket` in
Milestone 1, and the dashboard is not an M1 line item.

**This is structurally guaranteed additive, not merely promised.** The method registry, the auth
verifier, and the codec (JSON-RPC dispatch, MAC verification, NDJSON framing) are pure and
transport-agnostic; `src/runtime/socket-server.ts` is the only consumer of `node:net` in the whole
package. A later HTTP+SSE adapter registers against the same `MethodRegistry`
(`packages/daemon/src/rpc/methods.ts`) without touching dispatch or auth. The deferral removes
nothing this issue built and forecloses nothing a later issue would need to add.

### Credential rotation — every start, no rotation RPC

**Decision.** The local control credential (a 256-bit secret plus a 16-byte `keyId`, minted from the
injected `RandomSource`) is rotated on every daemon start and removed on clean shutdown. There is no
`daemon.rotateCredential` method. The authenticated method set for Q008 is exactly `daemon.status`
and `daemon.recovery`.

**Rationale.** NIST SP 800-63B-4's session-binding guidance is that such secrets "SHOULD NOT be
persistent… across a restart", which rotate-on-every-start alone discharges — OR-7's "rotating local
credentials" needs no additional mechanism. `daemon.rotateCredential` was drafted in plan review
(round 1, finding M2) with a result contract, then withdrawn in plan review round 2 (finding 13,
`## Alternatives Considered` row S): it cannot return the new secret without violating the
no-credential-in-payload rule, so every live client would silently de-authenticate mid-session with a
`-32001` response byte-identical to an attack, with no way to tell the two apart. The honest cost is
that an operator-initiated rotation requires a restart; Q009 (which owns the CLI) can surface that.

### Authentication — challenge-response, not a bearer token

**Decision.** NIST SP 800-63B-4 §3.2.7 states plainly that a static authenticator output replayed
verbatim is not replay-resistant. The daemon issues a fresh 32-byte challenge per connection from
`daemon.hello` (the single pre-auth method); every subsequent request carries
`{keyId, sequence, mac}` with `mac = HMAC-SHA256(secret, challenge ‖ "\n" ‖ sequence ‖ "\n" ‖
canonicalRequestBytes)`, `sequence` strictly increasing per connection, and comparison via
`crypto.timingSafeEqual` on two fixed-length 32-byte buffers (a `mac` failing the exactly-64-hex
shape check is rejected before `timingSafeEqual` is ever reached, so its throw-on-length-mismatch
behaviour can never surface as a crash or an oracle). `params.auth` is validated closed against
`DaemonRequestAuth/v1` (`additionalProperties: false`) **before** any MAC computation — the region
that check closes is exactly the region excised from `canonicalRequestBytes`, so an unconstrained
shape there would be unauthenticated by construction. The anti-replay window lives in the
connection's own in-memory state and dies with the connection; it does not need to survive restart,
because the secret is rotated on every start and every connection gets a fresh challenge, so replayed
bytes fail under any sequence against a new instance and fail again on a new connection of the same
instance.

**OS-level access control is the already-enforced 0700 `runtimeDirectory`, not the socket's mode
bits.** `unix(7)` states plainly that pathname-socket permission bits are ignored on some systems and
that "portable programs should not rely on this feature for security" (STD-2). `chmod 0600` on the
socket is applied as defence in depth and asserted by test, never claimed as the guarantee.

**The peer-credential gap (STD-1) is a documented limitation, not a silent omission.** Node.js 24
core exposes no binding for `SO_PEERCRED` (verified by a full-text scan of `doc/api/net.md` finding
zero hits for "peercred"); a native dependency to obtain it is forbidden by OR-10/IR-23. The
cryptographic challenge-response proof plus the independently re-verified 0700 runtime directory
replace it. A same-uid process on the host can still read the credential from the `SecretStore` — a
same-user-secret residual, stated rather than implied away.

### `daemon.hello`'s exemption from drain rejection

**Decision.** During `draining`, new frames are rejected with `-32000 "draining"` **except**
`daemon.hello`, which continues to be answered normally.

**Rationale.** `daemon.hello` is the exact frame the socket-liveness probe (used both by a starting
contender and by any client checking whether an instance is up) sends. Without the exemption, a
restart racing a graceful drain would see `-32000` on that frame too, which the probe's outcome
classifier maps to `hostile` — and `hostile` is deliberately never collapsed into `no-listener`, so
the starter would deterministically **refuse** with exit 11 `ForeignSocketOccupied` against a
perfectly healthy instance seconds from exiting. Answering `daemon.hello` during drain makes the
probe read `serving`, so the starter concedes with the retryable exit 10 `AlreadyRunning` instead —
the correct characterisation of "the previous instance is still shutting down". The exemption is safe
because `daemon.hello` carries no domain state and mutates nothing but the per-connection challenge.
The rejected alternative — `server.close()` the listener before switching to `-32000` — does not
work either: the probe then reads `ECONNREFUSED` (`no-listener`), but the claim record still says
`serving` with a live pid, which routes to `inspect → refused` (`PidFileNamesLiveProcess`, exit 11)
— the same bad outcome by a different path.

## Residuals — accepted, not closed

Recorded honestly, per this issue's own discipline and ADR 0006's precedent of naming what a design
does not close rather than implying it does.

- **The absent probe deadline.** `ExecutionBackend` carries no deadline in its contract, and
  `reconcile.ts` puts none on `backend.status()` — no `Deadline` port is injected anywhere in this
  package. This is a deliberate omission, not an oversight: **a wedged `backend.status()` hangs
  startup before the bind, leaving no socket to query — the daemon fails closed and visibly rather
  than serving a half-recovered state.** Adding a bound was declined because no contract mandates
  one, and a wrong bound would silently reclassify a slow-but-healthy backend as `unknown`. If a
  future issue adds a deadline, a timeout must classify `unknown` exactly like a throw, so the
  classification table stays unchanged either way.
- **The ancestor-swap TOCTOU.** The claim path independently `lstat`s both `runtimeDirectory` and its
  parent before ever opening a file inside it (mirroring `packages/state/src/database/open.ts:263-290`'s
  precedent for the state database directory). Node exposes no `openat(2)`, so a directory higher up
  the path than either of those two checked components can in principle still be swapped between the
  `lstat` and the subsequent `openSync`. This is a documented residual, not a closed hole.
- **`O_EXCL` is not atomic on NFSv2/v3.** The claim primitive assumes a POSIX-compliant local
  filesystem; this is not verified at runtime and is stated as a known limitation of the mechanism,
  matching STD-4's finding that `O_EXCL` is the only exclusive-create primitive Node core exposes.
- **A same-user process can always read the secret from the `SecretStore`.** The credential's
  confidentiality is bounded by OS user isolation, not by anything this package adds; this is the
  same boundary `packages/secrets` already documents for every other stored secret.

## Not in scope

- Any CLI surface (Q009). No shipped binary — the package is a library; the spawned entry point used
  by this issue's own out-of-process tests is a test helper only.
- The §6.3 bullet-2 web UI (127.0.0.1 HTTP + Server-Sent Events) — deferred, structurally additive
  (see above).
- `daemon.rotateCredential` — withdrawn entirely; rotation is discharged by rotate-on-every-start.
- Promotion of `SingleWriterToken` to a required parameter of `@heniek/state`'s `openStateDatabase` —
  the brand lives inside `@heniek/daemon` only (`## Alternatives Considered` row N); promotion is a
  later, explicit decision, not a silent scope creep.
- Peer-credential verification (`SO_PEERCRED`) — unimplementable on Node.js 24 core without a native
  dependency (STD-1); documented, not silently dropped.
- Deciding `INTERRUPTED_MAPPING_IS_PROVISIONAL` — explicitly re-deferred (C-3), with a sharpened
  criterion for whichever later issue observes a real Claudexor engine after a restart.
- Any change to `packages/state`'s behaviour. This issue's only `packages/state` edits are five
  comment-only docblock reconciliations naming the delivered enforcement this ADR describes, plus
  the residual caller obligation that does not disappear (see the evidence sidecar for the exact
  diffs, which are comment-only by construction and verified as such).

## Review coverage obtained, and not obtained

Following ADR 0005 and 0006's own precedent of stating this plainly: the dispatch-level agent policy
for this run permitted `kombajn-dev:architect` only, spent on a security/extensibility Contest Pair
for the C-7 semantic-control decision (see the design's `## Expert Consultation Log`). Both experts
returned `VERDICT: A` (filesystem-authoritative, bind last); the security-lens contest found nine
attacks on the first draft, eight adopted verbatim into the shipped algorithm, one (bind-first vs.
claim-first) deliberately deviated from with the rationale recorded in `## Alternatives Considered`
row P. Section-level risk review and the tier-`standard` critic dispatch were both suppressed by the
same dispatch-level policy; the design records this as a coverage gap (its `## Risks` item 2, `Q-5`).
A reviewer should treat this ADR's acquire-algorithm reasoning as reviewed by the Contest Pair and
this build's own multiple in-build fix cycles (each recorded inline at its call site — see the plan's
"plan-review round 1/2, finding …" citations throughout this ADR), not by an independent
post-implementation critic pass.
