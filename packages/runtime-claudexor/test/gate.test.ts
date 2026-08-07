import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommandCompatibilityGate,
  REQUIRED_PROMOTION_CHECKS,
  type RuntimeIdentity,
} from "../src/index.js";

const roots: string[] = [];
const identity: RuntimeIdentity = {
  schemaVersion: 1,
  engine: "claudexor",
  sourceMode: "managed",
  entryPath: "/opt/claudexor/claudexord.bundle.cjs",
  version: "3.1.2",
  buildSha: "b".repeat(40),
  binarySha256: "a".repeat(64),
  archiveSha256: "c".repeat(64),
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runner(output: unknown, exitCode = 0, observationPath?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heniek-promotion-runner-"));
  roots.push(root);
  const path = join(root, "runner.mjs");
  await writeFile(
    path,
    `#!/usr/bin/env node\n${
      observationPath === undefined
        ? ""
        : `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(observationPath)}, JSON.stringify({
  exposed: ["OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME", "AWS_SECRET_ACCESS_KEY"].filter((name) => Object.hasOwn(process.env, name)),
  explicit: process.env.PROMOTION_EXPLICIT_ROUTE,
  home: process.env.HOME,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
}));\n`
    }process.stdout.write(${JSON.stringify(JSON.stringify(output))});\nprocess.exit(${exitCode});\n`,
    "utf8",
  );
  await chmod(path, 0o700);
  return path;
}

describe("command compatibility gate", () => {
  it("accepts only a complete successful promotion report", async () => {
    const command = await runner({
      status: "pass",
      checks: REQUIRED_PROMOTION_CHECKS.map((name) => ({ name, status: "pass" })),
    });
    const gate = createCommandCompatibilityGate({
      command,
      nextId: () => "promotion-report",
      now: () => new Date("2026-08-07T10:00:00.000Z"),
    });
    const result = await gate.run(identity);
    expect(result).toMatchObject({
      reportId: "promotion-report",
      runtime: identity,
      status: "pass",
    });
    expect(result.checks).toHaveLength(REQUIRED_PROMOTION_CHECKS.length);
  });

  it("turns an omitted required check into a blocker", async () => {
    const command = await runner({ status: "pass", checks: [] });
    const result = await createCommandCompatibilityGate({ command }).run(identity);
    expect(result.status).toBe("blocked");
    expect(result.checks.every((check) => check.status === "blocked")).toBe(true);
  });

  it("surfaces a missing credential route as a typed blocker", async () => {
    const command = await runner({ status: "blocked", code: "CREDENTIAL_ROUTE_BLOCKED" }, 20);
    await expect(createCommandCompatibilityGate({ command }).run(identity)).rejects.toMatchObject({
      code: "CREDENTIAL_ROUTE_BLOCKED",
    });
  });

  it("passes only explicitly supplied promotion-route values to the runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-promotion-environment-"));
    roots.push(root);
    const observationPath = join(root, "env.json");
    const previous = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      CODEX_HOME: process.env.CODEX_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      HOME: process.env.HOME,
    };
    Object.assign(process.env, {
      OPENAI_API_KEY: "hostile-api-key",
      CLAUDE_CODE_OAUTH_TOKEN: "hostile-oauth-token",
      CODEX_HOME: "/hostile/codex",
      XDG_CONFIG_HOME: "/hostile/xdg",
      AWS_SECRET_ACCESS_KEY: "hostile-secret",
      HOME: "/hostile/home",
    });
    try {
      const command = await runner(
        {
          status: "pass",
          checks: REQUIRED_PROMOTION_CHECKS.map((name) => ({ name, status: "pass" })),
        },
        0,
        observationPath,
      );
      await createCommandCompatibilityGate({
        command,
        explicitEnvironment: {
          PROMOTION_EXPLICIT_ROUTE: "subscription-route",
          HOME: "/must-not-override-isolation",
          XDG_CONFIG_HOME: "/must-not-override-isolation",
        },
      }).run(identity);
      const observed = JSON.parse(await readFile(observationPath, "utf8")) as {
        exposed: string[];
        explicit: string;
        home: string;
        xdgConfigHome: string;
      };
      expect(observed.exposed).toEqual([]);
      expect(observed.explicit).toBe("subscription-route");
      expect(observed.home).not.toBe("/hostile/home");
      expect(observed.home).not.toBe("/must-not-override-isolation");
      expect(observed.xdgConfigHome).not.toBe("/hostile/xdg");
      expect(observed.xdgConfigHome).not.toBe("/must-not-override-isolation");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
