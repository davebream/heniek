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
export { renderEnvironmentDiff } from "./environment-diff.js";
export { readSubscriptionSmokeConfig, type SubscriptionSmokeConfig } from "./gate.js";
export {
  type ProbeResult,
  probeClaudeBillingRoute,
  probeCodexBillingRoute,
} from "./probe.js";
export {
  buildIsolatedEnvironment,
  type IsolatedEnvironment,
  type IsolationRequest,
  IsolationViolationError,
  type SubscriptionEngine,
  VARIABLE_POLICY,
  type VariableDecision,
  type VariableOutcome,
  type VariablePolicy,
} from "./variables.js";
