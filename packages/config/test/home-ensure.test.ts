import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
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
    const { home, directory } = await makeTempHome();

    const report = await ensureApplicationHomeDirectories(home);

    expect(report.directories.length).toBeGreaterThan(0);
    for (const entry of report.directories) {
      const stats = await stat(entry.path);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o700);
      expect(entry.mode).toBe(0o700);
      // The mkdtemp-created root (B1: now included in the ensure pass as
      // `home.roots.data`/`.state`) already existed before this call, at
      // mode 0700 (mkdtemp's own default) — every other entry is newly
      // created by this call.
      expect(entry.created).toBe(entry.path !== directory);
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

  // B1/C2: `makeTempHome` builds the home via a `HENIEK_HOME` override, so
  // the mkdtemp-created `directory` itself *is* the single-root home base —
  // i.e. `home.roots.data.path` and `home.roots.state.path` — not just one
  // of the layout's named entries. Before this fix, `ensureApplicationHomeDirectories`
  // never stat'ed or chmod'ed the root itself (only the layout's named
  // sub-entries), so a root pre-existing at a lax mode stayed lax while
  // `state.sqlite` and friends landed directly inside it.
  it.runIf(isPosix)(
    "repairs the home root itself when it pre-exists with lax permissions (B1/C2)",
    async () => {
      const { directory, home } = await makeTempHome();
      expect(home.roots.data.path).toBe(directory);
      expect(home.roots.state.path).toBe(directory);
      await chmod(directory, 0o755);

      const report = await ensureApplicationHomeDirectories(home);

      const rootReport = report.directories.find((entry) => entry.path === directory);
      expect(rootReport).toBeDefined();
      expect(rootReport?.created).toBe(false);
      expect(rootReport?.permissionsRepaired).toBe(true);
      expect(rootReport?.mode).toBe(0o700);

      const stats = await stat(directory);
      expect(stats.mode & 0o777).toBe(0o700);
    },
  );

  it("does not report a repair for a directory that is already private", async () => {
    const { home } = await makeTempHome();

    // The mkdtemp-created root (== home.roots.data/.state in this
    // single-root layout) already exists at 0700 before the first call, so
    // it alone is `created: false` on the first pass — every other entry
    // is freshly created.
    const first = await ensureApplicationHomeDirectories(home);
    expect(first.directories.filter((entry) => !entry.created)).toHaveLength(1);

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

  it.runIf(isPosix)(
    "refuses a symlinked entry with a diagnostic instead of following it (B1)",
    async () => {
      const { home, directory } = await makeTempHome();
      const target = join(directory, "symlink-target");
      await mkdir(target, { recursive: true });
      await symlink(target, home.paths.secretsDirectory);

      const report = await ensureApplicationHomeDirectories(home);

      expect(report.directories.some((entry) => entry.path === home.paths.secretsDirectory)).toBe(
        false,
      );
      expect(
        report.diagnostics.some((diagnostic) => diagnostic.code === "home.directory-is-symlink"),
      ).toBe(true);
    },
  );

  it.runIf(isPosix)(
    "emits a diagnostic instead of throwing when an entry path already exists as a plain file (B1)",
    async () => {
      const { home } = await makeTempHome();
      await writeFile(home.paths.configDirectory, "not a directory");

      const report = await ensureApplicationHomeDirectories(home);

      expect(report.directories.some((entry) => entry.path === home.paths.configDirectory)).toBe(
        false,
      );
      expect(
        report.diagnostics.some((diagnostic) => diagnostic.code === "home.directory-create-failed"),
      ).toBe(true);
    },
  );

  it("skips permission enforcement and omits mode when the injected platform is win32 (B1)", async () => {
    const { home } = await makeTempHome();

    const report = await ensureApplicationHomeDirectories(home, { platform: "win32" });

    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "home.directory-permissions-skipped", severity: "info" }),
      ]),
    );
    expect(report.directories.length).toBeGreaterThan(0);
    for (const entry of report.directories) {
      expect(entry.permissionsRepaired).toBe(false);
      expect(entry.mode).toBeUndefined();
    }
  });

  // H6: a home root sitting inside a git repository must be flagged with a
  // warning, never a rejection — directories are still created normally.
  it("H6: warns (does not reject) when a root sits inside a git repository", async () => {
    const { home, directory } = await makeTempHome();
    const gitMarker = join(directory, "..", ".git");
    await mkdir(gitMarker, { recursive: true });
    try {
      const report = await ensureApplicationHomeDirectories(home);

      const warning = report.diagnostics.find((d) => d.code === "home.root-inside-repository");
      expect(warning).toBeDefined();
      expect(warning?.severity).toBe("warning");
      expect(report.directories.length).toBeGreaterThan(0);
    } finally {
      // `gitMarker` lives one level *above* the mkdtemp-created `directory`
      // (i.e. in the shared OS tmpdir, the common parent of every other
      // test's mkdtemp directory in this file) — left behind, it would make
      // `findEnclosingGitRepository` find a `.git` for every sibling test
      // that runs afterwards, not just this one.
      await rm(gitMarker, { recursive: true, force: true });
    }
  });

  it("H6: no warning when no ancestor directory carries a .git entry", async () => {
    const { home } = await makeTempHome();

    const report = await ensureApplicationHomeDirectories(home);

    expect(report.diagnostics.some((d) => d.code === "home.root-inside-repository")).toBe(false);
  });
});
