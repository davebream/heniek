import type {
  CheckFailureV1,
  CheckStatusV1,
  ForgeBackend,
  PullRequestId,
  PullRequestV1,
} from "@heniek/contracts";
import { CreatePullRequestInputV1 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import type { ForgeArrangement } from "../contract/arrangement.js";
import { ConformanceFaultError, isConformanceFaultError } from "../contract/fault.js";
import type { ForgeBackendHarness } from "../contract/harness.js";
import { assertValid } from "../contract/validation.js";
import type { ConformanceContext } from "../kernel/context.js";
import { createFaultProgramme, type FaultProgramme } from "./fault-programme.js";

type PullRequest = Static<typeof PullRequestV1>;
type CheckStatus = Static<typeof CheckStatusV1>;
type CheckFailure = Static<typeof CheckFailureV1>;
type CreatePullRequestInput = Static<typeof CreatePullRequestInputV1>;

function isRetryable(fault: string): boolean {
  return fault === "disconnect" || fault === "rate_limit";
}

interface ForgePullRequestRecord {
  readonly pullRequestId: PullRequestId;
  readonly repositoryId: CreatePullRequestInput["repositoryId"];
  readonly number: number;
  readonly url: string;
  draft: boolean;
  readonly headSha: string;
  readonly staleHead: boolean;
  autoMergeEnabled: boolean;
  checks: CheckStatus[];
  readonly faultProgramme: FaultProgramme;
}

export interface FakeForgeBackend {
  readonly backend: ForgeBackend;
  /** Arranges the behaviour of the next PR to be created. */
  arrange(arrangement: ForgeArrangement): void;
}

export function createFakeForgeBackend(context: ConformanceContext): FakeForgeBackend {
  const pullRequests = new Map<string, ForgePullRequestRecord>();
  let pendingArrangement: ForgeArrangement | undefined;
  let nextNumber = 1;

  function requirePr(id: PullRequestId, action: string): ForgePullRequestRecord {
    const pr = pullRequests.get(id);
    if (pr === undefined) {
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: "forge-backend",
        action,
        outcome: "fault",
        detail: { pullRequestId: id, fault: "stale_ref" },
      });
      throw new ConformanceFaultError("stale_ref", false, `unknown pull request id: ${id}`);
    }
    return pr;
  }

  const backend: ForgeBackend = {
    async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
      assertValid(CreatePullRequestInputV1, input, "CreatePullRequestInputV1");
      const arrangement = pendingArrangement;
      pendingArrangement = undefined;

      const id = context.ids.next("conformance-pull-request") as PullRequestId;
      const number = nextNumber;
      nextNumber += 1;

      const checks: CheckStatus[] =
        arrangement?.kind === "checks"
          ? arrangement.states.map((state, index) => ({
              schemaVersion: 1,
              name: `conformance-check-${index + 1}`,
              state,
              required: true,
            }))
          : [];

      const record: ForgePullRequestRecord = {
        pullRequestId: id,
        repositoryId: input.repositoryId,
        number,
        url: `https://forge.invalid/${input.repositoryId}/pull/${number}`,
        draft: input.draft,
        headSha: context.ids.next("conformance-sha"),
        staleHead: arrangement?.kind === "stale-head",
        autoMergeEnabled: false,
        checks,
        faultProgramme: createFaultProgramme(
          arrangement?.kind === "injects-fault"
            ? [{ fault: arrangement.fault, occurrences: arrangement.occurrences }]
            : [],
        ),
      };
      pullRequests.set(id, record);

      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: "forge-backend",
        action: "createPullRequest",
        outcome: "ok",
        detail: { pullRequestId: id },
      });

      return {
        schemaVersion: 1,
        pullRequestId: record.pullRequestId,
        repositoryId: record.repositoryId,
        number: record.number,
        url: record.url,
        state: "open",
        draft: record.draft,
        headSha: record.headSha,
      };
    },

    async markReady(id: PullRequestId): Promise<void> {
      const pr = requirePr(id, "markReady");
      pr.draft = false;
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: "forge-backend",
        action: "markReady",
        outcome: "ok",
        detail: { pullRequestId: id },
      });
    },

    async getChecks(id: PullRequestId): Promise<CheckStatus[]> {
      const pr = requirePr(id, "getChecks");
      const fault = pr.faultProgramme.consume();
      if (fault !== undefined) {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: "forge-backend",
          action: "getChecks",
          outcome: "fault",
          detail: { pullRequestId: id, fault },
        });
        throw new ConformanceFaultError(fault, isRetryable(fault));
      }
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: "forge-backend",
        action: "getChecks",
        outcome: "ok",
        detail: { pullRequestId: id, count: pr.checks.length },
      });
      return [...pr.checks];
    },

    async getFailedCheckLogs(id: PullRequestId): Promise<CheckFailure[]> {
      const pr = requirePr(id, "getFailedCheckLogs");
      const failures = pr.checks
        .filter((check) => check.state === "failed")
        .map((check) => ({
          schemaVersion: 1 as const,
          name: check.name,
          summary: `${check.name} failed.`,
          logExcerpt: "conformance harness failure log excerpt",
        }));
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: "forge-backend",
        action: "getFailedCheckLogs",
        outcome: "ok",
        detail: { pullRequestId: id, count: failures.length },
      });
      return failures;
    },

    async enableAutoMerge(id: PullRequestId): Promise<void> {
      const pr = requirePr(id, "enableAutoMerge");
      const fault = pr.faultProgramme.consume();
      if (fault !== undefined) {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: "forge-backend",
          action: "enableAutoMerge",
          outcome: "fault",
          detail: { pullRequestId: id, fault },
        });
        throw new ConformanceFaultError(fault, isRetryable(fault));
      }
      if (pr.draft) {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: "forge-backend",
          action: "enableAutoMerge",
          outcome: "fault",
          detail: { pullRequestId: id, fault: "conflict" },
        });
        throw new ConformanceFaultError(
          "conflict",
          false,
          "cannot enable auto-merge on a draft PR",
        );
      }
      if (pr.staleHead) {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: "forge-backend",
          action: "enableAutoMerge",
          outcome: "fault",
          detail: { pullRequestId: id, fault: "conflict" },
        });
        throw new ConformanceFaultError("conflict", false, "head sha is stale");
      }
      pr.autoMergeEnabled = true;
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: "forge-backend",
        action: "enableAutoMerge",
        outcome: "ok",
        detail: { pullRequestId: id },
      });
    },
  };

  return {
    backend,
    arrange(arrangement: ForgeArrangement): void {
      pendingArrangement = arrangement;
    },
  };
}

/**
 * Every capability the forge-backend case catalogue actually requires (see
 * the equivalent note in `fakes/execution-backend.ts`).
 */
export const FAKE_FORGE_BACKEND_CAPABILITIES = [
  "lifecycle",
  "fault-conflict",
  "fault-stale-ref",
  "fault-disconnect",
  "fault-rate-limit",
] as const;

export function createFakeForgeBackendHarness(): ForgeBackendHarness {
  return {
    name: "fake-forge-backend",
    capabilities: FAKE_FORGE_BACKEND_CAPABILITIES,
    classifyFault: (error: unknown) => (isConformanceFaultError(error) ? error.kind : "unknown"),
    async createSubject(context: ConformanceContext) {
      const fake = createFakeForgeBackend(context);
      return {
        subject: fake.backend,
        async arrange(arrangement: ForgeArrangement): Promise<void> {
          fake.arrange(arrangement);
        },
        async dispose(): Promise<void> {
          // Nothing to release: fully in-memory.
        },
      };
    },
  };
}
