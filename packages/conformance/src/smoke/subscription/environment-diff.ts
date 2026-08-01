/**
 * Render `VariableDecision[]` as the redacted markdown table that becomes the
 * issue's "redacted environment diff" evidence. Every column is derived from
 * `VariableDecision`, which by construction (`variables.ts`) carries a name,
 * an outcome, and a presence boolean — never a value — so this renderer
 * cannot leak a credential even if a decision list were built incorrectly
 * upstream.
 *
 * Pure: no network, filesystem, process, or clock access.
 */

import type { VariableDecision } from "./variables.js";

/**
 * A variable NAME is, in principle, still attacker/ambient-influenced data
 * (nothing stops a caller from constructing a `VariableDecision` with a
 * pipe or newline in its `name`), so it is escaped exactly like an
 * engine-controlled value would be, rather than trusted as "just an
 * identifier". This keeps a single stray row from corrupting or forging
 * the rest of the rendered table.
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderEnvironmentDiff(decisions: readonly VariableDecision[]): string {
  const lines = ["| variable | in ambient | decision |", "| --- | --- | --- |"];
  for (const decision of decisions) {
    lines.push(
      `| ${escapeCell(decision.name)} | ${decision.presentInAmbient} | ${decision.outcome} |`,
    );
  }
  return lines.join("\n");
}
