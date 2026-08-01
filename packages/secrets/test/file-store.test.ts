import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileSecretStore } from "../src/file-store.js";
import { SensitiveValue } from "../src/sensitive-value.js";
import { InsecureSecretStoreError, SecretStoreEntryNameError } from "../src/store.js";

const isPosix = process.platform !== "win32";

let directories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "heniek-secrets-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories = [];
});

describe("createFileSecretStore", () => {
  it("round-trips a written value", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("github-token", SensitiveValue.from("raw-value"));
    const value = await store.read("github-token");
    expect(value?.expose()).toBe("raw-value");
  });

  it("returns undefined for a missing entry", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    expect(await store.read("missing")).toBeUndefined();
  });

  it("overwrites an existing entry on repeated writes", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("name", SensitiveValue.from("first"));
    await store.write("name", SensitiveValue.from("second"));
    const value = await store.read("name");
    expect(value?.expose()).toBe("second");
  });

  it("removes an existing entry and returns true, then false on repeat", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("name", SensitiveValue.from("value"));
    expect(await store.remove("name")).toBe(true);
    expect(await store.remove("name")).toBe(false);
    expect(await store.read("name")).toBeUndefined();
  });

  it("lists sorted entry names only, ignoring non-.entry files", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("zeta", SensitiveValue.from("z-value"));
    await store.write("alpha", SensitiveValue.from("a-value"));
    await writeFileStray(directory, "not-an-entry.txt", "stray");

    const names = await store.list();
    expect(names).toEqual(["alpha", "zeta"]);
  });

  it("creates entry files named <name>.entry", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("github-token", SensitiveValue.from("raw-value"));

    const files = await readdir(directory);
    expect(files).toContain("github-token.entry");
  });

  it("leaves no temporary file behind after a successful write", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("github-token", SensitiveValue.from("raw-value"));

    const files = await readdir(directory);
    const stray = files.filter((file) => file !== "github-token.entry");
    expect(stray).toEqual([]);
  });

  it("rejects an invalid entry name on write/read/remove", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await expect(store.write("..", SensitiveValue.from("value"))).rejects.toThrow(
      SecretStoreEntryNameError,
    );
    await expect(store.read("with space")).rejects.toThrow(SecretStoreEntryNameError);
    await expect(store.remove("a/b")).rejects.toThrow(SecretStoreEntryNameError);
  });

  it.runIf(isPosix)("creates the directory with mode 0700", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("name", SensitiveValue.from("value"));

    const stats = await stat(directory);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it.runIf(isPosix)("creates entry files with mode 0600", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("name", SensitiveValue.from("value"));

    const stats = await stat(join(directory, "name.entry"));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it.runIf(isPosix)("repairs a widened directory back to 0700", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await chmod(directory, 0o755);

    await store.write("name", SensitiveValue.from("value"));

    const stats = await stat(directory);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it.runIf(isPosix)("refuses to read an entry file that has been widened", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("name", SensitiveValue.from("value"));
    await chmod(join(directory, "name.entry"), 0o644);

    await expect(store.read("name")).rejects.toThrow(InsecureSecretStoreError);
  });

  it("materialises the directory recursively when it does not yet exist", async () => {
    const base = await makeTempDirectory();
    const directory = join(base, "nested", "secrets");
    const store = createFileSecretStore({ directory });

    await store.write("name", SensitiveValue.from("value"));
    const value = await store.read("name");
    expect(value?.expose()).toBe("value");
  });
});

async function writeFileStray(directory: string, name: string, contents: string): Promise<void> {
  await writeFile(join(directory, name), contents, "utf8");
}
