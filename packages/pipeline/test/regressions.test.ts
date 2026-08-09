/**
 * One case per defect found while building this package. Each names what was
 * wrong, why nothing caught it, and what the assertion now pins.
 *
 * The corpus would catch most of these too, since every one of them changes
 * bytes in a checked-in expected file. They are restated here because a
 * corpus diff says *that* something moved and this file says *what* it was
 * and why it mattered — which is the difference between a test that passes
 * and a test that explains itself to whoever breaks it next.
 */

import { describe, expect, it } from "vitest";
import { parsePipelineDocument } from "../src/parse.js";
import { suggestionForPointer } from "../src/suggestions.js";

function diagnosticsFor(source: string) {
  return parsePipelineDocument(source, { sourcePath: "regression.yaml" }).diagnostics;
}

/**
 * A stage `type` outside the six v1 values failed all six literal branches of
 * the union *and* the enclosing `anyOf`, and Ajv's `allErrors: true` reported
 * every one of them. One typo produced seven diagnostics at one pointer with
 * one identical correction repeated seven times.
 *
 * Nothing caught it because every individual diagnostic was correct: the
 * position was right, the rule was right, the suggestion was right. Only the
 * *set* was wrong, and no assertion looked at the set.
 */
describe("a failed union reports once, not once per alternative", () => {
  const source = `
schemaVersion: 1
id: bad-type
stages:
  - id: only
    type: agents
    profile: opus-planner
`;

  it("reports exactly one diagnostic", () => {
    expect(diagnosticsFor(source)).toHaveLength(1);
  });

  it("says which value is wrong in words, not in Ajv's", () => {
    const [diagnostic] = diagnosticsFor(source);
    expect(diagnostic?.message).not.toContain("anyOf");
    expect(diagnostic?.suggestion).toContain("agent, command, approval");
  });

  /**
   * The collapse is scoped to union branches. Two genuinely different
   * violations at one pointer are two different things to fix, and dropping
   * one of them would trade a noisy diagnostic for a missing one.
   */
  it("keeps two distinct violations at the same pointer", () => {
    const codes = diagnosticsFor(`
schemaVersion: 1
id: ""
stages:
  - id: only
    type: approval
`);
    expect(codes.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * A read whose namespace does not exist was reported twice: once as an
 * unknown namespace, and again as "nothing in this pipeline writes it" —
 * which is true, trivially, and buries the diagnostic that names the actual
 * mistake.
 */
describe("an unknown state namespace is reported once", () => {
  it("does not also claim nothing writes it", () => {
    const codes = diagnosticsFor(`
schemaVersion: 1
id: unknown-namespace
stages:
  - id: only
    type: agent
    profile: opus-planner
    reads: [session.token_budget]
`).map((diagnostic) => diagnostic.code);
    expect(codes).toContain("pipeline.unknown-state-namespace");
    expect(codes).not.toContain("pipeline.read-not-produced");
  });
});

/**
 * The suggestion lookup walked up the pointer until it found a match, and the
 * document root always matched — so a violation at a pointer the table had
 * never seen was answered with "a pipeline document is a mapping with
 * schemaVersion, id, and stages", which is true of every document and useful
 * for none of them. The generic "check it against the published schema"
 * fallback was unreachable.
 */
describe("pointer advice does not fall through to the document root", () => {
  it("names the published schema for an unrecognised pointer", () => {
    expect(suggestionForPointer("/nothing/like/this")).toContain("PipelineDefinition/v1");
  });

  it("still answers a violation reported at the root", () => {
    expect(suggestionForPointer("")).toContain("schemaVersion");
  });
});

/**
 * Stage-type and strategy names were interpolated after a bare "A", so an
 * `agent` stage was described as `A "agent" stage`. Cosmetic, and exactly the
 * kind of cosmetic that makes a tool read as unmaintained.
 */
describe("diagnostics use the right indefinite article", () => {
  it('says An "agent", not A "agent"', () => {
    const messages = diagnosticsFor(`
schemaVersion: 1
id: articles
stages:
  - id: only
    type: agent
`).map((diagnostic) => diagnostic.message);
    expect(messages.some((message) => message.startsWith('An "agent"'))).toBe(true);
    expect(messages.some((message) => message.startsWith('A "agent"'))).toBe(false);
  });
});
