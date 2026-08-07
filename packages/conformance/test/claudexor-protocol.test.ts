import { describe, expect, it } from "vitest";
import {
  assertPinnedEngine,
  EnginePinMismatchError,
  EXPECTED_ENGINE_SHA,
  EXPECTED_ENGINE_VERSION,
  EXPECTED_PROTOCOL_MAJOR,
  InvalidHandshakeResponseError,
  negotiateProtocol,
  ProtocolMajorMismatchError,
  protocolHeaders,
} from "../src/smoke/claudexor/protocol.js";

const validHandshake = {
  protocolMajor: EXPECTED_PROTOCOL_MAJOR,
  compatible: true,
  operationsPath: "/v2/operations",
  engine: { version: EXPECTED_ENGINE_VERSION, sha: EXPECTED_ENGINE_SHA, entry: "/somewhere/d.js" },
};

describe("negotiateProtocol", () => {
  it("accepts the pinned engine's handshake", () => {
    const negotiated = negotiateProtocol(validHandshake);
    expect(negotiated.major).toBe(EXPECTED_PROTOCOL_MAJOR);
    expect(negotiated.operationsPath).toBe("/v2/operations");
    expect(negotiated.engine).toEqual({
      version: EXPECTED_ENGINE_VERSION,
      sha: EXPECTED_ENGINE_SHA,
    });
  });

  // Regression (finding F1): the pinned engine serves `/v2` paths but requires
  // protocol major 3. A client that infers the major from the URL sends 2 and
  // is refused. The major must come from the handshake body only.
  it("rejects a handshake advertising major 2 even though the path prefix is /v2", () => {
    expect(() => negotiateProtocol({ ...validHandshake, protocolMajor: 2 })).toThrow(
      ProtocolMajorMismatchError,
    );
    try {
      negotiateProtocol({ ...validHandshake, protocolMajor: 2 });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("2");
      expect(message).toContain(String(EXPECTED_PROTOCOL_MAJOR));
    }
  });

  it("takes no path argument, so the major cannot be derived from a URL", () => {
    expect(negotiateProtocol.length).toBe(1);
  });

  it.each([
    ["a non-object", 42],
    ["null", null],
    ["an array", []],
    [
      "a missing protocolMajor",
      { operationsPath: "/v2/operations", engine: validHandshake.engine },
    ],
    ["a fractional protocolMajor", { ...validHandshake, protocolMajor: 3.5 }],
    ["a missing engine", { protocolMajor: 3, operationsPath: "/v2/operations" }],
    ["a missing engine.sha", { ...validHandshake, engine: { version: EXPECTED_ENGINE_VERSION } }],
  ])("rejects %s", (_label, input) => {
    expect(() => negotiateProtocol(input)).toThrow();
  });
});

describe("assertPinnedEngine", () => {
  it("accepts the pinned identity", () => {
    expect(() =>
      assertPinnedEngine({ version: EXPECTED_ENGINE_VERSION, sha: EXPECTED_ENGINE_SHA }),
    ).not.toThrow();
  });

  it("rejects a mismatched sha and names the expected pin", () => {
    const observed = { version: EXPECTED_ENGINE_VERSION, sha: "0".repeat(40) };
    expect(() => assertPinnedEngine(observed)).toThrow(EnginePinMismatchError);
    try {
      assertPinnedEngine(observed);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain(EXPECTED_ENGINE_SHA);
    }
  });

  it("rejects a mismatched version", () => {
    expect(() => assertPinnedEngine({ version: "3.1.1", sha: EXPECTED_ENGINE_SHA })).toThrow(
      EnginePinMismatchError,
    );
  });
});

describe("protocolHeaders", () => {
  it("carries the negotiated major as a string and a loopback origin", () => {
    const headers = protocolHeaders(EXPECTED_PROTOCOL_MAJOR);
    expect(headers["X-Claudexor-Protocol-Major"]).toBe(String(EXPECTED_PROTOCOL_MAJOR));
    expect(headers.Origin).toBe("http://127.0.0.1");
  });

  // The bearer token is the client's concern; keeping it out of this pure
  // module keeps the credential out of everything that imports it.
  it("never carries an Authorization header, in any case form", () => {
    const headers = protocolHeaders(EXPECTED_PROTOCOL_MAJOR);
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("authorization");
  });

  it.each([[Number.NaN], [2], [3.5]])("refuses to emit headers for major %s", (major) => {
    expect(() => protocolHeaders(major)).toThrow(ProtocolMajorMismatchError);
  });

  it("exports InvalidHandshakeResponseError for callers to discriminate", () => {
    expect(new InvalidHandshakeResponseError("engine").name).toBe("InvalidHandshakeResponseError");
  });
});
