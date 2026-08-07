import { createHash, createPublicKey, verify } from "node:crypto";
import { ClaudexorRuntimeError } from "./errors.js";

export const DEFAULT_CLAUDEXOR_VERSION = "3.1.2";
export const DEFAULT_CLAUDEXOR_BUILD_SHA = "bb5efee24132aa3d65e417040df201e08da44c8c";
export const DEFAULT_CLAUDEXOR_ARCHIVE_SHA256 =
  "28b54f20723b866eefdba1ebcbc4311da5c03f0828e72073947087ba092a6a4e";

export const CLAUDEXOR_RELEASE_REPOSITORY = "razzant/claudexor";
export const CLAUDEXOR_RUNTIME_AUTHORITY = {
  schemaVersion: 1,
  keyId: "claudexor-runtime-update-v3.1.0-ed25519-ce7f15e6187e137d",
  algorithm: "Ed25519",
  publicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA0AKwkzFo7g4oHTXn2hCyhNIWNV8wBqK4aGX8+Y6mfN0=\n-----END PUBLIC KEY-----\n",
} as const;

export interface ClaudexorRuntimeManifest {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly sha256: string;
  readonly minAppVersion: string;
  readonly archiveName: string;
  readonly archiveUrl: string;
  readonly buildSha: string;
  readonly notes: string;
  readonly keyId: string;
  readonly algorithm: "Ed25519";
  readonly signature: string;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MANIFEST_KEYS = [
  "algorithm",
  "archiveName",
  "archiveUrl",
  "buildSha",
  "keyId",
  "minAppVersion",
  "notes",
  "schemaVersion",
  "sha256",
  "signature",
  "version",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function runtimeArchiveName(version: string): string {
  return `claudexor-runtime-${version}.tar.gz`;
}

export function runtimeArchiveUrl(version: string): string {
  return `https://github.com/${CLAUDEXOR_RELEASE_REPOSITORY}/releases/download/v${version}/${runtimeArchiveName(version)}`;
}

export function runtimeManifestUrl(version: string): string {
  return `https://github.com/${CLAUDEXOR_RELEASE_REPOSITORY}/releases/download/v${version}/runtime-manifest.json`;
}

function signingBytes(manifest: ClaudexorRuntimeManifest): Buffer {
  const signed = {
    schemaVersion: manifest.schemaVersion,
    version: manifest.version,
    sha256: manifest.sha256,
    minAppVersion: manifest.minAppVersion,
    archiveName: manifest.archiveName,
    archiveUrl: manifest.archiveUrl,
    buildSha: manifest.buildSha,
    notes: manifest.notes,
    keyId: manifest.keyId,
    algorithm: manifest.algorithm,
  };
  return Buffer.from(canonicalJson(signed), "utf8");
}

export function parseAndVerifyRuntimeManifest(
  value: unknown,
  expectedVersion: string,
): ClaudexorRuntimeManifest {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== [...MANIFEST_KEYS].sort().join("\0")
  ) {
    throw new ClaudexorRuntimeError(
      "RELEASE_MANIFEST_INVALID",
      "The Claudexor runtime manifest has an unexpected shape.",
    );
  }
  const manifest = value as unknown as ClaudexorRuntimeManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.version !== expectedVersion ||
    !SEMVER.test(manifest.version) ||
    !SEMVER.test(manifest.minAppVersion) ||
    !SHA256.test(manifest.sha256) ||
    !GIT_SHA.test(manifest.buildSha) ||
    manifest.archiveName !== runtimeArchiveName(manifest.version) ||
    manifest.archiveUrl !== runtimeArchiveUrl(manifest.version) ||
    typeof manifest.notes !== "string" ||
    manifest.keyId !== CLAUDEXOR_RUNTIME_AUTHORITY.keyId ||
    manifest.algorithm !== CLAUDEXOR_RUNTIME_AUTHORITY.algorithm ||
    typeof manifest.signature !== "string" ||
    !BASE64.test(manifest.signature)
  ) {
    throw new ClaudexorRuntimeError(
      "RELEASE_MANIFEST_INVALID",
      "The Claudexor runtime manifest does not match the requested pinned release.",
    );
  }
  try {
    const signature = Buffer.from(manifest.signature, "base64");
    const key = createPublicKey(CLAUDEXOR_RUNTIME_AUTHORITY.publicKeyPem);
    if (
      signature.length !== 64 ||
      key.asymmetricKeyType !== "ed25519" ||
      !verify(null, signingBytes(manifest), key, signature)
    ) {
      throw new Error("invalid signature");
    }
  } catch (error) {
    throw new ClaudexorRuntimeError(
      "RELEASE_SIGNATURE_INVALID",
      "The Claudexor runtime manifest signature is invalid.",
      { cause: error },
    );
  }
  return manifest;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
