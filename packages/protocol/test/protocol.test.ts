import { createHmac } from "node:crypto";
import {
  buildSignedRequest,
  DAEMON_STATUS_METHOD,
  DAEMON_STATUS_V1_METHOD,
  ERROR_CODES,
  JSON_RPC_VERSION,
} from "@heniek/protocol";
import { describe, expect, it } from "vitest";

describe("Q009 protocol v1", () => {
  it("pins the canonical status method and cancellation error code", () => {
    expect(DAEMON_STATUS_METHOD).toBe("daemon.status");
    expect(DAEMON_STATUS_V1_METHOD).toBe("daemon.status.v1");
    expect(ERROR_CODES.requestCancelled).toBe(-32002);
  });

  it("signs the exact auth-excised request spelling emitted by the client", () => {
    const credential = { keyId: "a".repeat(32), secret: new Uint8Array(32).fill(7) };
    const challenge = new Uint8Array(32).fill(9);
    const line = buildSignedRequest(credential, challenge, 2, "daemon.status.v1", 1);
    const parsed = JSON.parse(line) as { params: { auth: { mac: string } } };
    const canonical = JSON.stringify({
      jsonrpc: JSON_RPC_VERSION,
      id: 2,
      method: "daemon.status.v1",
      params: {},
    });
    const preimage = Buffer.concat([challenge, Buffer.from(`\n1\n${canonical}`)]);
    const expected = createHmac("sha256", credential.secret).update(preimage).digest("hex");
    expect(parsed.params.auth.mac).toBe(expected);
  });
});
