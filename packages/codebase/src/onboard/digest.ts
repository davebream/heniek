import type { CodebaseOnboardingProposal } from "@heniek/contracts";
import type { HashPort } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively sorts object keys for stable digests. */
export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/** Proposal body hashed for `digest` — every field except `digest` itself. */
export type ProposalDigestBody = Omit<CodebaseOnboardingProposal, "digest">;

export function proposalDigestBody(
  proposal: ProposalDigestBody | CodebaseOnboardingProposal,
): ProposalDigestBody {
  const { digest: _digest, ...body } = proposal as CodebaseOnboardingProposal;
  return body;
}

export function digestProposal(
  hash: HashPort,
  proposal: ProposalDigestBody | CodebaseOnboardingProposal,
): string {
  return hash.sha256(canonicalJson(proposalDigestBody(proposal)));
}
