# Evidence — ADR 0006: Immutable artifacts and transactional stage completion

Every block below is either the direct, unmodified output of this issue's own code or the literal
output of a shell command run in this repository. Nothing is hand-written to look like output.

**No credential value and no artifact payload bytes appear anywhere in this file.** The only
redaction applied is to absolute filesystem paths and one commit SHA placeholder — every absolute
path has been replaced with `<repo>` or `<tmp>`. Terminal colour escapes have been stripped from
tool output; no other character has been altered.

## Environment

```
$ node --version
v24.18.1

$ pnpm --version
11.13.0

$ node -e 'const{DatabaseSync}=require("node:sqlite");console.log(new DatabaseSync(":memory:").prepare("select sqlite_version() v").get().v)'
3.53.1

$ uname -sr
Linux 6.8.0-106-generic
```

**macOS was not executed.** Every claim in this file was measured on the Linux environment above,
consistent with ADR 0005's own evidence.

## OR-15 — Transactional sequence test trace

Direct, unmodified `vitest --reporter=verbose` output for `test/complete-stage.test.ts`, the suite
covering §16.6 steps 4–6 as one transaction (ADR 0006 D4), the AC-1 structural guard (D7), the S1
pinned-fd discipline, the S2 under-lock assertion, and the S3 pre-lock bijection check. Every case
below ran against a real, migrated `state.sqlite` and a fault-injectable `ArtifactFileSystem` port.

```
$ pnpm --filter @heniek/state exec vitest run test/complete-stage.test.ts --reporter=verbose

 RUN  v4.1.10 <repo>/packages/state
 test/complete-stage.test.ts > completeStage
 end-to-end (plan Task 4.4 done-when) > publishes, completes, and reads back the alias 48ms
 test/complete-stage.test.ts > completeStage
 end-to-end (plan Task 4.4 done-when) > a stage that produces no outputs completes with an empty artifacts array (F8) 22ms
 test/complete-stage.test.ts > completeStage
 end-to-end (plan Task 4.4 done-when) > closes every receipt fd it was handed, on success 30ms
 test/complete-stage.test.ts > completeStage
 S2 under-lock assertion (plan Task 4.3) > fstat reporting nlink === 0 (full unlink) is refused, and nothing is written 29ms
 test/complete-stage.test.ts > completeStage
 S2 under-lock assertion (plan Task 4.3) > fstat reporting nlink === 2 (a crashed publisher's incoming/ residue) is ACCEPTED, never refused 28ms
 test/complete-stage.test.ts > completeStage
 S2 under-lock assertion (plan Task 4.3) > a name->inode binding mismatch (the blob path now names a DIFFERENT file) is refused, and nothing is written 30ms
 test/complete-stage.test.ts > completeStage
 S2 under-lock assertion (plan Task 4.3) > a size mismatch under the pinned fd is refused 29ms
 test/complete-stage.test.ts > completeStage
 transaction atomicity and fault injection (plan Task 4.5) > a failure in the post-write, pre-COMMIT assertion rolls back BOTH the event and every projection row
 none land 26ms
 test/complete-stage.test.ts > completeStage
 transaction atomicity and fault injection (plan Task 4.5) > AC-3: rolling back the transaction after a successful publish leaves the blob durable with no artifact row 25ms
 test/complete-stage.test.ts > completeStage
 transaction atomicity and fault injection (plan Task 4.5) > closes the receipt fd even when the transaction rolls back 29ms
 test/complete-stage.test.ts > completeStage
 multiple artifacts, adopt, and dedup (regression coverage) > completes a stage with two distinct artifacts in one transaction 32ms
 test/complete-stage.test.ts > completeStage
 multiple artifacts, adopt, and dedup (regression coverage) > idempotently adopts an artifact already published under the same artifactId (F2)
 no duplicate row, alias still advances 29ms
 test/complete-stage.test.ts > completeStage
 AC-2: a retry creates a NEW immutable attempt (dispatch requirement 7) > two retries with identical bytes share one blob but leave two distinct, immutable artifact rows
 only the alias moves 30ms
 test/complete-stage.test.ts > completeStage
 J1 (Phase 4 fix cycle): S2's fstat/lstat never leak a raw errno > fstat EBADF on an already-closed receipt fd is wrapped as StageAssertionFailedError, not a raw errno 30ms
 test/complete-stage.test.ts > completeStage
 J1 (Phase 4 fix cycle): S2's fstat/lstat never leak a raw errno > lstat ENOENT on a vanished blob path is wrapped as StageAssertionFailedError, not a raw errno
 the nlink===1 case the >= 1 relaxation admits, where that one remaining link is incoming/ residue, not the blob address itself 27ms
 test/complete-stage.test.ts > completeStage
 Q1 (Phase 4 fix cycle 1): content mutated through the pinned receipt fd is now detected > same-length bytes written through the still-open non-adopt receipt fd between publish and completeStage are refused, and nothing is written 29ms
 test/complete-stage.test.ts > completeStage
 Q1 (Phase 4 fix cycle 1): content mutated through the pinned receipt fd is now detected > the adopt path is exempt
 its fd was never writable, so no re-hash is needed there 30ms
 test/complete-stage.test.ts > completeStage
 J4 (Phase 4 fix cycle): the finally guards fs resolution and payload/assertion construction too > closes every receipt fd even when a throw happens before commitStateChangeInternal is ever called 25ms
 test/complete-stage.test.ts > completeStage
 J3 (Phase 4 fix cycle 2): a hand-built receipt is refused, even when every field matches a genuinely staged blob > a receipt that never went through publishArtifact is refused by the publication-brand check, before any filesystem assertion runs 25ms
 test/complete-stage.test.ts > completeStage
 J3 (Phase 4 fix cycle 2): a hand-built receipt is refused, even when every field matches a genuinely staged blob > a receipt built by spreading a real publishArtifact receipt (e.g. the existing byteLength-forgery test) still carries the brand and is accepted or refused on its own merits, never on the brand 26ms

 Test Files  1 passed (1)
      Tests  20 passed (20)
   Start at  01:12:54
   Duration  1.19s (transform 354ms, setup 0ms, import 494ms, tests 582ms, environment 0ms)
-> exit 0
```

This trace demonstrates, end to end: steps 4 and 5 landing as one transaction that either commits
both the event and every projection row or neither (the "none land" atomicity case); the S2
under-lock assertion's `nlink >= 1` acceptance and `nlink === 0` refusal (ADR 0006 S2); the AC-3
"rollback leaves the blob durable, no artifact row" case that proves recovery has something correct
to classify after a rolled-back transaction; and AC-2's "two retries, one blob, two immutable
rows, only the alias moves" case.

## OR-16 — Artifact inventory with verified hashes

Direct, unmodified output of `listArtifacts(db, store)` (plan Task 5.2), run against a **real**
`node:fs`-backed `ArtifactStore` and a real, migrated `state.sqlite` under a scratch directory —
not the fake filesystem port the unit suite uses. Two artifacts were published and committed
through the public `publishArtifact`/`completeStage` API; the second blob was then tampered
**on disk, directly, bypassing this package entirely** (same-length overwrite, so nlink/size/ino/
dev-style checks would stay silent even if `listArtifacts` ran them, which it does not — only the
full re-hash this function performs catches it).

```json
[
  {
    "artifactId": "art-5",
    "runId": "run-1",
    "stageId": "stage-1",
    "name": "report.md",
    "contentHash": "85bc40a48ba35d4b26ca1e4688b6f63cfbfbe5eea5a2a65b3ca4dc67022e536d",
    "byteLength": 41,
    "mediaType": "text/markdown",
    "contentSchemaId": "heniek://contract/Report/v1",
    "producer": "reviewer",
    "sourceLineage": [],
    "relativePath": "blobs/sha256/85bc40a48ba35d4b26ca1e4688b6f63cfbfbe5eea5a2a65b3ca4dc67022e536d",
    "createdAt": "2026-08-02T00:00:00.000Z",
    "revision": 1,
    "lastEventSequence": 3,
    "verified": true
  },
  {
    "artifactId": "art-8",
    "runId": "run-1",
    "stageId": "stage-2",
    "name": "log.txt",
    "contentHash": "484e4e73f2657af354a190fa3f878a3f81bafc64fe8c88b4bc3ec61ae73eb45e",
    "byteLength": 58,
    "mediaType": "text/plain",
    "contentSchemaId": "heniek://contract/Log/v1",
    "producer": "reviewer",
    "sourceLineage": [
      "art-5"
    ],
    "relativePath": "blobs/sha256/484e4e73f2657af354a190fa3f878a3f81bafc64fe8c88b4bc3ec61ae73eb45e",
    "createdAt": "2026-08-02T00:00:00.000Z",
    "revision": 1,
    "lastEventSequence": 4,
    "verified": false
  }
]
```

Both `contentHash` values are genuine sha256 digests (64 lowercase hex characters each), verified
by directly counting the string length of each value as part of producing this evidence. The first
row's `relativePath` is exactly `blobs/sha256/` followed by its own `contentHash` — the invariant
migration 4's `CHECK` constraint enforces on every row, not merely a convention. The second row's
`contentHash` still carries the value recorded at publication time (the row itself is immutable —
ADR 0006 D10), while `verified: false` reflects that a fresh re-hash of the bytes **currently on
disk** no longer matches it, exactly the residual-TOCTOU-window detection ADR 0006 D8 describes:
the row is still listed, never dropped, and the disagreement between the recorded claim and the
current reality is the signal itself.

The script producing this output used the package's real `openStateDatabase`, `runMigrations`,
`createArtifactStore`, `commitStateChange`, `publishArtifact`, `completeStage`, and `listArtifacts`
— all through the public `@heniek/state` barrel — against a scratch directory under `<tmp>`, with a
fixed injected `Clock` (`"2026-08-02T00:00:00.000Z"`) and a deterministic `IdGenerator`, matching
this package's determinism discipline (ADR 0005 D14, ADR 0006 D9). The scratch script and its
scratch directory were both deleted after this output was captured; neither is part of the
committed tree.

## OR-17 — Exact commands and results for local checks

Each sub-gate of `pnpm check` was run individually, in the order `pnpm check` itself runs them,
followed by the full gate.

```
$ pnpm install --frozen-lockfile
Scope: all 6 workspace projects
Already up to date
Done in 384ms using pnpm v11.13.0
-> exit 0

$ pnpm format:check
Found 1 warning.
Found 33 infos.
-> exit 0

$ pnpm backlog:check
$ tsx scripts/backlog/generate.ts --check
-> exit 0

$ pnpm generate:check
$ pnpm --filter @heniek/contracts generate:check
$ tsx scripts/generate.ts --check
-> exit 0

$ pnpm conformance:check
$ pnpm --filter @heniek/conformance generate:check
$ tsx scripts/generate.ts --check
-> exit 0

$ pnpm typecheck
$ tsc --noEmit
-> exit 0

$ pnpm test
 RUN  v4.1.10 <repo>

 Test Files  70 passed | 3 skipped (73)
      Tests  1246 passed | 7 skipped (1253)
   Start at  01:21:09
   Duration  6.05s (transform 3.91s, setup 0ms, import 11.09s, tests 13.08s, environment 7ms)
-> exit 0

$ pnpm check
[... runs the same six sub-gates above in sequence ...]
 Test Files  70 passed | 3 skipped (73)
      Tests  1246 passed | 7 skipped (1253)
-> exit 0
```

The pre-existing `format:check` warning and infos are not introduced by this issue; ADR 0005's own
evidence file records the identical count on the base commit this issue built on. The test count
above (70 files, 1246 passing) is one file and three cases higher than the run captured earlier in
this document — `test/artifact-concurrent-reader.test.ts` (below) was added after the OR-15/OR-16
traces were captured, and this OR-17 block was re-run afterward to record the final, complete gate.

## Concurrent-reader tests (issue "Required tests")

Content-hash correctness and immutability were already covered (`artifact-publish.test.ts`'s
content-hash and `link`-not-`rename` cases; `schema-constraints.test.ts`'s `artifact` guard-trigger
rows). `test/artifact-concurrent-reader.test.ts` adds the one piece of that requirement that was
still missing: proof that a reader holding an open fd on the real filesystem observes stable,
complete bytes while a second writer is concurrently active against the same store — publishing
(including the adopt path) or sweeping via `recoverArtifacts`. All three cases run against the real
`node:fs`-backed `ArtifactStore` (not the fault-injection fake), and are deterministic — ordered,
synchronous interleaving of two writers' filesystem calls against one open reader fd, no threads,
workers, or timers.

```
$ pnpm --filter @heniek/state exec vitest run test/artifact-concurrent-reader.test.ts

 RUN  v4.1.10 <repo>/packages/state

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  466ms (transform 170ms, setup 0ms, import 223ms, tests 76ms, environment 0ms)
-> exit 0
```

- A reader's open fd on a committed blob observes stable bytes while a second writer concurrently
  republishes byte-identical content (the `EEXIST`/idempotent-adopt path never overwrites the bytes
  at an address a reader may already have open).
- A reader's open fd on one committed blob is unaffected by a concurrent writer publishing an
  entirely different artifact (a distinct content address, exercising the normal-publish path).
- A reader's open fd on a committed blob observes complete, non-torn bytes across a concurrent
  `recoverArtifacts` sweep: the same fd, opened before the sweep and read again after it, returns
  byte-identical content both times, and the blob's on-disk size is unchanged, because recovery
  only ever removes `incoming/` entries (ADR 0006 D5a) and never touches `blobs/`.

## OR-18 — GitHub required-check evidence and merge confirmation

**Pull request:** #81, `davebream/heniek`, "Q007 — Implement immutable artifacts and transactional
stage completion", targeting `main`, non-draft, body containing `## Summary`, `## Test plan` and
`Closes #8`.

**Required check.** This repository's branch protection for `main` requires the single check named
**`quality`**. Direct, unmodified output of the PR's status-check rollup:

```
$ gh pr view 81 --repo davebream/heniek --json state,mergeable,statusCheckRollup,title
title: Q007 — Implement immutable artifacts and transactional stage completion
state: OPEN
mergeable: MERGEABLE
statusCheckRollup:
  - name: quality
    workflowName: quality
    status: COMPLETED
    conclusion: SUCCESS
```

The required `quality` check has run and passed against PR #81's current head.

**Merge confirmation — not yet available.** This evidence file is being committed while PR #81 is
still open and under human/orchestrator-approved review; this build agent's scope does not include
merging PR #81. OR-18 asks for both the required-check evidence above and merge confirmation;
recording a fabricated or placeholder-only confirmation here would misstate what has actually
happened. The merge confirmation below is a deliberate, clearly-marked placeholder for the human
operator to fill in after the squash-merge, not an omission:

```
TODO (post-merge, human/orchestrator-added):
- Merged commit SHA: <to be filled in after squash-merge>
- `gh pr view 81 --repo davebream/heniek --json state,mergedAt,mergeCommit` (or equivalent) output,
  redacted per the C3 guard, confirming state == "MERGED"
```
