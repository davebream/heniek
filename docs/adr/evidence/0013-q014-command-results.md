# Q014 command results

- Date: 2026-08-07
- Platform: macOS arm64
- Node.js: `v24.19.0`
- pnpm: `11.13.0`
- Node.js runtime command: `npx --yes node@24`

The repository shell defaulted to unsupported Node.js 25. The commands below invoked pnpm through
the npm-distributed Node.js 24 binary, so pnpm and every child process used Node.js 24 without
changing repository configuration.

## Runtime verification

```sh
npx --yes node@24 --version
npx --yes node@24 /opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs --version
```

```text
v24.19.0
11.13.0
Exit code 0 for both commands.
```

## Focused profile and compatibility tests

```sh
npx --yes node@24 /opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs exec vitest run packages/config/test/profiles.test.ts packages/config/test/profile-evidence.test.ts packages/contracts/test/profiles.test.ts packages/conformance/test/contracts-compatibility.test.ts
```

```text
Test Files  4 passed (4)
Tests       29 passed (29)
Exit code   0
```

## Generated artifacts and whitespace

```sh
npx --yes node@24 /opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs generate:check
git diff --check
```

```text
Generated contract schemas matched checked-in artifacts.
git diff --check produced no output.
Exit code 0 for both commands.
```

## Full repository gate

```sh
npx --yes node@24 /opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs check
```

```text
format:check        passed (382 files; 1 pre-existing warning and 33 informational findings)
backlog:check       passed
generate:check      passed
conformance:check   passed
typecheck           passed
Test Files          109 passed | 3 skipped (112)
Tests               1681 passed | 9 skipped (1690)
Exit code            0
```
