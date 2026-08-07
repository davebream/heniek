import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudexorRuntimeProbe } from "../src/index.js";

const roots: string[] = [];
const requiredOperations = [
  ["POST", "/v2/handshake"],
  ["GET", "/v2/operations"],
  ["POST", "/v2/harnesses/:id/auth-readiness"],
  ["POST", "/v2/threads"],
  ["GET", "/v2/threads/:id"],
  ["POST", "/v2/threads/:id/turns"],
  ["GET", "/v2/runs/:id"],
  ["POST", "/v2/runs/:id/interactions/:id/answer"],
  ["POST", "/v2/runs/:id/control"],
  ["GET", "/v2/runs/:id/produced"],
  ["GET", "/v2/runs/:id/produced/<path>"],
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function daemon(completeCatalogue: boolean, observationPath?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heniek-runtime-probe-test-"));
  roots.push(root);
  const entry = join(root, "daemon.cjs");
  const operations = completeCatalogue ? requiredOperations : requiredOperations.slice(0, -1);
  await writeFile(
    entry,
    `const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const tokenPath = path.join(process.env.HOME, ".claudexor/v3/daemon/token");
fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
fs.writeFileSync(tokenPath, "probe-token");
${
  observationPath === undefined
    ? ""
    : `fs.writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({
  exposed: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME", "AWS_SECRET_ACCESS_KEY"].filter((name) => Object.hasOwn(process.env, name)),
  home: process.env.HOME,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
}));`
}
const operations = ${JSON.stringify(operations.map(([method, path]) => ({ method, path })))};
http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/healthz") response.end(JSON.stringify({ status: "ready" }));
  else if (request.url === "/v2/handshake") response.end(JSON.stringify({ compatible: true, protocolMajor: 3, operationsPath: "/v2/operations", engine: { version: "3.1.2", sha: "${"b".repeat(40)}" } }));
  else if (request.url === "/v2/operations") response.end(JSON.stringify({ operations }));
  else { response.statusCode = 404; response.end("{}"); }
}).listen(Number(process.env.CLAUDEXOR_CONTROL_PORT), "127.0.0.1");
`,
    "utf8",
  );
  await chmod(entry, 0o700);
  return entry;
}

describe("live Claudexor runtime probe", () => {
  it("reads identity only after protocol and operation compatibility pass", async () => {
    const entry = await daemon(true);
    await expect(
      createClaudexorRuntimeProbe({ readyTimeoutMilliseconds: 5_000 }).inspect(entry),
    ).resolves.toEqual({ version: "3.1.2", buildSha: "b".repeat(40) });
  });

  it("rejects an incomplete operation catalogue", async () => {
    const entry = await daemon(false);
    await expect(
      createClaudexorRuntimeProbe({ readyTimeoutMilliseconds: 5_000 }).inspect(entry),
    ).rejects.toMatchObject({ code: "RUNTIME_INTEGRITY_FAILED" });
  });

  it("does not expose hostile ambient credentials or config homes to a candidate", async () => {
    const observationPath = join(
      await mkdtemp(join(tmpdir(), "heniek-runtime-probe-observation-")),
      "env.json",
    );
    roots.push(dirname(observationPath));
    const previous = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      CODEX_HOME: process.env.CODEX_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      HOME: process.env.HOME,
    };
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "hostile-api-key",
      CLAUDE_CODE_OAUTH_TOKEN: "hostile-oauth-token",
      CODEX_HOME: "/hostile/codex",
      XDG_CONFIG_HOME: "/hostile/xdg",
      AWS_SECRET_ACCESS_KEY: "hostile-secret",
      HOME: "/hostile/home",
    });
    try {
      await createClaudexorRuntimeProbe({ readyTimeoutMilliseconds: 5_000 }).inspect(
        await daemon(true, observationPath),
      );
      const observed = JSON.parse(await readFile(observationPath, "utf8")) as {
        exposed: string[];
        home: string;
        xdgConfigHome: string;
      };
      expect(observed.exposed).toEqual([]);
      expect(observed.home).not.toBe("/hostile/home");
      expect(observed.xdgConfigHome).not.toBe("/hostile/xdg");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
