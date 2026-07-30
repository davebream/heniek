import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type IssueDefinition, issues, milestones } from "./definitions.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputRoot = resolve(repositoryRoot, "docs/backlog/revision-1");
const checkOnly = process.argv.includes("--check");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function list(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function renderIssue(issue: IssueDefinition, index: number, queueHash: string): string {
  const previous = index === 0 ? null : issues[index - 1]?.id;
  const marker = {
    revision: 1,
    sequence: issue.id,
    previous,
    milestone: issue.milestone,
    queueHash,
  };

  return `<!-- heniek-queue ${JSON.stringify(marker)} -->

# ${issue.id} — ${issue.title}

## Outcome

${issue.outcome}

## Specification anchors

${list(issue.anchors)}

## Dependency

${previous === null ? "First queue item. Requires only the approved revision-1 bootstrap." : `Requires ${previous} to be merged and independently confirmed on remote \`main\`.`}

## Tier

\`${issue.tier}\`

## Constraints

${list([
  ...issue.constraints,
  "Preserve Product Specification v0.2 commitments and acceptance criteria.",
  "Keep Windmill, Kombajn, and TAKT out of Heniek runtime dependencies.",
  "Use strict ESM TypeScript, provider-neutral public contracts, and repository conventions.",
])}

## Exclusions

${list([
  ...issue.exclusions,
  "No factory runtime state, credentials, transcripts, or control artifacts in this repository.",
  "No unrelated backlog work or speculative scope reduction.",
])}

## Acceptance criteria

${issue.acceptance.map((item) => `- [ ] ${item}`).join("\n")}
- [ ] Public contracts and generated schemas remain compatible or are versioned deliberately.
- [ ] \`pnpm check\` passes from a clean checkout on Node.js 24.
- [ ] The pull request is non-draft, self-contained, and uses \`Closes <this issue>\`.

## Required tests

${list(issue.tests)}
- Regression tests for every defect discovered while implementing this issue.

## Required evidence

${list(issue.evidence)}
- Exact commands and results for local checks.
- GitHub required-check and merge confirmation.

## Autonomous stop conditions

Stop with a typed blocker and evidence if the predecessor is not merged, queue
markers disagree, a product commitment would need to be narrowed, a required
subscription route cannot be proven, credentials could be exposed, or a genuine
technical ambiguity remains after the issue's bounded spike/ADR path.
`;
}

const orderedQueue = issues.map((issue, index) => ({
  sequence: issue.id,
  predecessor: index === 0 ? null : issues[index - 1]?.id,
  milestone: issue.milestone,
  title: issue.title,
  tier: issue.tier,
}));

const queueHash = sha256(
  JSON.stringify({
    revision: 1,
    orderedQueue,
  }),
);

const renderedWithoutBodyHashes = issues.map((issue, index) =>
  renderIssue(issue, index, queueHash),
);
const bodyHashes = renderedWithoutBodyHashes.map((body) => sha256(body));
const renderedIssues = renderedWithoutBodyHashes;

const manifest = {
  schemaVersion: "heniek.backlog-manifest.v1",
  revision: 1,
  state: "awaiting-launch-approval",
  queueHash,
  issueCount: issues.length,
  parentEpic: {
    title: "EPIC — Heniek v1",
    marker: `heniek-queue revision=1 sha256=${queueHash} count=${issues.length}`,
  },
  milestones,
  issues: orderedQueue.map((issue, index) => ({
    ...issue,
    bodyPath: `issues/${issue.sequence}.md`,
    bodyHash: bodyHashes[index],
  })),
};

const epicPreview = `<!-- ${manifest.parentEpic.marker} -->

# EPIC — Heniek v1

Deliver every fixed v1 commitment in Product Specification v0.2 through the
strict revision-1 queue. The queue is a total order: an item becomes claimable
only after its predecessor is merged, closed, and independently visible on
remote \`main\`.

Queue SHA-256: \`${queueHash}\`

${milestones
  .map((milestone) => {
    const taskList = orderedQueue
      .filter((issue) => issue.milestone === milestone.id)
      .map((issue) => `- [ ] ${issue.sequence} — ${issue.title}`)
      .join("\n");
    return `## ${milestone.id} — ${milestone.title}\n\n${milestone.description}\n\n${taskList}`;
  })
  .join("\n\n")}

Any mismatch between this marker/order, the manifest, or an issue marker pauses
the factory. The controller never skips or guesses.
`;

async function fileHash(path: string): Promise<string> {
  return sha256(await readFile(resolve(repositoryRoot, path), "utf8"));
}

const productSpecV01Hash = await fileHash("docs/product/product-spec-v0.1.md");
const productSpecV02Hash = await fileHash("docs/product/product-spec-v0.2.md");
const brandReportHash = await fileHash("docs/provenance/brand-name-creation-report-v0.1.md");
const decisionAuditHash = await fileHash("docs/provenance/decision-audit-v0.1.md");

const approval = `# Heniek revision-1 backlog approval artifact

Status: **not approved; publication and factory launch are disabled**

This document is the cold-read queue artifact for the single launch approval.
Approval freezes this exact queue revision and authorizes publication and the
bounded seven-day factory only when the separate machine-readable readiness
report is also \`ready: true\`.

## Canonical inputs

| Artifact | SHA-256 |
|---|---|
| Product Specification v0.1 | \`${productSpecV01Hash}\` |
| Product Specification v0.2 | \`${productSpecV02Hash}\` |
| Brand report v0.1 | \`${brandReportHash}\` |
| Decision audit v0.1 | \`${decisionAuditHash}\` |
| Ordered queue revision 1 | \`${queueHash}\` |

The two originally attached v0.1 product-spec files were byte-identical with
SHA-256 \`${productSpecV01Hash}\`; one canonical copy is preserved.

## Queue invariant

- 57 issue packets, eight milestones, one parent epic.
- Strict total order from Q001 through Q057.
- Every issue depends on its predecessor; there is no skip action.
- Manifest, epic marker/order, and issue markers must agree on queue hash.
- A mismatch pauses the factory before claim or mutation.

## Ordered backlog

| Sequence | Milestone | Tier | Title |
|---|---|---|---|
${orderedQueue
  .map((issue) => `| ${issue.sequence} | ${issue.milestone} | ${issue.tier} | ${issue.title} |`)
  .join("\n")}

## Reference pins

| Component | Approved pin |
|---|---|
| Kombajn | \`936aaf145c667cf44573584b29f44ba006e5aee7\`; plugin \`1.327.0\` |
| TAKT | \`ee15089b276e9c66c115c7864d64b6c47c986291\` |
| Claudexor | \`v3.1.2\`; \`bb5efee24132aa3d65e417040df201e08da44c8c\` |
| Claude Code | \`2.1.220\` |
| Codex CLI | \`0.146.0\` |
| Cursor CLI | \`2026.06.12-01-15-52-7244546\` |

## Approval meaning

Approval is not a waiver of the readiness gate. The launch dossier must include
this queue hash, document hashes, verified tool pins, billing attestation,
\`ready: true\` evidence, and exact start/deadline. Without that complete dossier
the issues remain previews and the schedule remains disabled.
`;

const outputs = new Map<string, string>([
  [resolve(outputRoot, "manifest.json"), canonicalJson(manifest)],
  [resolve(outputRoot, "epic-preview.md"), epicPreview],
  [resolve(outputRoot, "approval.md"), approval],
]);

for (const [index, issue] of issues.entries()) {
  outputs.set(resolve(outputRoot, `issues/${issue.id}.md`), renderedIssues[index] ?? "");
}

for (const [path, content] of outputs) {
  if (checkOnly) {
    const existing = await readFile(path, "utf8").catch(() => "");
    if (existing !== content) {
      throw new Error(`Generated backlog artifact is stale: ${path}`);
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}
