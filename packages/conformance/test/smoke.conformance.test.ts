import { describe, it } from "vitest";
import { describeExecutionBackendConformance } from "../src/runner/vitest.js";
import { createSmokeExecutionHarness } from "../src/smoke/harness.js";

// Opt-in, no-network, no-op by default (X1/X2): unless HENIEK_CONFORMANCE_SMOKE=1
// and HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE are set, createSmokeExecutionHarness()
// resolves to null and this file contributes an explicit, attributable skip
// rather than silently passing.
const harness = await createSmokeExecutionHarness();

if (harness !== null) {
  describeExecutionBackendConformance(harness);
} else {
  describe.skip("smoke:execution-backend [opt-in: set HENIEK_CONFORMANCE_SMOKE=1 and HENIEK_CONFORMANCE_SMOKE_AUTH_ROUTE]", () => {
    it("is skipped unless explicitly enabled", () => {
      // Intentionally empty.
    });
  });
}
