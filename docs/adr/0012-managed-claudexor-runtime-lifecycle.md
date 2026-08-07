# ADR 0012 — Managed Claudexor runtime lifecycle

## Decision

Heniek manages Claudexor as a signed, replaceable runtime beneath the resolved
application home. Managed releases coexist by version. An install verifies the
strict upstream manifest, Heniek-pinned Ed25519 authority, repository-owned
archive URL, build SHA, and archive SHA-256 before extracting into an isolated
staging directory and atomically renaming it into place.

The bootstrap release is Claudexor `3.1.2` at build
`bb5efee24132aa3d65e417040df201e08da44c8c`. Its signed archive digest is
`28b54f20723b866eefdba1ebcbc4311da5c03f0828e72073947087ba092a6a4e`.
Changing the update authority requires a Heniek code change; an unknown key or
release location fails closed.

Runtime metadata stays outside SQLite and registered repositories. It consists
of immutable install records, full-suite compatibility attestations, immutable
activation records, and one atomically replaced active descriptor containing
the current and previous exact runtime identities. Each identity binds source
mode, canonical entry path, version, build SHA, binary SHA-256, and, for a
managed release, archive SHA-256.

`install` stages without activation. `activate`, `upgrade`, and `adopt` first
run a live `/v2` identity, protocol, and operation-catalog probe, then invoke a
local promotion runner in an isolated home. The runner must report every §23.5
check; missing, failed, or blocked checks prevent activation. Only bounded
check status and codes enter the immutable attestation. Credentials, provider
payloads, stderr, and transcripts are not stored.

External adoption resolves the supplied absolute entry to its canonical path,
hashes the binary, obtains version and build identity through the same live
probe, and uses the same promotion gate without copying or modifying the
external installation.

Rollback does not repeat the expensive full suite. It verifies that the prior
binary is unchanged, validates its exact successful attestation, reruns the
live `/v2` probe, writes the activation record, and atomically swaps current
and previous. Any failure before descriptor replacement leaves the active
runtime unchanged.

The Claudexor execution adapter no longer decides compatibility from its own
compile-time pin. Its expected version and build SHA are mandatory inputs
derived with the active runtime entry from the shared descriptor resolver, so
daemon execution and doctor diagnostics use one identity.

## Consequences

- Runtime mutation commands are daemon-independent and can bootstrap or
  rollback while the daemon is unavailable.
- Updates are always explicit; there is no background check or implicit
  promotion.
- A missing real-provider route or incomplete promotion runner is a typed,
  nonzero blocker and cannot change the active descriptor.
- Four additive provider-neutral V1 schemas describe identity, inventory,
  compatibility reports, and mutation results. Every pre-Q013 generated schema
  digest remains unchanged.
- Claudexor manifest and release DTOs remain private to the runtime adapter
  package rather than entering Heniek's public contracts.
