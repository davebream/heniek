# Heniek agent instructions

Heniek is a local-first multi-engine Codebase and epic orchestrator.

## Product boundaries

- Preserve every v1 commitment and acceptance criterion in
  `docs/product/product-spec-v0.2.md`.
- Windmill, Kombajn, and TAKT are not runtime dependencies.
- Claudexor is replaceable and may be called only through its versioned `/v2`
  control API.
- Provider payloads and DTOs stay inside execution-backend adapters.
- Runtime state never belongs in a registered repository.

## Repository conventions

- Use strict ESM TypeScript and named exports.
- Keep deployable units in `apps/*` and focused libraries in `packages/*`.
- Use `workspace:*` for internal dependencies and `catalog:` for shared
  third-party dependencies.
- Treat checked-in generated schemas as public compatibility artifacts.
- Never add a license or publish a package without an explicit product decision.

## Validation

Run `pnpm check` before committing. A pull request may merge only when the
required `quality` check passes.
