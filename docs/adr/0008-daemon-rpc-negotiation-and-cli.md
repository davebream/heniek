# ADR 0008 — Daemon RPC negotiation and minimal CLI

## Decision

The local daemon keeps Q008's `daemon.hello` as a frozen, unauthenticated
bootstrap. Clients authenticate once, call `daemon.negotiate`, then use
canonical versioned methods such as `daemon.status.v1`. Existing
`daemon.status` and `daemon.recovery` remain authenticated compatibility
aliases.

The protocol has three independent version axes:

- JSON-RPC remains `2.0`.
- Transport and method semantics use protocol/method version `1`.
- Domain DTOs retain their own versioned TypeBox identities and digests.

Negotiation returns an ordinary successful incompatible result when no common
transport, method, or result schema exists. This makes incompatibility
machine-readable without exposing an authentication or method-existence oracle.

`rpc.cancel` is an authenticated request, not a JSON-RPC notification. It is
limited to a request on the same socket connection, returns an idempotent
acceptance result, and aborts the target handler through `AbortSignal`. The
target receives `-32002 "request cancelled"`; it never cancels durable run
work.

The deployable CLI is deliberately limited to `heniek status [--json]`.
It resolves the application home, discovers the Unix socket, performs the
challenge-response handshake and negotiation, and renders a redacted health,
daemon, protocol, and schema-compatibility report.

## Consequences

- The server can evolve method semantics without changing domain DTO versions.
- All future local clients can reuse `@heniek/client`; none imports daemon
  runtime internals.
- JSON output is a versioned CLI envelope on stdout for both success and
  failure, with non-zero exit codes carrying the failure class.
- There is no TCP fallback, TUI, MCP facade, or domain-operation CLI in this
  increment.
