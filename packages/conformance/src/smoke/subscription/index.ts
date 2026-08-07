export {
  type AttestationValidity,
  assertSubscriptionOnly,
  BILLING_ROUTES,
  type BillingRoute,
  type BillingRouteAttestation,
  type ClaudeAuthDiagnostic,
  classifyClaudeBillingRoute,
  classifyCodexBillingRoute,
  MalformedClaudeDiagnosticError,
  parseClaudeAuthDiagnostic,
  SubscriptionRouteViolationError,
} from "./attestation.js";
export {
  type CredentialLifecycleFacts,
  type CredentialLifecycleScenario,
  classifyCredentialLifecycle,
  classifyHostileAmbient,
  type HostileAmbientFacts,
  type SubscriptionCanaryEvidence,
  type SubscriptionCanaryOutcome,
  type SubscriptionCanaryResult,
  toMarkdownTable,
} from "./canaries.js";
export { escapeMarkdownTableCell, renderEnvironmentDiff } from "./environment-diff.js";
export { readSubscriptionSmokeConfig, type SubscriptionSmokeConfig } from "./gate.js";
export {
  classifyRawDiagnostic,
  type DiagnosticRunnerFn,
  type ProbeOptions,
  type ProbeResult,
  probeBillingRoute,
  probeClaudeBillingRoute,
  probeCodexBillingRoute,
  type RawDiagnosticResult,
} from "./probe.js";
export {
  buildIsolatedEnvironment,
  ISOLATED_PATH,
  type IsolatedEnvironment,
  type IsolationRequest,
  IsolationViolationError,
  type SubscriptionEngine,
  VARIABLE_POLICY,
  type VariableDecision,
  type VariableOutcome,
  type VariablePolicy,
} from "./variables.js";
