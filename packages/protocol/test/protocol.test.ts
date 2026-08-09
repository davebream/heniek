import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as protocol from "@heniek/protocol";
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

/**
 * Every `*_SCHEMA_SHA256` here is hand-copied from the generated contracts
 * manifest, and until Q023 nothing checked that the copy stayed true.
 *
 * A stale pin fails in a way no other gate sees. `daemon.negotiate` compares
 * the client's declared `{schemaId, sha256}` against the daemon's table and
 * answers `RESULT_SCHEMA_UNAVAILABLE` on a mismatch, so a digest that
 * drifted from the manifest makes a method that exists, is registered, and
 * works look permanently unavailable to every client — while `pnpm check`
 * stays green, because the contracts gate only compares the manifest against
 * itself.
 *
 * This walks the module's own exports rather than a hand-maintained list, so
 * a future pin added without a manifest entry is caught by the same test
 * that catches a drifted one.
 */
describe("schema pins match the generated contracts manifest", () => {
  const manifestPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../contracts/generated/manifest.json",
  );

  it("pins an existing schema id and its current sha256 for every pinned result", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      schemas: readonly { schemaId: string; sha256: string }[];
    };
    const digestById = new Map(manifest.schemas.map((entry) => [entry.schemaId, entry.sha256]));
    const exported = protocol as unknown as Record<string, unknown>;

    const pinned = Object.keys(exported).filter((name) => name.endsWith("_SCHEMA_ID"));
    expect(pinned.length).toBeGreaterThan(0);

    for (const idName of pinned) {
      const schemaId = exported[idName];
      const digestName = `${idName.slice(0, -"_SCHEMA_ID".length)}_SCHEMA_SHA256`;
      const pinnedDigest = exported[digestName];

      expect(typeof schemaId, `${idName} must be a string`).toBe("string");
      expect(pinnedDigest, `${idName} has no matching ${digestName}`).toBeTypeOf("string");
      expect(
        digestById.get(schemaId as string),
        `${idName} pins ${String(schemaId)}, which the manifest does not contain`,
      ).toBeTypeOf("string");
      expect(pinnedDigest, `${digestName} has drifted from the generated manifest`).toBe(
        digestById.get(schemaId as string),
      );
    }
  });
});
