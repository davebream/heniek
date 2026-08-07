import { createRequire } from "node:module";
import { CapabilityCatalogueEntryV1, type ProfileEngine } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { Ajv } from "ajv";
import type { StateDatabase } from "../database/open.js";
import { internalHandle } from "../database/open.js";
import { StateStoreError } from "../errors.js";

export type StoredCapabilityEntry = Static<typeof CapabilityCatalogueEntryV1>;
export type StoredCapabilityEngine = Static<typeof ProfileEngine>;

const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validateEntry = ajv.compile(CapabilityCatalogueEntryV1);

const accountKey = (accountId: string | null): string =>
  accountId === null ? "none:" : `account:${accountId}`;
const versionKey = (version: string | null): string =>
  version === null ? "none:" : `version:${version}`;

export function writeCapabilitySnapshot(
  database: StateDatabase,
  entry: StoredCapabilityEntry,
): void {
  if (!validateEntry(entry)) {
    throw new StateStoreError("writeCapabilitySnapshot: capability entry is invalid");
  }
  internalHandle(database)
    .prepare(
      `INSERT INTO capability_snapshot (
        engine, account_key, engine_version_key, claudexor_version,
        observed_at, expires_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(engine, account_key, engine_version_key, claudexor_version)
      DO UPDATE SET observed_at = excluded.observed_at,
                    expires_at = excluded.expires_at,
                    payload_json = excluded.payload_json`,
    )
    .run(
      entry.engine,
      accountKey(entry.accountId),
      versionKey(entry.engineVersion),
      entry.claudexorVersion,
      entry.observedAt,
      entry.expiresAt,
      JSON.stringify(entry),
    );
}

export function readLatestCapabilitySnapshot(
  database: StateDatabase,
  engine: StoredCapabilityEngine,
  accountId: string | null,
): StoredCapabilityEntry | undefined {
  const row = internalHandle(database)
    .prepare(
      `SELECT payload_json FROM capability_snapshot
       WHERE engine = ? AND account_key = ?
       ORDER BY observed_at DESC, engine_version_key DESC, claudexor_version DESC
       LIMIT 1`,
    )
    .get(engine, accountKey(accountId)) as { payload_json: string } | undefined;
  if (row === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    throw new StateStoreError("readLatestCapabilitySnapshot: stored JSON is malformed");
  }
  if (!validateEntry(parsed)) {
    throw new StateStoreError("readLatestCapabilitySnapshot: stored capability entry is invalid");
  }
  return parsed as StoredCapabilityEntry;
}
