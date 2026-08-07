# Evidence — ADR 0008: daemon RPC negotiation and minimal CLI

## Compatibility fixture

`packages/protocol/fixtures/json-rpc-v1.json` pins the v1 transport, method
bindings, result-schema digests, and implementation-defined error codes.

## Redacted handshake transcript

```text
$ heniek status --json
{"schemaVersion":1,"ok":true,"command":"status","result":{"health":"healthy",...}}
```

The real credential, key ID, challenge, MAC, socket path, and secret-store
path are intentionally omitted from this evidence.

## Local checks

Validated on 2026-08-06 with Node.js 24.19.0:

```text
pnpm dlx node@24 /opt/homebrew/bin/pnpm check

96 test files passed; 1,559 tests passed; 8 tests skipped.
```

The host default is Node.js 25, which is outside the repository's declared
Node.js 24 acceptance environment. This result uses Node.js 24 directly.
