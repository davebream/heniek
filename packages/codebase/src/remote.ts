import { resolve } from "node:path";

function stripDotGit(path: string): string {
  return path.replace(/\/+$/, "").replace(/\.git$/i, "");
}

function normalizeNetworkUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const port =
    (protocol === "https:" && parsed.port === "443") ||
    (protocol === "http:" && parsed.port === "80") ||
    (protocol === "ssh:" && parsed.port === "22")
      ? ""
      : parsed.port;
  const credentials = protocol === "ssh:" && parsed.username === "git" ? "git@" : "";
  const authority = `${credentials}${host}${port === "" ? "" : `:${port}`}`;
  return `${protocol}//${authority}${stripDotGit(parsed.pathname)}`;
}

/** Canonicalizes remotes without ever retaining HTTP credentials or URL fragments. */
export function normalizeRemoteUrl(value: string, repositoryPath: string): string {
  const trimmed = value.trim();
  const scp = /^([^/@:]+)@([^/:]+):(.+)$/.exec(trimmed);
  if (scp !== null) {
    const [, user, host, path] = scp;
    const safeUser = user === "git" ? "git@" : "";
    return `ssh://${safeUser}${host?.toLowerCase()}/${stripDotGit(path ?? "")}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    if (trimmed.startsWith("file://")) {
      return `file://${stripDotGit(new URL(trimmed).pathname)}`;
    }
    return normalizeNetworkUrl(trimmed);
  }
  return `file://${stripDotGit(resolve(repositoryPath, trimmed))}`;
}
