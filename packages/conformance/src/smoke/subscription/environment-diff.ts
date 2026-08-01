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

/** No rendered table cell may exceed this many characters (review finding 7). */
const MAX_CELL_LENGTH = 200;
const TRUNCATION_MARKER = "...<truncated>";

/**
 * Shared markdown-table cell escaping, exported so `canaries.ts`'s
 * `toMarkdownTable` uses the identical rule rather than a second,
 * independently-maintained copy (review finding 11) — both renderers treat
 * their inputs (a `VariableDecision` name, a canary's `name`/`evidence`) as
 * attacker/ambient-influenced data, never as trusted identifiers.
 *
 * Three defences, all load-bearing:
 *  1. `|` is escaped so it cannot forge an extra column.
 *  2. `\r\n`, a lone `\n`, AND a lone `\r` are all collapsed to a single
 *     space. A prior version only handled `\r?\n`, which left a bare `\r`
 *     (no trailing `\n`) unescaped — many terminals and some CLI diagnostics
 *     render a lone `\r` as an in-place line overwrite, which could still
 *     visually corrupt or split a rendered row.
 *  3. The escaped cell is bounded to `MAX_CELL_LENGTH` characters, so a
 *     single unexpectedly large value (or many repetitions of a short one)
 *     cannot blow up the size of committed ADR evidence or a CI log.
 */
export function escapeMarkdownTableCell(value: string): string {
  const escaped = value.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, " ");
  if (escaped.length <= MAX_CELL_LENGTH) return escaped;
  return escaped.slice(0, MAX_CELL_LENGTH) + TRUNCATION_MARKER;
}

export function renderEnvironmentDiff(decisions: readonly VariableDecision[]): string {
  const lines = ["| variable | in ambient | decision |", "| --- | --- | --- |"];
  for (const decision of decisions) {
    lines.push(
      `| ${escapeMarkdownTableCell(decision.name)} | ${decision.presentInAmbient} | ${decision.outcome} |`,
    );
  }
  return lines.join("\n");
}
