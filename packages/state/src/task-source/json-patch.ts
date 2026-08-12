import type { TaskRevision, TaskRevisionDocument } from "@heniek/contracts";
import { stringifyCanonical } from "../json.js";

export type JsonPatchOperation = TaskRevision["patch"][number];
type MutableJson =
  | null
  | boolean
  | number
  | string
  | MutableJson[]
  | { [key: string]: MutableJson };

export class TaskRevisionPatchError extends Error {
  override readonly name = "TaskRevisionPatchError";
}

function tokens(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new TaskRevisionPatchError("invalid JSON Pointer");
  return pointer
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?:[^01]|$)/.test(token))
        throw new TaskRevisionPatchError("invalid JSON Pointer escape");
      return token.replaceAll("~1", "/").replaceAll("~0", "~");
    });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function containerAt(root: MutableJson, path: string): { container: MutableJson; key: string } {
  const parts = tokens(path);
  const key = parts.pop();
  if (key === undefined) throw new TaskRevisionPatchError("the document root has no parent");
  let current: MutableJson = root;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = arrayIndex(part, current.length, false);
      current = current[index] as MutableJson;
    } else if (typeof current === "object" && current !== null && part in current) {
      current = current[part] as MutableJson;
    } else {
      throw new TaskRevisionPatchError(`JSON Pointer does not exist: ${path}`);
    }
  }
  return { container: current, key };
}

function arrayIndex(token: string, length: number, allowEnd: boolean): number {
  if (allowEnd && token === "-") return length;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new TaskRevisionPatchError("invalid array index");
  const index = Number(token);
  if (!Number.isSafeInteger(index) || index < 0 || index >= length + Number(allowEnd)) {
    throw new TaskRevisionPatchError("array index is out of bounds");
  }
  return index;
}

function valueAt(root: MutableJson, path: string): MutableJson {
  const parts = tokens(path);
  let current = root;
  for (const part of parts) {
    if (Array.isArray(current))
      current = current[arrayIndex(part, current.length, false)] as MutableJson;
    else if (typeof current === "object" && current !== null && part in current)
      current = current[part] as MutableJson;
    else throw new TaskRevisionPatchError(`JSON Pointer does not exist: ${path}`);
  }
  return current;
}

function remove(root: MutableJson, path: string): MutableJson {
  if (path === "") throw new TaskRevisionPatchError("task revision patches cannot remove the root");
  const { container, key } = containerAt(root, path);
  if (Array.isArray(container))
    return container.splice(arrayIndex(key, container.length, false), 1)[0] as MutableJson;
  if (typeof container !== "object" || container === null || !(key in container))
    throw new TaskRevisionPatchError(`JSON Pointer does not exist: ${path}`);
  const previous = container[key] as MutableJson;
  delete container[key];
  return previous;
}

function add(root: MutableJson, path: string, value: MutableJson): MutableJson {
  if (path === "") return clone(value);
  const { container, key } = containerAt(root, path);
  if (Array.isArray(container))
    container.splice(arrayIndex(key, container.length, true), 0, clone(value));
  else if (typeof container === "object" && container !== null) container[key] = clone(value);
  else throw new TaskRevisionPatchError(`JSON Pointer parent is not a container: ${path}`);
  return root;
}

export function applyTaskRevisionPatch(
  document: TaskRevisionDocument,
  operations: readonly JsonPatchOperation[],
): TaskRevisionDocument {
  if (operations.length > 256)
    throw new TaskRevisionPatchError("task revision patch exceeds 256 operations");
  let result = clone(document) as unknown as MutableJson;
  for (const operation of operations) {
    if (operation.op === "add")
      result = add(result, operation.path, clone(operation.value as unknown as MutableJson));
    else if (operation.op === "remove") remove(result, operation.path);
    else if (operation.op === "replace") {
      if (operation.path === "") result = clone(operation.value as unknown as MutableJson);
      else {
        remove(result, operation.path);
        result = add(result, operation.path, clone(operation.value as unknown as MutableJson));
      }
    } else if (operation.op === "copy") {
      result = add(result, operation.path, clone(valueAt(result, operation.from ?? "")));
    } else if (operation.op === "move") {
      const moved = remove(result, operation.from ?? "");
      result = add(result, operation.path, moved);
    } else if (operation.op === "test") {
      if (
        stringifyCanonical(valueAt(result, operation.path)) !==
        stringifyCanonical(operation.value as never)
      )
        throw new TaskRevisionPatchError(`JSON Patch test failed at ${operation.path}`);
    } else throw new TaskRevisionPatchError("unknown JSON Patch operation");
  }
  if (typeof result !== "object" || result === null || Array.isArray(result))
    throw new TaskRevisionPatchError("task revision document must remain an object");
  return result as unknown as TaskRevisionDocument;
}
