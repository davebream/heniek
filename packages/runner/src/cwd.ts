/**
 * Workspace-relative cwd resolution for command stages.
 *
 * Absolute paths, NUL bytes, and `..` segments are rejected. The resolved
 * path must stay inside the provisioned checkout.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export class InvalidCommandCwdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCommandCwdError";
  }
}

function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

/**
 * Validates `cwd` as a workspace-relative path and resolves it against
 * `checkoutPath`. Omitting `cwd` (or passing `"."` / `""`) resolves to the
 * checkout root.
 */
export function resolveCommandCwd(checkoutPath: string, cwd: string | undefined): string {
  const checkout = resolve(checkoutPath);
  if (cwd === undefined || cwd === "" || cwd === ".") {
    return checkout;
  }
  if (cwd.includes("\0")) {
    throw new InvalidCommandCwdError("command cwd must not contain NUL");
  }
  if (isAbsolute(cwd)) {
    throw new InvalidCommandCwdError("command cwd must be workspace-relative, not absolute");
  }
  const segments = cwd.split(/[\\/]/u);
  if (segments.some((segment) => segment === "..")) {
    throw new InvalidCommandCwdError("command cwd must not contain '..' segments");
  }
  if (segments.some((segment) => segment === "")) {
    throw new InvalidCommandCwdError("command cwd must not contain empty path segments");
  }
  const resolved = resolve(checkout, cwd);
  if (!isWithin(checkout, resolved)) {
    throw new InvalidCommandCwdError("command cwd escapes the workspace checkout");
  }
  return resolved;
}
