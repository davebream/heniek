import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const entrypoint = new URL("../src/bin.ts", import.meta.url).pathname;
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function run(argv: readonly string[], configHome?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", entrypoint, ...argv], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    env: configHome === undefined ? process.env : { ...process.env, XDG_CONFIG_HOME: configHome },
  });
}

describe("heniek CLI", () => {
  it("accepts only the documented help invocation", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "Usage: heniek status [--json]\n       heniek --help\n       heniek --version\n",
    );
    expect(result.stderr).toBe("");
  });

  it("uses JSON stdout and exit 3 when no daemon is reachable without creating its home", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "heniek-cli-test-"));
    homes.push(configHome);
    const result = run(["status", "--json"], configHome);
    expect(result.status).toBe(3);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: false,
      command: "status",
      error: {
        code: "DAEMON_UNAVAILABLE",
        message: "Heniek daemon is not reachable.",
        retryable: true,
      },
    });
    expect(existsSync(join(configHome, "heniek"))).toBe(false);
  });

  it("rejects duplicate flags as usage errors", () => {
    const result = run(["status", "--json", "--json"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "status",
      error: { code: "USAGE_ERROR", retryable: false },
    });
    expect(result.stderr).toBe("");
  });
});
