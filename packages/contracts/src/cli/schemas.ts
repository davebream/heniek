import { Type } from "@sinclair/typebox";
import { versioned } from "../kernel/version.js";

const Compatibility = Type.Union([
  Type.Literal("exact"),
  Type.Literal("compatible"),
  Type.Literal("incompatible"),
]);

export const CliStatusResultV1 = versioned("CliStatusResult", 1, {
  health: Type.Literal("healthy"),
  daemon: Type.Object(
    {
      instanceId: Type.String({ minLength: 1 }),
      lifecycleState: Type.String({ minLength: 1 }),
      startedAt: Type.String({ format: "date-time" }),
      reconciliation: Type.Object(
        {
          probed: Type.Integer({ minimum: 0 }),
          resumable: Type.Integer({ minimum: 0 }),
          failed: Type.Integer({ minimum: 0 }),
          cancelled: Type.Integer({ minimum: 0 }),
          unknown: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
      artifactRecovery: Type.Object(
        {
          removedIncoming: Type.Integer({ minimum: 0 }),
          skippedIncoming: Type.Integer({ minimum: 0 }),
          unreferencedBlobs: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  protocol: Type.Object(
    {
      clientVersion: Type.Integer({ minimum: 1 }),
      daemonVersion: Type.Integer({ minimum: 1 }),
      negotiatedVersion: Type.Integer({ minimum: 1 }),
      compatibility: Type.Literal("compatible"),
    },
    { additionalProperties: false },
  ),
  schemas: Type.Object(
    {
      clientManifestVersion: Type.String({ minLength: 1 }),
      daemonManifestVersion: Type.String({ minLength: 1 }),
      compatibility: Compatibility,
    },
    { additionalProperties: false },
  ),
});

export const CliStatusSuccessV1 = versioned("CliStatusSuccess", 1, {
  ok: Type.Literal(true),
  command: Type.Literal("status"),
  result: Type.Object(
    {
      schemaVersion: Type.Literal(1),
      health: Type.Literal("healthy"),
      daemon: Type.Object({}, { additionalProperties: true }),
      protocol: Type.Object({}, { additionalProperties: true }),
      schemas: Type.Object({}, { additionalProperties: true }),
    },
    { additionalProperties: false },
  ),
});

export const CliStatusErrorV1 = versioned("CliStatusError", 1, {
  ok: Type.Literal(false),
  command: Type.Literal("status"),
  error: Type.Object(
    {
      code: Type.Union([
        Type.Literal("USAGE_ERROR"),
        Type.Literal("DAEMON_UNAVAILABLE"),
        Type.Literal("AUTHENTICATION_FAILED"),
        Type.Literal("INCOMPATIBLE_PROTOCOL"),
        Type.Literal("REQUEST_CANCELLED"),
        Type.Literal("RPC_FAILURE"),
      ]),
      message: Type.String({ minLength: 1 }),
      retryable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  observed: Type.Optional(
    Type.Object(
      {
        health: Type.Union([
          Type.Literal("unavailable"),
          Type.Literal("unauthorized"),
          Type.Literal("incompatible"),
          Type.Literal("failed"),
        ]),
        daemonVersion: Type.Optional(Type.Integer({ minimum: 1 })),
        schemaCompatibility: Type.Optional(Compatibility),
      },
      { additionalProperties: false },
    ),
  ),
});
