import type {
  CapabilityCatalogueV1,
  DoctorReportV1,
  DoctorReportV2,
  ExecutionBackendDiagnosticV1,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";

type DoctorReport = Static<typeof DoctorReportV2>;
type DoctorCheck = Static<typeof ExecutionBackendDiagnosticV1>;
type CapabilityCatalogue = Static<typeof CapabilityCatalogueV1>;
type LegacyDoctorReport = Static<typeof DoctorReportV1>;

export function doctorHealthFromChecks(checks: readonly DoctorCheck[]): DoctorReport["health"] {
  if (checks.some((check) => check.readState === "ok" && check.verdict === "fail")) {
    return "failed";
  }
  if (checks.some((check) => check.readState === "not-read" || check.readState === "failed")) {
    return "unknown";
  }
  if (checks.some((check) => check.readState === "ok" && check.verdict === "warn")) {
    return "degraded";
  }
  return "healthy";
}

export function adaptDoctorReportV2ToV1(report: DoctorReport): LegacyDoctorReport {
  const checks: LegacyDoctorReport["checks"] = report.checks.map((check) => {
    const base = {
      category: check.category,
      code: check.code,
      message: check.message,
      ...(check.remediation === undefined ? {} : { remediation: check.remediation }),
    };
    if (check.readState === "ok") {
      return { ...base, status: check.verdict };
    }
    // Unread and read-failed checks must not become false `failed` reports.
    return { ...base, status: "warn" as const };
  });
  const health = checks.some((check) => check.status === "fail")
    ? "failed"
    : checks.some((check) => check.status === "warn")
      ? "degraded"
      : "healthy";
  return { schemaVersion: 1, health, checks };
}

function facetCheck(
  category: DoctorCheck["category"],
  facet: string,
  codeSuffix: string,
  label: string,
  positive: string,
  unknownValue: string,
): DoctorCheck {
  if (facet === positive) {
    return {
      category,
      readState: "ok",
      verdict: "pass",
      code: codeSuffix,
      message: `${label} is ${facet}.`,
    };
  }
  if (facet === unknownValue) {
    return {
      category,
      readState: "not-read",
      code: codeSuffix,
      message: `${label} is ${facet}.`,
    };
  }
  return {
    category,
    readState: "ok",
    verdict: "fail",
    code: codeSuffix,
    message: `${label} is ${facet}.`,
  };
}

export function appendCapabilityDoctorChecks(
  base: DoctorReport,
  catalogue: CapabilityCatalogue,
): DoctorReport {
  const checks = [...base.checks];
  for (const entry of catalogue.entries) {
    const label = `${entry.engine}${entry.accountId === null ? "" : `/${entry.accountId}`}`;
    const engine = entry.engine.toUpperCase();
    checks.push(
      facetCheck(
        "runtime",
        entry.installation,
        `ENGINE_${engine}_RUNTIME_${entry.installation.replace("-", "_").toUpperCase()}`,
        `${label} runtime`,
        "installed",
        "unknown",
      ),
      facetCheck(
        "auth-route",
        entry.authentication,
        `ENGINE_${engine}_AUTH_${entry.authentication.toUpperCase()}`,
        `${label} authentication`,
        "authenticated",
        "unknown",
      ),
      facetCheck(
        "compatibility",
        entry.compatibility,
        `ENGINE_${engine}_COMPATIBILITY_${entry.compatibility.toUpperCase()}`,
        `${label} compatibility`,
        "compatible",
        "unknown",
      ),
    );
    if (entry.ready) {
      checks.push({
        category: "runtime",
        readState: "ok",
        verdict: "pass",
        code: `ENGINE_${engine}_READINESS_READY`,
        message: `${label} is ready; capacity is ${entry.capacity}.`,
      });
    } else if (
      entry.capacity === "unknown" &&
      entry.configured &&
      entry.installation === "installed" &&
      entry.authentication === "authenticated" &&
      entry.compatibility === "compatible"
    ) {
      checks.push({
        category: "runtime",
        readState: "not-read",
        code: `ENGINE_${engine}_READINESS_BLOCKED`,
        message: `${label} is not ready; capacity is ${entry.capacity}.`,
      });
    } else {
      checks.push({
        category: "runtime",
        readState: "ok",
        verdict: "fail",
        code: `ENGINE_${engine}_READINESS_${entry.capacity === "rate-limited" ? "RATE_LIMITED" : "BLOCKED"}`,
        message: `${label} is not ready; capacity is ${entry.capacity}.`,
      });
    }
  }
  return { schemaVersion: 2, health: doctorHealthFromChecks(checks), checks };
}
