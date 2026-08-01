import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureApplicationHomeDirectories } from "../src/home/ensure.js";
import { resolveApplicationHome } from "../src/home/resolve.js";

const isPosix = process.platform !== "win32";

let directories: string[] = [];

async function makeTempHome() {
  const directory = await mkdtemp(join(tmpdir(), "heniek-config-home-"));
  directories.push(directory);
  const home = resolveApplicationHome({
    platform: "linux",
    env: { HENIEK_HOME: directory },
    homeDirectory: directory,
  });
  return { directory, home };
}

afterEach(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories = [];
});

describe("ensureApplicationHomeDirectories", () => {
  it.runIf(isPosix)("creates every directory entry with mode 0700", async () => {
    const { home } = await makeTempHome();

    const report = await ensureApplicationHomeDirectories(home);

    expect(report.directories.length).toBeGreaterThan(0);
    for (const entry of report.directories) {
      const stats = await stat(entry.path);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o700);
      expect(entry.mode).toBe(0o700);
      expect(entry.created).toBe(true);
      expect(entry.permissionsRepaired).toBe(false);
    }
  });

  it.runIf(isPosix)("repairs a pre-existing directory that is group/other readable", async () => {
    const { home } = await makeTempHome();
    await mkdir(home.paths.secretsDirectory, { recursive: true });
    await chmod(home.paths.secretsDirectory, 0o755);

    const report = await ensureApplicationHomeDirectories(home);

    const secretsReport = report.directories.find(
      (entry) => entry.path === home.paths.secretsDirectory,
    );
    expect(secretsReport).toBeDefined();
    expect(secretsReport?.created).toBe(false);
    expect(secretsReport?.permissionsRepaired).toBe(true);
    expect(secretsReport?.mode).toBe(0o700);

    const stats = await stat(home.paths.secretsDirectory);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it("does not report a repair for a directory that is already private", async () => {
    const { home } = await makeTempHome();

    const first = await ensureApplicationHomeDirectories(home);
    expect(first.directories.every((entry) => entry.created)).toBe(true);

    const second = await ensureApplicationHomeDirectories(home);
    expect(second.directories.every((entry) => entry.created === false)).toBe(true);
    if (isPosix) {
      expect(second.directories.every((entry) => entry.permissionsRepaired === false)).toBe(true);
    }
  });

  it("covers every directory-shaped entry in the canonical layout", async () => {
    const { home } = await makeTempHome();

    const report = await ensureApplicationHomeDirectories(home);
    const reportedPaths = new Set(report.directories.map((entry) => entry.path));

    expect(reportedPaths.has(home.paths.configDirectory)).toBe(true);
    expect(reportedPaths.has(home.paths.secretsDirectory)).toBe(true);
    expect(reportedPaths.has(home.paths.logsDirectory)).toBe(true);
    expect(reportedPaths.has(home.paths.runtimeDirectory)).toBe(true);
    // File entries are not directories and must not appear in the report.
    expect(reportedPaths.has(home.paths.defaultsFile)).toBe(false);
    expect(reportedPaths.has(home.paths.stateDatabaseFile)).toBe(false);
  });
});
