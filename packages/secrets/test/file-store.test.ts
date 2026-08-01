import { mkdtempSync } from "node:fs";
import {
  chmod,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileSecretStore } from "../src/file-store.js";
import { SensitiveValue } from "../src/sensitive-value.js";
import {
  CorruptSecretStoreEntryError,
  InsecureSecretStoreError,
  SECRET_ENTRY_NAME_PATTERN,
  SecretStoreConfigurationError,
} from "../src/store.js";
import { describeSecretStoreContract } from "./contract.js";

// `rename` and `unlink` are wrapped in `vi.fn(actual.fn)` — a mock whose
// *default* behaviour is the real implementation — so every other test in
// this file is unaffected, and only the two tests below that explicitly
// call `.mockRejectedValueOnce`/`.mockImplementationOnce` on them observe a
// forced failure, exactly once, before falling back to the real behaviour.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});

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
  vi.restoreAllMocks();
});

// The generic port contract (name validation, read/remove/list/overwrite
// semantics, the SensitiveValue round-trip) is asserted once, shared with
// the in-memory double — see test/contract.ts. Everything below is specific
// to this adapter: filesystem permissions, atomic-write cleanup,
// symlink/ownership rejection, and directory materialisation.
//
// `describeSecretStoreContract`'s `factory` is synchronous (the in-memory
// double needs no I/O to construct), so a fresh temp directory is created
// with the synchronous `mkdtempSync` rather than the promise-based
// `mkdtemp` used everywhere else in this file. Each directory is tracked in
// the same `directories` array so the shared `afterEach` cleans it up.
describeSecretStoreContract("createFileSecretStore", () => {
  const directory = mkdtempSync(join(tmpdir(), "heniek-secrets-contract-"));
  directories.push(directory);
  return createFileSecretStore({ directory });
});

describe("createFileSecretStore", () => {
  it("round-trips a written value", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("github-token", SensitiveValue.from("raw-value"));
    const value = await store.read("github-token");
    expect(value?.expose()).toBe("raw-value");
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

  it("rejects a relative directory rather than silently resolving it against process.cwd()", () => {
    expect(() => createFileSecretStore({ directory: "relative/secrets" })).toThrow(
      SecretStoreConfigurationError,
    );
    // The path is echoed in the message — it's a path, not a credential.
    expect(() => createFileSecretStore({ directory: "relative/secrets" })).toThrow(
      /relative\/secrets/,
    );
  });

  it("throws a store-level CorruptSecretStoreEntryError for a 0-byte entry file (C1)", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("name", SensitiveValue.from("value"));
    // Truncate the entry file out-of-band to simulate corruption — the
    // atomic write path in `writeEntry` never itself produces an empty
    // `.entry` file.
    await writeFile(join(directory, "name.entry"), "", "utf8");

    await expect(store.read("name")).rejects.toThrow(CorruptSecretStoreEntryError);
  });

  it("filters a hand-placed entry whose stripped name is invalid out of list() (C5)", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("name", SensitiveValue.from("value"));
    // Stripping the `.entry` suffix from `.hidden.entry` yields `.hidden`,
    // which `SECRET_ENTRY_NAME_PATTERN` rejects (must start with an
    // alphanumeric) — `list()` must not hand back a name that `read()`
    // would then reject with `SecretStoreEntryNameError`.
    await writeFileStray(directory, ".hidden.entry", "stray");

    const names = await store.list();
    expect(names).toEqual(["name"]);
    for (const name of names) {
      expect(SECRET_ENTRY_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  it.runIf(isPosix)("does not cache a rejected prepareDirectory promise forever (C2)", async () => {
    const base = await makeTempDirectory();
    const parent = join(base, "locked");
    await mkdir(parent, { recursive: true });
    await chmod(parent, 0o500); // no write bit: mkdir of the child directory fails
    const directory = join(parent, "secrets");
    const store = createFileSecretStore({ directory });

    await expect(store.write("name", SensitiveValue.from("value"))).rejects.toThrow();

    // A transient condition (here: the permission fix below) must not
    // stay poisoned by a permanently cached rejected promise.
    await chmod(parent, 0o700);
    await store.write("name", SensitiveValue.from("value"));
    const value = await store.read("name");
    expect(value?.expose()).toBe("value");
  });

  it.runIf(isPosix)(
    "refuses to use a directory path that is a symlink to another directory",
    async () => {
      const base = await makeTempDirectory();
      const realDirectory = join(base, "real");
      const linkDirectory = join(base, "link");
      await mkdir(realDirectory, { recursive: true, mode: 0o700 });
      await symlink(realDirectory, linkDirectory);

      const store = createFileSecretStore({ directory: linkDirectory });
      await expect(store.write("name", SensitiveValue.from("value"))).rejects.toThrow(
        InsecureSecretStoreError,
      );
    },
  );

  it("refuses to use a directory path that already exists as a plain file", async () => {
    const base = await makeTempDirectory();
    const notADirectory = join(base, "not-a-directory");
    await writeFile(notADirectory, "not a directory", "utf8");

    // `mkdir({ recursive: true })` itself already throws `EEXIST` for this
    // exact case, before `prepareDirectory`'s own `!stats.isDirectory()`
    // check is ever reached — that check exists as defence in depth for
    // non-directory filesystem entries `mkdir` does not itself reject (a
    // device file, FIFO, or socket at the target path). Either way, the
    // store must never silently proceed.
    const store = createFileSecretStore({ directory: notADirectory });
    await expect(store.write("name", SensitiveValue.from("value"))).rejects.toThrow();
  });

  // H2 regression (write failure): a failure anywhere between opening the
  // temp file and renaming it over the target must not leave partial
  // credential bytes on disk. `writeFile` is spied on the shared FileHandle
  // prototype so the failure happens *after* the temp file already exists —
  // exactly the gap the old code only partially covered.
  it.runIf(isPosix)(
    "leaves no temp file behind when the write step fails after the temp file is opened",
    async () => {
      const directory = await makeTempDirectory();
      const store = createFileSecretStore({ directory });
      const handlePrototype = await openHandlePrototype(directory);

      const writeFileSpy = vi
        .spyOn(handlePrototype, "writeFile")
        .mockRejectedValueOnce(new Error("simulated disk failure"));
      try {
        await expect(store.write("name", SensitiveValue.from("value"))).rejects.toThrow(
          "simulated disk failure",
        );
      } finally {
        writeFileSpy.mockRestore();
      }

      const files = await readdir(directory);
      expect(files).toEqual([]);
    },
  );

  // M5(b): a rename failure while writing a second value must not disturb
  // the first value, and must not leave the second value's temp file
  // behind. `rename` is mocked at module level (see the `vi.mock` block
  // below) since it — unlike a FileHandle method — is a standalone function
  // export, not a method on a shared prototype.
  it("keeps the previous value and leaves no temp file when rename fails mid-write", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    await store.write("name", SensitiveValue.from("first"));

    vi.mocked(rename).mockRejectedValueOnce(new Error("simulated rename failure"));
    await expect(store.write("name", SensitiveValue.from("second"))).rejects.toThrow(
      "simulated rename failure",
    );

    const value = await store.read("name");
    expect(value?.expose()).toBe("first");

    const files = await readdir(directory);
    expect(files).toEqual(["name.entry"]);
  });

  // M5(c): the temp filename itself must be dot-prefixed and never
  // `.entry`-suffixed, so a leaked temp file can never be mistaken for a
  // real entry by list(). Verified by capturing the path passed to the
  // cleanup `unlink` call during a forced write failure.
  it.runIf(isPosix)("uses a dot-prefixed, non-.entry-suffixed temp filename", async () => {
    const directory = await makeTempDirectory();
    const store = createFileSecretStore({ directory });
    const handlePrototype = await openHandlePrototype(directory);

    const writeFileSpy = vi
      .spyOn(handlePrototype, "writeFile")
      .mockRejectedValueOnce(new Error("simulated disk failure"));
    const unlinkedPaths: string[] = [];
    vi.mocked(unlink).mockImplementationOnce(async (path) => {
      unlinkedPaths.push(String(path));
    });

    try {
      await expect(store.write("name", SensitiveValue.from("value"))).rejects.toThrow();
    } finally {
      writeFileSpy.mockRestore();
    }

    expect(unlinkedPaths).toHaveLength(1);
    const tempFileName = unlinkedPaths[0]?.slice(directory.length + 1) ?? "";
    expect(tempFileName.startsWith(".")).toBe(true);
    expect(tempFileName.endsWith(".entry")).toBe(false);
  });
});

/** Opens (and immediately discards) a throwaway file handle purely to obtain the shared `FileHandle` prototype to spy on. */
async function openHandlePrototype(directory: string): Promise<FileHandle> {
  const probePath = join(directory, `.probe-${Math.random().toString(36).slice(2)}`);
  const handle = await open(probePath, "w");
  // Typed as `FileHandle` (not `Record<string, unknown>`): `vi.spyOn`
  // requires the target property to have a concrete function type to spy
  // on, and `Record<string, unknown>` types every property as `unknown`,
  // which `vi.spyOn`'s overload resolution rejects.
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  await unlink(probePath).catch(() => undefined);
  return prototype;
}

async function writeFileStray(directory: string, name: string, contents: string): Promise<void> {
  await writeFile(join(directory, name), contents, "utf8");
}
