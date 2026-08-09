# Q026 — exact local check commands and results

Recorded on 2026-08-09 against Node.js `v24.19.0` / SQLite `3.53.4`.

```text
$ node -v
v24.19.0

$ pnpm --filter @heniek/contracts generate:check
✓

$ pnpm --filter @heniek/runner test
 Test Files  2 passed (2)
      Tests  13 passed (13)

$ pnpm check
 Test Files  150 passed | 3 skipped (153)
      Tests  2071 passed | 9 skipped (2080)
   Duration  13.37s
EXIT:0
```

Schema compatibility: `packages/contracts` manifest grew 118 → 125 by pure
addition of the seven `StageRunner*` contracts. Migration statement hash for
version 13 and terminal fingerprints are pinned under
`packages/state/test/fixtures/`.
