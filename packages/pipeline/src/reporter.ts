/**
 * One place that turns "rule R was violated at pointer P" into a complete
 * diagnostic.
 *
 * Every pipeline diagnostic must name the file, the path, the line and
 * column, the rule, and the correction. Four of those six are the same work
 * every time — resolve the pointer to a position, attach the source path,
 * sort the result — so it happens here rather than at forty call sites, and
 * a rule that forgets one of them cannot be written.
 */

import type { DiagnosticSeverity } from "@heniek/config";
import type { PipelineDiagnostic } from "./diagnostics.js";
import { createPipelineDiagnostic, sortPipelineDiagnostics } from "./diagnostics.js";

export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

export type PositionResolver = (pointer: string) => SourcePosition | undefined;

export interface DiagnosticReporter {
  error(code: string, message: string, pointer: string, suggestion: string): void;
  warn(code: string, message: string, pointer: string, suggestion: string): void;
  add(diagnostic: PipelineDiagnostic): void;
  /** Sorted by `comparePipelineDiagnostics`, so the same findings always serialise to the same bytes. */
  collect(): readonly PipelineDiagnostic[];
  hasErrors(): boolean;
}

export function createDiagnosticReporter(options: {
  readonly sourcePath?: string;
  readonly resolvePosition?: PositionResolver;
}): DiagnosticReporter {
  const collected: PipelineDiagnostic[] = [];
  const { sourcePath, resolvePosition } = options;

  function push(
    code: string,
    severity: DiagnosticSeverity,
    message: string,
    pointer: string,
    suggestion: string,
  ): void {
    const position = resolvePosition?.(pointer);
    collected.push(
      createPipelineDiagnostic(
        code,
        severity,
        message,
        {
          ...(sourcePath !== undefined ? { sourcePath } : {}),
          pointer,
          ...(position !== undefined ? { line: position.line, column: position.column } : {}),
        },
        suggestion,
      ),
    );
  }

  return {
    error: (code, message, pointer, suggestion) =>
      push(code, "error", message, pointer, suggestion),
    warn: (code, message, pointer, suggestion) =>
      push(code, "warning", message, pointer, suggestion),
    add: (diagnostic) => {
      collected.push(diagnostic);
    },
    collect: () => sortPipelineDiagnostics(collected),
    hasErrors: () => collected.some((diagnostic) => diagnostic.severity === "error"),
  };
}
