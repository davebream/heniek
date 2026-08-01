# Evidence — ADR 0005: SQLite state store, migrations and append-only event journal

Every block below is either the direct, unmodified output of this issue's own code or the literal
output of a shell command run in this repository. Nothing is hand-written to look like output.

**No credential value and no payload bytes appear anywhere in this file.** The only redaction
applied is to absolute filesystem paths: every one has been replaced with a `$SCRATCH`, `$TMPDIR` or
`<repo>` placeholder. Terminal colour escapes have been stripped from tool output; no other
character has been altered.

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

**macOS was not executed.** Every claim in this file was measured on the Linux environment above.
Two behaviours in this package are platform-sensitive and are called out where they appear: POSIX
file modes (D13/R-V6), and the synchronous-versus-asynchronous behaviour of `process.stdout` on a
pipe, which is why the crash child writes its readiness line with `writeSync` on fd 1.

## E3 — the full gate, sub-gate by sub-gate

Each sub-gate was run individually, in the order `pnpm check` runs them.

```
$ pnpm install --frozen-lockfile
Scope: all 6 workspace projects
Already up to date
Done in 390ms using pnpm v11.13.0
-> exit 0

$ pnpm format:check
Checked 216 files in 164ms. No fixes applied.
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
 Test Files  60 passed | 3 skipped (63)
      Tests  1090 passed | 7 skipped (1097)
-> exit 0

$ pnpm check
-> exit 0
```

The pre-existing `format:check` warning and infos are not introduced by this issue; they are
reported identically on the base commit.

## E1 — the migration manifest

Direct output of this package's own `migrationManifest()`. The statement hashes are the values
committed in `test/fixtures/migration-statement-hashes.json`, and the suite asserts them equal on
every run — which is what makes migration 1 provably unedited since it shipped.

```json
{
  "currentVersion": 3,
  "entries": [
    {
      "version": 1,
      "name": "journal",
      "statementCount": 6,
      "statementHash": "d9b0432a951644d74cad99e34be6f9bf70cd70a09cb649bf4eb6c0020848ee7d"
    },
    {
      "version": 2,
      "name": "run_projection",
      "statementCount": 3,
      "statementHash": "5abccecca5ee155ab7526d1f11804b9751393d75cb3df706a1461eaa5e4fb3de"
    },
    {
      "version": 3,
      "name": "identity",
      "statementCount": 10,
      "statementHash": "4bf29f695b4aa90fde4de732d08275eff2d27f1b93376c2c8e3756bc906c8ef6"
    }
  ]
}
```

## E2 — a deterministic replay divergence report

Direct output of `compareProjectionToReplay()` against a scratch database under `$TMPDIR`, built by
two commands (`codebase.registered`, then `run.created`) through the public command API. Both
digests are reproducible across runs and machines because they are sha256 over canonical JSON.

```json
{
  "status": "converged",
  "eventsReplayed": 2,
  "throughSequence": 2,
  "divergences": [],
  "projectionDigest": {
    "stored": "28617929edcfd405bcca985ed3c113997aca46f55e8f3109af7997fec2257398",
    "replayed": "28617929edcfd405bcca985ed3c113997aca46f55e8f3109af7997fec2257398"
  },
  "schemaFingerprint": {
    "structural": "1e4e39af945e0eaf7d5ebf07339b7463f0eb570d4e7289baef6bd154dfde0349",
    "declared": "8be5e2a27ff92c9adca800ec1014d43442fba8995c378989cc5b8a1e3839f062",
    "userVersion": 3,
    "applicationId": 1213090609
  }
}
```

The `schemaFingerprint` values are the committed version-3 pins from
`test/fixtures/schema-fingerprints.json`, so this report is self-describing about the schema that
produced it.

## D13 / R-V6 — file modes on the database and both sidecars

Captured against a scratch directory under `$TMPDIR`, with the handle still open so the WAL
sidecars exist. `openStateDatabase` pre-creates the main file at `0600` **before** `DatabaseSync`
opens it.

```
600 $SCRATCH/state.sqlite
600 $SCRATCH/state.sqlite-wal
600 $SCRATCH/state.sqlite-shm
```

The defect this ordering exists to avoid is pinned as regression R-V6, which reproduces it directly:
letting SQLite create the files and repairing the main file with a later `chmod` leaves `-wal` and
`-shm` at the mode SQLite created them with. On this environment the umask is `0o007` and SQLite
creates database files from a `0o644` base, so the sidecars land at `0640` — readable by the file's
group. The regression test asserts against the mode SQLite actually used rather than a hand-computed
umask expression, so it stays correct under any umask.

## D15 / AC4 — the contract registry is unchanged

Q006 adds no `versioned()` contract schema. The pinned registry size is unchanged from its pre-Q006
value, and every pinned `sha256` in the contracts package is byte-identical (asserted by that
package's own suite, which runs green in the `pnpm test` block above).

```
SCHEMA_REGISTRY.size = 14
```

## §0.5 — the lockfile delta

A new workspace package requires an `importers:` entry, or CI's `pnpm install --frozen-lockfile`
fails before `pnpm check` ever runs. The enforceable fence is "no new resolved versions": the whole
diff is one hunk inside `importers:`, and `packages:`/`snapshots:` are byte-unchanged.

```
$ git diff --stat <base>..HEAD -- pnpm-lock.yaml
 pnpm-lock.yaml | 13 +++++++++++++
 1 file changed, 13 insertions(+)
```

Every added line, in full — note that all thirteen sit under `packages/state:` and every version is
either a workspace link or a version already resolved elsewhere in the file:

```
+  packages/state:
+    dependencies:
+      '@heniek/contracts':
+        specifier: workspace:*
+        version: link:../contracts
+    devDependencies:
+      tsx:
+        specifier: 'catalog:'
+        version: 4.23.1
+      vitest:
+        specifier: 'catalog:'
+        version: 4.1.10(@types/node@24.10.1)(vite@8.1.5(@types/node@24.10.1)(esbuild@0.28.1)(tsx@4.23.1)(yaml@2.9.0))
+
```

There are no `-` lines and no additions under `packages:` or `snapshots:`.

## D3 — the two digests disagree exactly where they should

Migration 3 adds `run_projection.workspace_id` via `ALTER TABLE … ADD COLUMN`. SQLite rewrites the
stored `CREATE TABLE` text by splicing the new column in ahead of the closing parenthesis, producing
text no hand-written inline `CREATE` would emit:

```
CREATE TABLE run_projection (
      run_id               TEXT    NOT NULL PRIMARY KEY,
      status               TEXT    NOT NULL,
      revision             INTEGER NOT NULL,
      last_event_sequence  INTEGER NOT NULL REFERENCES state_event(sequence),
      codebase_id          TEXT    NOT NULL,
      updated_at           TEXT    NOT NULL
    , workspace_id TEXT) STRICT
```

The independently hand-written witness in `test/fixtures/terminal-schema.sql` declares the same
logical schema with `workspace_id` as an ordinary inline column. The consequence is asserted in
three separate cases: the **structural** digest matches (PRAGMA introspection records what the
schema is, never how it got there), the **declared** digest does **not** (it hashes stored DDL
text), and the literal, un-normalised DDL differs. That asymmetry is the whole reason two digests
exist rather than one.

All four *migrated* lineages — fresh, upgraded, interrupted, and interrupted-then-rolled-forward —
agree on **both** digests at the terminal version.

## D8 / R-V9 — the upsert trap, in both directions

Measured against the real schema. Variant A carries the intended next revision in the `VALUES` row:

```
INSERT INTO run_projection (run_id, status, revision, last_event_sequence, codebase_id, updated_at)
  VALUES ('run-1', 'running', 2, ?, 'cb-1', ...)
  ON CONFLICT(run_id) DO UPDATE SET revision = excluded.revision, ...
```

It is **rejected**, with `errcode 1811` and the message `first projection revision must be 1`, even
though the conflict resolves to the UPDATE branch — SQLite evaluates `BEFORE INSERT` triggers before
conflict resolution, so the guard never sees the `DO UPDATE` clause. A package built on this idiom
cannot advance any projection past its first event, and reports an error pointing at the wrong
thing.

Variant B carries revision 1 in `VALUES` and computes the real next revision in the `DO UPDATE`
clause:

```
INSERT INTO run_projection (run_id, status, revision, last_event_sequence, codebase_id, updated_at)
  VALUES ('run-1', 'running', 1, ?, 'cb-1', ...)
  ON CONFLICT(run_id) DO UPDATE SET revision = run_projection.revision + 1, ...
```

It **succeeds**, `changes === 1`, and the row advances to revision 2. Both facts are pinned
together, because pinning only the first would leave "the upsert is banned" reading as a
schema-enforced property when it is really a rule about which SQL the command unit may emit.

## Crash matrix — what was actually killed

Three real child processes, each spawned under `--import tsx`, each announcing readiness on stdout
and then blocking on `Atomics.wait` until the parent sent `SIGKILL`. In every case the child exited
with `signal === "SIGKILL"` and `code === null`, and the database file was then reopened and
inspected.

| Kill point | Observed after reopening |
|---|---|
| Between the event insert and the projection write | **0** rows in `state_event` and **0** in `run_projection`; `integrity_check` → `ok`; `foreign_key_check` → empty |
| After `COMMIT` returned | **1** row in each; WAL recovered on reopen; `integrity_check` → `ok` |
| Inside migration 2's transaction | `user_version` = **1** (the last fully-applied version); `state_event` present, `run_projection` absent; re-running `runMigrations` reached the committed version-3 fingerprint |

All three left `state.sqlite` and any surviving sidecars at `0600`.

These results demonstrate that **this code never places a projection write outside the transaction
carrying its event**. They do not demonstrate that SQLite is atomic — that is SQLite's own claim,
relied upon here. Power loss, lying `fsync`, filesystem corruption, and concurrent writers from a
second process were **not** simulated and are out of scope.
