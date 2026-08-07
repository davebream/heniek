import type { CapabilityCatalogueV1, DoctorReportV1 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";

type DoctorReport = Static<typeof DoctorReportV1>;
type CapabilityCatalogue = Static<typeof CapabilityCatalogueV1>;

export function appendCapabilityDoctorChecks(
  base: DoctorReport,
  catalogue: CapabilityCatalogue,
): DoctorReport {
  const checks = [...base.checks];
  for (const entry of catalogue.entries) {
    const label = `${entry.engine}${entry.accountId === null ? "" : `/${entry.accountId}`}`;
    checks.push(
      {
        category: "runtime",
        status:
          entry.installation === "installed"
            ? "pass"
            : entry.installation === "unknown"
              ? "warn"
              : "fail",
        code: `ENGINE_${entry.engine.toUpperCase()}_RUNTIME_${entry.installation.replace("-", "_").toUpperCase()}`,
        message: `${label} runtime is ${entry.installation}.`,
      },
      {
        category: "auth-route",
        status:
          entry.authentication === "authenticated"
            ? "pass"
            : entry.authentication === "unknown"
              ? "warn"
              : "fail",
        code: `ENGINE_${entry.engine.toUpperCase()}_AUTH_${entry.authentication.toUpperCase()}`,
        message: `${label} authentication is ${entry.authentication}.`,
      },
      {
        category: "compatibility",
        status:
          entry.compatibility === "compatible"
            ? "pass"
            : entry.compatibility === "unknown"
              ? "warn"
              : "fail",
        code: `ENGINE_${entry.engine.toUpperCase()}_COMPATIBILITY_${entry.compatibility.toUpperCase()}`,
        message: `${label} compatibility is ${entry.compatibility}.`,
      },
      {
        category: "runtime",
        status: entry.ready
          ? "pass"
          : entry.capacity === "unknown" &&
              entry.configured &&
              entry.installation === "installed" &&
              entry.authentication === "authenticated" &&
              entry.compatibility === "compatible"
            ? "warn"
            : "fail",
        code: `ENGINE_${entry.engine.toUpperCase()}_READINESS_${entry.ready ? "READY" : entry.capacity === "rate-limited" ? "RATE_LIMITED" : "BLOCKED"}`,
        message: `${label} is ${entry.ready ? "ready" : "not ready"}; capacity is ${entry.capacity}.`,
      },
    );
  }
  const health = checks.some((check) => check.status === "fail")
    ? "failed"
    : checks.some((check) => check.status === "warn")
      ? "degraded"
      : "healthy";
  return { schemaVersion: 1, health, checks };
}
