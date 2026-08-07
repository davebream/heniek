/**
 * Control-protocol negotiation for the pinned Claudexor `/v2` control API.
 *
 * The path prefix and the protocol major are **decoupled** on the pinned
 * revision: routes live under `/v2`, but the engine requires protocol major
 * `3` and refuses a handshake that advertises `2`. Deriving the major from the
 * URL — which the phrase "versioned `/v2` control API" invites — is therefore
 * wrong. `negotiateProtocol` deliberately accepts no path argument at all, so
 * that mistake is not expressible through this module.
 *
 * Pure: no network, filesystem, process, or clock access.
 */

/** Path prefix every product route is served under on the pinned revision. */
export const CLAUDEXOR_PATH_PREFIX = "/v2";

/** Protocol major the pinned engine requires, despite the `/v2` path prefix. */
export const EXPECTED_PROTOCOL_MAJOR = 3;

/** Pinned engine version — `docs/reference/development-references.md`. */
export const EXPECTED_ENGINE_VERSION = "3.1.2";

/** Pinned engine commit — `docs/reference/development-references.md`. */
export const EXPECTED_ENGINE_SHA = "bb5efee24132aa3d65e417040df201e08da44c8c";

/** Build identity the engine self-reports at handshake. */
export interface EngineIdentity {
  readonly version: string;
  readonly sha: string;
}

/** Result of a successful protocol negotiation. */
export interface NegotiatedProtocol {
  readonly major: number;
  readonly operationsPath: string;
  readonly engine: EngineIdentity;
}

/** The handshake response was not shaped like a control handshake at all. */
export class InvalidHandshakeResponseError extends Error {
  constructor(readonly field: string) {
    super(`handshake response is missing or malformed at field "${field}"`);
    this.name = "InvalidHandshakeResponseError";
  }
}

/** The engine speaks a protocol major this client was not built against. */
export class ProtocolMajorMismatchError extends Error {
  constructor(
    readonly observed: number,
    readonly expected: number,
  ) {
    super(
      `control protocol major ${observed} is incompatible; this client requires ${expected}. ` +
        "The major comes from the handshake response, never from the request path.",
    );
    this.name = "ProtocolMajorMismatchError";
  }
}

/** The engine answering is not the pinned revision under test. */
export class EnginePinMismatchError extends Error {
  constructor(
    readonly observed: EngineIdentity,
    readonly expected: EngineIdentity,
  ) {
    // The observed halves are engine-controlled and end up in CI logs, so they
    // are bounded and stripped before interpolation. The expected halves are
    // compile-time constants and are safe verbatim.
    super(
      `engine is not the pinned revision: observed ${bounded(observed.version)}/${bounded(observed.sha)}, ` +
        `expected ${expected.version}/${expected.sha}`,
    );
    this.name = "EnginePinMismatchError";
  }
}

/** Render an engine-controlled value for an error message, bounded and safe. */
function bounded(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, "");
  return cleaned.length === 0 ? "<unprintable>" : cleaned.slice(0, 64);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidHandshakeResponseError(field);
  }
  return value as Record<string, unknown>;
}

function asString(record: Record<string, unknown>, field: string, path: string): string {
  const value = Object.hasOwn(record, field) ? record[field] : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidHandshakeResponseError(path);
  }
  return value;
}

/**
 * Validate a `POST /v2/handshake` response and return the negotiated protocol.
 *
 * Takes no path argument by construction: the major is readable only from the
 * response body.
 */
export function negotiateProtocol(response: unknown): NegotiatedProtocol {
  const record = asRecord(response, "<root>");

  const major = Object.hasOwn(record, "protocolMajor") ? record["protocolMajor"] : undefined;
  if (typeof major !== "number" || !Number.isInteger(major)) {
    throw new InvalidHandshakeResponseError("protocolMajor");
  }
  if (major !== EXPECTED_PROTOCOL_MAJOR) {
    throw new ProtocolMajorMismatchError(major, EXPECTED_PROTOCOL_MAJOR);
  }

  // `operationsPath` is engine-controlled and the client joins it to the base
  // URL while attaching `Authorization: Bearer <daemon token>`. An absolute
  // URL ("http://elsewhere/x") or a scheme-relative one ("//elsewhere/x")
  // would resolve to a foreign origin and walk the daemon token out with the
  // request, so it must be a same-origin path under the known prefix.
  const operationsPath = asString(record, "operationsPath", "operationsPath");
  if (
    !operationsPath.startsWith(`${CLAUDEXOR_PATH_PREFIX}/`) ||
    operationsPath.startsWith("//") ||
    operationsPath.includes(":")
  ) {
    throw new InvalidHandshakeResponseError("operationsPath");
  }
  const engineRecord = asRecord(
    Object.hasOwn(record, "engine") ? record["engine"] : undefined,
    "engine",
  );

  return {
    major,
    operationsPath,
    engine: {
      version: asString(engineRecord, "version", "engine.version"),
      sha: asString(engineRecord, "sha", "engine.sha"),
    },
  };
}

/**
 * Assert the engine that answered is the pinned revision.
 *
 * Without this, a canary proves only that *some* daemon was exercised — the
 * issue requires the *exact* pin to be the thing under test.
 */
export function assertPinnedEngine(engine: EngineIdentity): void {
  if (engine.version !== EXPECTED_ENGINE_VERSION || engine.sha !== EXPECTED_ENGINE_SHA) {
    throw new EnginePinMismatchError(engine, {
      version: EXPECTED_ENGINE_VERSION,
      sha: EXPECTED_ENGINE_SHA,
    });
  }
}

/**
 * Headers every product call must carry, minus authentication.
 *
 * `Authorization` is deliberately absent: the bearer token is the client's
 * concern, and keeping it out of this pure module keeps the credential out of
 * everything that imports it.
 */
export function protocolHeaders(major: number): Record<string, string> {
  if (!Number.isInteger(major) || major !== EXPECTED_PROTOCOL_MAJOR) {
    throw new ProtocolMajorMismatchError(major, EXPECTED_PROTOCOL_MAJOR);
  }
  return {
    "X-Claudexor-Protocol-Major": String(major),
    Origin: "http://127.0.0.1",
    "Content-Type": "application/json",
  };
}
