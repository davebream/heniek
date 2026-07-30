# ADR 0001: Initial implementation defaults

- Status: Accepted
- Date: 2026-07-30

## Context

Heniek needs an executable starting point without turning implementation choices
into irreversible product constraints.

## Decision

Use strict ESM TypeScript in a pnpm/Turborepo, targeting Node.js 24. Start with:

- TypeBox and Ajv for versioned JSON contracts;
- Node's built-in SQLite module for canonical state;
- Hono for authenticated loopback HTTP and SSE;
- React with Vite for the web dashboard;
- Ink for the operational TUI;
- Claudexor's versioned `/v2` control API as the first `ExecutionBackend`.

## Constraints

Windmill, Kombajn, and TAKT are development-time or factory concerns and are not
Heniek runtime dependencies. Claudexor internals may never be imported.

## Consequences

A spike may replace a default only through a superseding ADR with compatibility
tests. It cannot narrow v1 scope or remove an acceptance criterion from Product
Specification v0.2.
