import {
  CODEBASE_DETECT_V1_METHOD,
  createHmacSha256MacProvider,
  createMethodRegistry,
  dispatchFrame,
  type Frame,
  type MethodContext,
  mintConnectionAuthState,
} from "@heniek/daemon";
import {
  buildSignedRequest,
  CAPABILITY_CATALOGUE_SCHEMA_ID,
  CAPABILITY_CATALOGUE_SCHEMA_SHA256,
  CODEBASE_DETECTION_SCHEMA_ID,
  CODEBASE_DETECTION_SCHEMA_SHA256,
} from "@heniek/protocol";
import { describe, expect, it } from "vitest";

const credential = { keyId: "a".repeat(32), secret: new Uint8Array(32).fill(7) };

function request(raw: string): Frame {
  const value = JSON.parse(raw) as { id: number; method: string; params: unknown };
  return { kind: "request", id: value.id, method: value.method, params: value.params, raw };
}

function connection() {
  return mintConnectionAuthState({ bytes: (length) => new Uint8Array(length).fill(9) });
}

describe("Q009 negotiation and cancellation", () => {
  it("negotiates the authenticated engine catalogue method and schema", async () => {
    const auth = connection();
    const deps = {
      registry: createMethodRegistry([
        [
          "engine.catalogue.v1",
          () => ({ schemaVersion: 1, generatedAt: "2026-08-07T10:00:00.000Z", entries: [] }),
        ],
      ]),
      credential,
      macProvider: createHmacSha256MacProvider(),
      instanceId: "daemon-1",
      protocolVersion: 1,
      isDraining: () => false,
    };
    await dispatchFrame(deps, auth, request('{"jsonrpc":"2.0","id":1,"method":"daemon.hello"}'));
    const negotiation = buildSignedRequest(credential, auth.challenge, 2, "daemon.negotiate", 1, {
      schemaVersion: 1,
      transportVersions: [1],
      requiredMethods: [
        {
          name: "engine.catalogue",
          methodVersions: [1],
          resultSchemas: [
            {
              schemaId: CAPABILITY_CATALOGUE_SCHEMA_ID,
              sha256: CAPABILITY_CATALOGUE_SCHEMA_SHA256,
            },
          ],
        },
      ],
    });
    expect(JSON.parse(await dispatchFrame(deps, auth, request(negotiation))).result).toMatchObject({
      compatibility: "compatible",
      methods: [
        {
          name: "engine.catalogue",
          wireMethod: "engine.catalogue.v1",
          resultSchemaSha256: CAPABILITY_CATALOGUE_SCHEMA_SHA256,
        },
      ],
    });
  });

  it("negotiates and authenticates the versioned Codebase detection method", async () => {
    const auth = connection();
    const deps = {
      registry: createMethodRegistry([
        [CODEBASE_DETECT_V1_METHOD, () => ({ schemaVersion: 1, topologySha256: "a".repeat(64) })],
      ]),
      credential,
      macProvider: createHmacSha256MacProvider(),
      instanceId: "daemon-1",
      protocolVersion: 1,
      isDraining: () => false,
    };
    await dispatchFrame(deps, auth, request('{"jsonrpc":"2.0","id":1,"method":"daemon.hello"}'));
    const negotiation = buildSignedRequest(credential, auth.challenge, 2, "daemon.negotiate", 1, {
      schemaVersion: 1,
      transportVersions: [1],
      requiredMethods: [
        {
          name: "codebase.detect",
          methodVersions: [1],
          resultSchemas: [
            {
              schemaId: CODEBASE_DETECTION_SCHEMA_ID,
              sha256: CODEBASE_DETECTION_SCHEMA_SHA256,
            },
          ],
        },
      ],
    });
    expect(JSON.parse(await dispatchFrame(deps, auth, request(negotiation))).result).toMatchObject({
      compatibility: "compatible",
      methods: [
        {
          name: "codebase.detect",
          wireMethod: CODEBASE_DETECT_V1_METHOD,
          resultSchemaSha256: CODEBASE_DETECTION_SCHEMA_SHA256,
        },
      ],
    });
    const detect = buildSignedRequest(credential, auth.challenge, 3, CODEBASE_DETECT_V1_METHOD, 2, {
      schemaVersion: 1,
      roots: ["/repo"],
      sourceRepositoryPath: null,
    });
    expect(JSON.parse(await dispatchFrame(deps, auth, request(detect))).result).toMatchObject({
      topologySha256: "a".repeat(64),
    });
  });

  it("negotiates before a canonical status method", async () => {
    const auth = connection();
    const deps = {
      registry: createMethodRegistry([
        ["daemon.status.v1", () => ({ schemaVersion: 1, ok: true })],
      ]),
      credential,
      macProvider: createHmacSha256MacProvider(),
      instanceId: "daemon-1",
      protocolVersion: 1,
      isDraining: () => false,
    };
    await dispatchFrame(deps, auth, request('{"jsonrpc":"2.0","id":1,"method":"daemon.hello"}'));
    const challenge = auth.challenge;
    const negotiation = buildSignedRequest(credential, challenge, 2, "daemon.negotiate", 1, {
      schemaVersion: 1,
      transportVersions: [1],
      requiredMethods: [
        {
          name: "daemon.status",
          methodVersions: [1],
          resultSchemas: [
            {
              schemaId: "heniek://contract/DaemonStatus/v1",
              sha256: "a91375e3509ceb2663a96e656d18e32c722085a1cb574328159cee7ff4fef854",
            },
          ],
        },
      ],
    });
    expect(
      JSON.parse(await dispatchFrame(deps, auth, request(negotiation))).result.compatibility,
    ).toBe("compatible");
    const status = buildSignedRequest(credential, challenge, 3, "daemon.status.v1", 2);
    expect(JSON.parse(await dispatchFrame(deps, auth, request(status))).result.ok).toBe(true);
  });

  it("cancels an authenticated in-flight request exactly once", async () => {
    const auth = connection();
    const active = new Map<string, AbortController>();
    const key = (id: string | number) => `${typeof id}:${id}`;
    const deps = {
      registry: createMethodRegistry([
        [
          "slow",
          (_params: unknown, context: MethodContext) =>
            new Promise<void>(() => context.signal.addEventListener("abort", () => undefined)),
        ],
      ]),
      credential,
      macProvider: createHmacSha256MacProvider(),
      instanceId: "daemon-1",
      protocolVersion: 1,
      isDraining: () => false,
      createRequestContext: (id: string | number) => {
        const controller = new AbortController();
        active.set(key(id), controller);
        return { signal: controller.signal };
      },
      finishRequest: (id: string | number) => active.delete(key(id)),
      cancelRequest: (id: string | number) => {
        const controller = active.get(key(id));
        controller?.abort();
        return controller !== undefined;
      },
    };
    await dispatchFrame(deps, auth, request('{"jsonrpc":"2.0","id":1,"method":"daemon.hello"}'));
    const pending = dispatchFrame(
      deps,
      auth,
      request(buildSignedRequest(credential, auth.challenge, 2, "slow", 1)),
    );
    const cancelled = await dispatchFrame(
      deps,
      auth,
      request(
        buildSignedRequest(credential, auth.challenge, 3, "rpc.cancel", 2, {
          schemaVersion: 1,
          requestId: 2,
        }),
      ),
    );
    expect(JSON.parse(cancelled).result).toEqual({ schemaVersion: 1, accepted: true });
    expect(JSON.parse(await pending).error).toEqual({ code: -32002, message: "request cancelled" });
  });
});
