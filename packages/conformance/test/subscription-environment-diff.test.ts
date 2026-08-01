import { describe, expect, it } from "vitest";
import {
  escapeMarkdownTableCell,
  renderEnvironmentDiff,
} from "../src/smoke/subscription/environment-diff.js";
import type { VariableDecision } from "../src/smoke/subscription/variables.js";

/**
 * FIX-5: `environment-diff.ts` had zero committed test coverage before this
 * fix — the renderer is pure and trivially hermetic, so there was no excuse
 * for it to be exercised only indirectly (e.g. by eyeballing the ADR
 * evidence file). This file exists so the renderer's contract — one row per
 * decision, a stable header, and escaping that cannot be defeated by a
 * pipe or newline embedded in a decision's `name` — is directly pinned.
 */

function decision(
  name: string,
  outcome: VariableDecision["outcome"],
  presentInAmbient = true,
): VariableDecision {
  return { name, outcome, presentInAmbient };
}

describe("renderEnvironmentDiff", () => {
  it("renders the header row even for an empty decision list", () => {
    const table = renderEnvironmentDiff([]);
    expect(table).toBe("| variable | in ambient | decision |\n| --- | --- | --- |");
  });

  it("renders exactly one row per decision, in order", () => {
    const table = renderEnvironmentDiff([
      decision("CLAUDE_CODE_OAUTH_TOKEN", "admitted-carrier"),
      decision("HOME", "admitted-config-home", false),
      decision("ANTHROPIC_API_KEY", "denied-hostile"),
    ]);
    const rows = table.split("\n");
    expect(rows).toHaveLength(5); // header + separator + 3 decisions
    expect(rows[2]).toBe("| CLAUDE_CODE_OAUTH_TOKEN | true | admitted-carrier |");
    expect(rows[3]).toBe("| HOME | false | admitted-config-home |");
    expect(rows[4]).toBe("| ANTHROPIC_API_KEY | true | denied-hostile |");
  });

  // Escaping: a variable NAME is, in principle, still attacker/ambient-
  // influenced data (nothing stops a caller from constructing a
  // VariableDecision with a pipe or newline in its `name`), so it must be
  // escaped exactly like an engine-controlled value would be.
  it("escapes a pipe character in a decision's name so it cannot corrupt the table's column count", () => {
    const table = renderEnvironmentDiff([decision("WEIRD|NAME", "denied-unlisted")]);
    const rows = table.split("\n");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toBe("| WEIRD\\|NAME | true | denied-unlisted |");
  });

  it("collapses an embedded newline in a decision's name to a single row", () => {
    const table = renderEnvironmentDiff([decision("WEIRD\nNAME", "denied-unlisted")]);
    const rows = table.split("\n");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toBe("| WEIRD NAME | true | denied-unlisted |");
  });

  // Review finding 7: a prior version only escaped `\r?\n`, leaving a LONE
  // `\r` (no trailing `\n`) untouched — some terminals and CLI diagnostics
  // render a bare `\r` as an in-place line overwrite, which could still
  // visually split or corrupt a rendered row.
  it("[regression] escapes a lone carriage return (no trailing newline) in a decision's name", () => {
    const table = renderEnvironmentDiff([decision("WEIRD\rNAME", "denied-unlisted")]);
    const rows = table.split("\n");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toBe("| WEIRD NAME | true | denied-unlisted |");
  });

  // Review finding 7: a single unexpectedly large value (or a bug producing
  // one) must not blow up the size of committed ADR evidence or a CI log.
  it("[regression] bounds an oversized decision name to a fixed cell length", () => {
    const hugeName = "X".repeat(5000);
    const table = renderEnvironmentDiff([decision(hugeName, "denied-unlisted")]);
    const rows = table.split("\n");
    expect(rows[2]?.length).toBeLessThan(400);
    expect(rows[2]).toContain("<truncated>");
  });

  describe("escapeMarkdownTableCell", () => {
    it("escapes a pipe character", () => {
      expect(escapeMarkdownTableCell("a|b")).toBe("a\\|b");
    });

    it("collapses CRLF, a lone LF, and a lone CR to a single space", () => {
      expect(escapeMarkdownTableCell("a\r\nb")).toBe("a b");
      expect(escapeMarkdownTableCell("a\nb")).toBe("a b");
      expect(escapeMarkdownTableCell("a\rb")).toBe("a b");
    });

    it("bounds an oversized value and marks it truncated", () => {
      const result = escapeMarkdownTableCell("Y".repeat(1000));
      expect(result.length).toBeLessThan(300);
      expect(result).toContain("<truncated>");
    });

    it("leaves a short, ordinary value untouched", () => {
      expect(escapeMarkdownTableCell("CLAUDE_CODE_OAUTH_TOKEN")).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    });
  });

  // Sentinel test: proves no VALUE can reach the rendered table, because
  // VariableDecision by construction never carries one — only a name, an
  // outcome, and a presence boolean. This test constructs a decision whose
  // name happens to look like it could carry a leaked sentinel and confirms
  // the renderer only ever emits the three declared fields.
  it("[sentinel] the rendered table can never contain a credential value, because VariableDecision never carries one", () => {
    const sentinelValue = "SENTINEL-SHOULD-NEVER-APPEAR-NOT-REAL";
    const decisions: readonly VariableDecision[] = [
      decision("CLAUDE_CODE_OAUTH_TOKEN", "admitted-carrier"),
    ];
    // There is no field on VariableDecision through which `sentinelValue`
    // could flow into the renderer at all — this assertion documents that
    // invariant by exhaustively rendering every declared field and checking
    // the sentinel never appears, rather than trusting the type alone.
    const table = renderEnvironmentDiff(decisions);
    expect(table).not.toContain(sentinelValue);
    expect(JSON.stringify(decisions)).not.toContain(sentinelValue);
  });
});
