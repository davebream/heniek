import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { SCHEMA_REGISTRY } from "../src/kernel/index.js";
// Importing the package barrel is the registration side effect: every
// `versioned()` call across every family runs on import, populating
// SCHEMA_REGISTRY before it's read below.
import "../src/index.js";

// ajv-formats' .d.ts declares only a default export (no named
// alternative), and under this repo's NodeNext + verbatimModuleSyntax
// config, any static `import ... from "ajv-formats"` — default or
// namespace — resolves to the raw module-namespace type instead of
// unwrapping the default (a real TS 7 / NodeNext interop gap for CJS
// packages with no "exports" map). `createRequire` sidesteps the broken
// static resolution and uses Node's own (correct) CJS interop at runtime;
// the type is recovered separately via a type-only `typeof import(...)` query.
const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedRoot = resolve(packageRoot, "generated");
const checkOnly = process.argv.includes("--check");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fileNameFor(schemaId: string, schemaVersion: number): string {
  const name = schemaId.replace(/^heniek:\/\/contract\//, "").replace(/\/v\d+$/, "");
  return `${name}.v${schemaVersion}.schema.json`;
}

const entries = [...SCHEMA_REGISTRY.entries()].sort(([a], [b]) => a.localeCompare(b));

if (entries.length === 0) {
  throw new Error("SCHEMA_REGISTRY is empty — no versioned() contracts were registered.");
}

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);

// Register the complete graph before compiling any one schema. Q019 is the
// first contract family to share a versioned child by `$ref`; compiling each
// root in isolation would reject a valid reference solely because its sibling
// had not been registered yet.
for (const [schemaId, schema] of entries) ajv.addSchema(schema, schemaId);

const outputs = new Map<string, string>();
const manifestEntries: {
  schemaId: string;
  schemaVersion: number;
  sha256: string;
  path: string;
}[] = [];

for (const [schemaId, schema] of entries) {
  // Fails loudly here — under the same strict/format config the test suite
  // and downstream consumers use — rather than letting a broken schema
  // reach `generated/` and fail only for the first consumer.
  if (ajv.getSchema(schemaId) === undefined) {
    throw new Error(`Registered contract did not compile: ${schemaId}`);
  }

  const record = schema as unknown as {
    properties?: { schemaVersion?: { const?: number } };
    anyOf?: readonly { properties?: { schemaVersion?: { const?: number } } }[];
  };
  const schemaVersion =
    record.properties?.schemaVersion?.const ?? record.anyOf?.[0]?.properties?.schemaVersion?.const;
  if (schemaVersion === undefined) {
    throw new Error(`Registered contract is missing a schemaVersion discriminator: ${schemaId}`);
  }
  const fileName = fileNameFor(schemaId, schemaVersion);
  const content = canonicalJson(schema);
  const path = resolve(generatedRoot, fileName);
  outputs.set(path, content);
  manifestEntries.push({
    schemaId,
    schemaVersion,
    sha256: sha256(content),
    path: `generated/${fileName}`,
  });
}

const manifest = {
  schemaVersion: "heniek.contracts-manifest.v1",
  schemas: manifestEntries,
};

outputs.set(resolve(generatedRoot, "manifest.json"), canonicalJson(manifest));

for (const [path, content] of outputs) {
  if (checkOnly) {
    const existing = await readFile(path, "utf8").catch(() => "");
    if (existing !== content) {
      throw new Error(`Generated contract artifact is stale: ${path}`);
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}
