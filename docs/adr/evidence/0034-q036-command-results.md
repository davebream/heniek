# Q036 command evidence

- Date: 2026-08-10
- Platform: macOS, Node.js 24.19.0, pnpm 11.21.0
- Branch: `issue-40`

## Focused verification

| Scope | Result |
|---|---|
| `@heniek/contracts` | 9 files passed; 129 tests passed |
| `@heniek/state` | 44 files passed; 1 skipped; 476 tests passed; 1 skipped |
| `@heniek/workspace` | 5 files passed; 39 tests passed |
| `@heniek/runner` | 7 files passed; 42 tests passed |
| `@heniek/conformance` | 25 files passed; 3 skipped; 382 tests passed; 6 skipped |

## Repository verification

`pnpm check` completed successfully. It ran formatting, backlog and generated-artifact checks,
conformance checks, TypeScript compilation, and the complete test suite.

```text
Test Files  189 passed | 3 skipped (192)
Tests       2309 passed | 9 skipped (2318)
Duration    21.47s
```

`git diff --check` also completed successfully. Compatibility coverage verifies that the four Q036
schemas are additive and every pre-Q036 generated schema retains its previous byte hash.
