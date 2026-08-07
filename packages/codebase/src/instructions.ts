import { dirname, extname, isAbsolute, normalize } from "node:path";
import type { RepositoryId } from "@heniek/contracts";
import { CodebaseError } from "./errors.js";
import type {
  AdditionalInstructionSource,
  CodebaseFileSystem,
  GitRepositoryObservation,
  HashPort,
  InstructionDiagnostic,
  InstructionSnapshot,
} from "./types.js";

interface SourceDraft {
  readonly sourceId: string;
  readonly kind: "shared" | "provider-native" | "orchestrator" | "profile-role" | "stage";
  readonly provider: "claude" | "codex" | "cursor" | null;
  readonly repositoryId: RepositoryId | null;
  readonly path: string;
  readonly absolutePath: string;
  readonly scope: string;
  readonly precedence: number;
  readonly content: string;
  readonly contentSha256: string;
}

interface Claim {
  readonly sourceId: string;
  readonly line: number;
  readonly key: string;
  readonly value: string;
  readonly polarity: "positive" | "negative";
  readonly tokens: ReadonlySet<string>;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "be",
  "for",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
]);

const IMPERATIVE_VERBS = new Set([
  "add",
  "avoid",
  "configure",
  "ensure",
  "keep",
  "prefer",
  "preserve",
  "record",
  "remove",
  "run",
  "set",
  "store",
  "strip",
  "treat",
  "use",
]);

function normalized(value: string): string {
  return value
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.;]+$/, "")
    .trim()
    .toLowerCase();
}

function tokens(value: string): ReadonlySet<string> {
  return new Set(
    normalized(value)
      .split(/[^a-z0-9@./_-]+/)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

function claimFor(line: string, lineNumber: number, sourceId: string): Claim | null {
  const text = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim();
  if (text === "" || text.startsWith("#")) return null;

  const keyed = /^([a-z][a-z0-9 _/-]{1,48})\s*:\s*(.+)$/i.exec(text);
  if (keyed !== null) {
    const key = normalized(keyed[1] ?? "");
    const value = normalized(keyed[2] ?? "");
    return {
      sourceId,
      line: lineNumber,
      key: `key:${key}`,
      value,
      polarity: "positive",
      tokens: tokens(`${key} ${value}`),
    };
  }

  const modal =
    /^(must not|do not|never|avoid|forbid(?:den)?|must|always|required|use)\s+(.+)$/i.exec(text);
  if (modal !== null) {
    const mode = normalized(modal[1] ?? "");
    const rawValue = normalized(modal[2] ?? "");
    const polarity = /not|never|avoid|forbid/.test(mode) ? "negative" : "positive";
    const value =
      polarity === "negative" ? rawValue.replace(/^(?:add|run|store|use)\s+/, "") : rawValue;
    return {
      sourceId,
      line: lineNumber,
      key: `directive:${value}`,
      value,
      polarity,
      tokens: tokens(value),
    };
  }

  const imperative = /^([a-z]+)\s+(.+)$/i.exec(text);
  const verb = normalized(imperative?.[1] ?? "");
  if (imperative === null || !IMPERATIVE_VERBS.has(verb)) return null;
  const value = normalized(imperative[2] ?? "");
  return {
    sourceId,
    line: lineNumber,
    key: `directive:${value}`,
    value,
    polarity: verb === "avoid" || verb === "remove" ? "negative" : "positive",
    tokens: tokens(value),
  };
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function diagnostic(
  classification: "additive" | "incompatible" | "indeterminate",
  code: string,
  topic: string,
  left: Claim,
  right: Claim,
): InstructionDiagnostic {
  return {
    schemaVersion: 1,
    code,
    classification,
    topic,
    message:
      classification === "additive"
        ? `Instruction guidance for ${topic} is additive.`
        : classification === "incompatible"
          ? `Instruction requirements for ${topic} are incompatible.`
          : `Instruction requirements for ${topic} overlap but cannot be resolved deterministically.`,
    anchors: [
      { sourceId: left.sourceId, startLine: left.line, endLine: left.line },
      { sourceId: right.sourceId, startLine: right.line, endLine: right.line },
    ],
  };
}

export function classifyInstructionClaims(
  sources: readonly SourceDraft[],
): InstructionDiagnostic[] {
  const claims = sources.flatMap((source) =>
    source.content.split(/\r?\n/).flatMap((line, index) => {
      const claim = claimFor(line, index + 1, source.sourceId);
      return claim === null ? [] : [claim];
    }),
  );
  const results: InstructionDiagnostic[] = [];
  const seen = new Set<string>();
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    const left = claims[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      const right = claims[rightIndex];
      if (right === undefined) continue;
      let result: InstructionDiagnostic | null = null;
      if (left.key === right.key) {
        const keyed = left.key.startsWith("key:");
        const topic = keyed ? left.key.slice(4) : left.value;
        result =
          left.polarity === right.polarity && left.value === right.value
            ? diagnostic("additive", "INSTRUCTION_ADDITIVE", topic, left, right)
            : diagnostic(
                "incompatible",
                keyed ? "INSTRUCTION_VALUE_CONFLICT" : "INSTRUCTION_CONFLICT",
                topic,
                left,
                right,
              );
      } else if (overlap(left.tokens, right.tokens) >= 0.6) {
        result = diagnostic("indeterminate", "INSTRUCTION_OVERLAP", left.value, left, right);
      }
      if (result !== null) {
        const key = result.anchors
          .map((anchor) => `${anchor.sourceId}:${anchor.startLine}`)
          .sort()
          .join("|");
        if (!seen.has(key)) {
          seen.add(key);
          results.push(result);
        }
      }
    }
  }
  return results.sort((left, right) => {
    const a = `${left.classification}:${left.topic}:${left.anchors[0]?.sourceId ?? ""}`;
    const b = `${right.classification}:${right.topic}:${right.anchors[0]?.sourceId ?? ""}`;
    return a.localeCompare(b);
  });
}

function sourceKind(path: string): Pick<SourceDraft, "kind" | "provider" | "precedence"> | null {
  if (path === "README.md" || path === "docs/architecture.md")
    return { kind: "shared", provider: null, precedence: 1 };
  if (path.endsWith("/AGENTS.md") || path === "AGENTS.md")
    return { kind: "provider-native", provider: "codex", precedence: 2 };
  if (path.endsWith("/CLAUDE.md") || path === "CLAUDE.md")
    return { kind: "provider-native", provider: "claude", precedence: 2 };
  if (path.startsWith(".cursor/rules/") && [".md", ".mdc"].includes(extname(path)))
    return { kind: "provider-native", provider: "cursor", precedence: 2 };
  return null;
}

function canonicalSnapshot(
  hash: HashPort,
  capturedAt: string,
  sources: readonly SourceDraft[],
): InstructionSnapshot {
  const diagnostics = classifyInstructionClaims(sources);
  const publicSources = sources
    .map((source) => ({
      sourceId: source.sourceId,
      kind: source.kind,
      provider: source.provider,
      location: {
        kind:
          source.repositoryId === null ? ("application-home" as const) : ("repository" as const),
        repositoryId: source.repositoryId,
        path: source.path,
      },
      scope: source.scope,
      precedence: source.precedence,
      contentSha256: source.contentSha256,
    }))
    .sort((left, right) => {
      const leftDepth = left.scope === "" ? 0 : left.scope.split("/").length;
      const rightDepth = right.scope === "" ? 0 : right.scope.split("/").length;
      return `${left.precedence}:${leftDepth.toString().padStart(4, "0")}:${left.location.path}`.localeCompare(
        `${right.precedence}:${rightDepth.toString().padStart(4, "0")}:${right.location.path}`,
      );
    });
  const body = JSON.stringify({ sources: publicSources, diagnostics });
  return {
    schemaVersion: 1,
    snapshotSha256: hash.sha256(body),
    capturedAt,
    readiness: diagnostics.some((entry) => entry.classification !== "additive")
      ? "blocked"
      : "ready",
    sources: publicSources,
    diagnostics,
  };
}

export async function buildInstructionSnapshot(
  fs: CodebaseFileSystem,
  hash: HashPort,
  capturedAt: string,
  repositories: readonly (GitRepositoryObservation & {
    readonly repositoryId: RepositoryId | null;
  })[],
  additional: readonly AdditionalInstructionSource[] = [],
): Promise<InstructionSnapshot> {
  const sources: SourceDraft[] = [];
  for (const repository of repositories) {
    for (const path of [...repository.visibleFiles].sort()) {
      const metadata = sourceKind(path);
      if (metadata === null) continue;
      const absolutePath = `${repository.path}/${path}`;
      const content = await fs.readText(absolutePath);
      const locationKey = `repository:${repository.repositoryId ?? repository.path}:${path}`;
      sources.push({
        sourceId: `ins-${hash.sha256(locationKey).slice(0, 24)}`,
        ...metadata,
        repositoryId: repository.repositoryId,
        path,
        absolutePath,
        scope: dirname(path) === "." ? "" : dirname(path),
        content,
        contentSha256: hash.sha256(content),
      });
    }
  }
  for (const source of additional) {
    const locationPath = normalize(source.locationPath);
    if (
      isAbsolute(locationPath) ||
      locationPath === ".." ||
      locationPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ) {
      throw new CodebaseError(
        "INVALID_INSTRUCTION_LOCATION",
        "Application-home instruction locations must be relative paths.",
      );
    }
    const absolutePath = await fs.realpath(source.path);
    const content = await fs.readText(absolutePath);
    const precedence = source.kind === "orchestrator" ? 3 : source.kind === "profile-role" ? 4 : 5;
    sources.push({
      sourceId: `ins-${hash.sha256(`application-home:${absolutePath}`).slice(0, 24)}`,
      kind: source.kind,
      provider: null,
      repositoryId: null,
      path: locationPath,
      absolutePath,
      scope: source.scope ?? "",
      precedence,
      content,
      contentSha256: hash.sha256(content),
    });
  }
  return canonicalSnapshot(hash, capturedAt, sources);
}
