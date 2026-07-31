import { isConformanceFaultError } from "../contract/fault.js";
import type { ExecutionBackendHarness } from "../contract/harness.js";
import { readSmokeConfig } from "./env.js";
import {
  createSubprocessExecutionBackendSubject,
  SMOKE_SUBPROCESS_CAPABILITIES,
} from "./subprocess-execution-backend.js";

/** The shape an external, env-selected adapter module must export (C2/X3/X4). */
export interface SmokeAdapterModule {
  createExecutionBackendHarness(): ExecutionBackendHarness | Promise<ExecutionBackendHarness>;
}

/**
 * Builds the opt-in execution-backend smoke harness (design §6). Returns
 * `null` when disabled — `HENIEK_CONFORMANCE_SMOKE` unset is the CI default
 * (X1). When `HENIEK_CONFORMANCE_SMOKE_MODULE` names an external adapter, it
 * is dynamically imported and must export `createExecutionBackendHarness()`;
 * this is the slot a real provider adapter plugs into from outside this
 * repository. Otherwise the bundled subprocess adapter is used — real
 * process spawn, real stream framing, real SIGTERM cancellation, no network,
 * no credentials (auth route `none`).
 */
export async function createSmokeExecutionHarness(): Promise<ExecutionBackendHarness | null> {
  const config = readSmokeConfig();
  if (!config.enabled) {
    return null;
  }

  if (config.moduleSpecifier !== undefined) {
    const moduleSpecifier = config.moduleSpecifier;
    const imported = (await import(moduleSpecifier)) as Partial<SmokeAdapterModule>;
    if (typeof imported.createExecutionBackendHarness !== "function") {
      throw new Error(
        `Smoke adapter module "${moduleSpecifier}" does not export createExecutionBackendHarness().`,
      );
    }
    const external = await imported.createExecutionBackendHarness();
    // C2 requires the adapter to "clearly report" its auth route. The
    // external module's own harness.name says nothing about the route this
    // repository resolved and validated (readSmokeConfig() above) — without
    // this wrap, the validated auth route was silently discarded on the one
    // path that could ever report anything other than "none" (NEW-4).
    return { ...external, name: `${external.name} (auth-route=${config.authRoute})` };
  }

  return {
    name: `smoke:subprocess (auth-route=${config.authRoute})`,
    capabilities: SMOKE_SUBPROCESS_CAPABILITIES,
    classifyFault: (error: unknown) => (isConformanceFaultError(error) ? error.kind : "unknown"),
    async createSubject(context) {
      return createSubprocessExecutionBackendSubject(context);
    },
  };
}
