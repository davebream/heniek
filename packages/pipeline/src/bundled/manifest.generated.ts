/* eslint-disable */
/**
 * GENERATED FILE — do not edit by hand.
 * Source: packages/pipeline/bundled/*.yaml
 * Regenerate: pnpm --filter @heniek/pipeline generate
 */
export interface BundledPipelineManifestEntry {
  readonly id: string;
  readonly version: number;
  readonly sourceSha256: string;
  readonly normalizedGraphSha256: string;
  readonly source: string;
}

export const BUNDLED_PIPELINE_MANIFEST = {
  "fast.v1": {
    id: "fast",
    version: 1,
    sourceSha256: "89fe1b201d9590376080aac94abc474640c9034a73f1464768e31ad07c4afacb",
    normalizedGraphSha256: "8650b9e6d60a5cd31b8f261189abaebb2b7948fc1119579dc547e4cc534b469b",
    source: `# Bundled \`fast\` pipeline (Product Spec §30.1), adapted to the published
# PipelineDefinition/v1 surface:
# - \`produces\` → \`writes\` under the artifacts namespace
# - \`resume-if-compatible\` → \`session.policy: resume\`
# - stage-level \`when\` → a conditional edge (schema has no stage \`when\`)
# - verify requires a public profile id under current validation rules
# Ordering follows §30.1 (risk review before verify); see ADR 0028 for the
# §14.6 narrative discrepancy.
schemaVersion: 1
id: fast
name: Fast
description: >
  Shared deliberation, build with one bounded repair, optional fresh risk
  review, deterministic verification, then publish.
# Repair budget is 2 so one identical-signature validation repair is allowed
# under ADR 0026 (unchanged-signature ceiling uses >= budget).
mode: autonomous

limits:
  max_repair_attempts: 2

stages:
  - id: deliberate
    type: agent
    profile: task-owner
    reads:
      - task.current
    writes:
      - artifacts.understanding
      - artifacts.design
      - artifacts.plan
    completion:
      require:
        - valid_result_envelope
        - artifact: understanding
        - artifact: design
        - artifact: plan

  - id: build
    type: agent
    profile: task-owner
    needs: [deliberate]
    session:
      policy: resume
    reads:
      - task.current
      - artifacts.understanding
      - artifacts.design
      - artifacts.plan
    writes:
      - artifacts.implementation
    completion:
      require:
        - valid_result_envelope
        - non_empty_diff
    on_validation_failure:
      strategy: repair
      session: resume
      max_attempts: 2

  - id: risk-review
    type: agent
    profile: reviewer
    session:
      policy: fresh
    reads:
      - artifacts.implementation
    writes:
      - artifacts.risk_review
    completion:
      require:
        - valid_result_envelope
        - artifact: risk_review

  - id: verify
    type: verify
    profile: task-owner
    needs: [build, risk-review]
    reads:
      - artifacts.implementation
    writes:
      - artifacts.verification

  - id: publish
    type: publish
    needs: [verify]
    reads:
      - artifacts.implementation
      - artifacts.verification
    writes:
      - artifacts.publication

edges:
  - from: build
    to: risk-review
    when:
      expression: risk.requiresFreshReview == true
`,
  }
} as const satisfies Record<string, BundledPipelineManifestEntry>;

export type BundledPipelineId = keyof typeof BUNDLED_PIPELINE_MANIFEST;
