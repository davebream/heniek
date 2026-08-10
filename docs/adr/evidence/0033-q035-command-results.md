# Q035 local validation evidence

Validation ran on Node.js `v24.19.0` with pnpm `11.21.0`.

| Command | Result |
|---|---|
| `pnpm exec vitest run packages/workspace/test/composite.test.ts packages/codebase/test/configuration.test.ts packages/contracts/test/codebase-configuration.test.ts packages/conformance/test/contracts-compatibility.test.ts` | PASS — 4 files, 31 tests |
| `pnpm typecheck` | PASS |
| `pnpm generate:check` | PASS — contract and bundled pipeline artifacts current |
| Evidence validation through the shared Ajv conformance validator | PASS — composite manifest and effective instruction report valid |
| `pnpm check` | PASS — format, backlog, generation, conformance, typecheck, and tests |

The final `pnpm check` test phase completed with 182 files passed, 3 skipped; 2,274 tests passed,
9 skipped. An earlier run during machine-wide CPU saturation was discarded after unrelated suites
hit their five-second timeouts; the exact command was repeated after contention subsided and exited
zero with the results above.
