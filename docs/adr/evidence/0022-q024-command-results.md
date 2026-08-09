# Q024 — local command results

Run from a clean checkout of the Q024 branch, on the predecessor commit
`e09a202` (Q023, confirmed merged on remote `main`).

## Environment

```console
$ node --version
v24.19.0

$ pnpm --version
11.13.0
```

## Install

```console
$ corepack enable
$ pnpm install
Done in 5.2s using pnpm v11.13.0
```

`pnpm-lock.yaml` changes because `packages/pipeline` is a new workspace
package; no third-party dependency was added to the catalog. `@heniek/pipeline`
depends on `@heniek/config`, `@heniek/contracts`, and `@heniek/secrets`, all
already in the tree.

## Generated contracts

```console
$ pnpm --filter @heniek/contracts generate
$ git diff --numstat packages/contracts/generated/
18      0       packages/contracts/generated/manifest.json
```

Insertions only. Details in
[`0022-q024-pipeline-schema.md`](0022-q024-pipeline-schema.md).

## Package suite

```console
$ node node_modules/vitest/vitest.mjs run --dir packages/pipeline
 ✓ packages/pipeline/test/purity.test.ts (2 tests) 8ms
 ✓ packages/pipeline/test/expression.test.ts (41 tests) 6ms
 ✓ packages/pipeline/test/regressions.test.ts (7 tests) 36ms
 ✓ packages/pipeline/test/parse.test.ts (16 tests) 51ms
 ✓ packages/pipeline/test/corpus.test.ts (75 tests) 31ms
 ✓ packages/pipeline/test/properties.test.ts (8 tests) 542ms

 Test Files  6 passed (6)
      Tests  149 passed (149)
   Duration  1.14s
```

What the six files cover:

| File | Covers |
|---|---|
| `corpus.test.ts` | 4 accepted documents against recorded bytes, 14 rejected documents against recorded diagnostics, 2 equivalence groups, contract validation of every result |
| `expression.test.ts` | the §14.4 grammar: what it compiles, what it refuses, and its four bounds |
| `properties.test.ts` | seeded canonicalization, totality over random bytes and mutated corpus files, expression fuzzing |
| `parse.test.ts` | the optional profile check, the layering, the three renderers, redaction |
| `regressions.test.ts` | one case per defect found while implementing (see the ADR) |
| `purity.test.ts` | no clock, entropy, socket, filesystem, or environment anywhere in `src/` |

## Full repository check

```console
$ pnpm check

 Test Files  140 passed | 3 skipped (143)
      Tests  2025 passed | 9 skipped (2034)
   Duration  13.24s
```

`pnpm check` runs `format:check`, `backlog:check`, `generate:check`,
`conformance:check`, `typecheck`, and `test`. The 3 skipped files and 9 skipped
tests are the pre-existing Claudexor and subscription smoke suites, which are
gated on an external runtime and skip identically on `main`.

## Repository configuration changed

Two entries were added so the checked-in expected files are treated the way
every other generated artifact in this repository already is:

- `biome.json` — `!packages/pipeline/test/expected`, alongside the existing
  exclusions for `packages/contracts/generated` and
  `packages/conformance/generated`. The formatter would otherwise rewrite the
  bytes the corpus test compares against.
- `.gitattributes` (root and `packages/pipeline/`) — `linguist-generated=true`
  and `text eol=lf`, matching `packages/conformance/.gitattributes`, so a
  checkout with `core.autocrlf=true` cannot change the bytes either.
