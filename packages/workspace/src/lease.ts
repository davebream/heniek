import type { WorkspaceWriterLease } from "@heniek/contracts";
import { WorkspaceError } from "./errors.js";
import type { WorkspaceStateStore } from "./state.js";
import type {
  AcquireWriterLeaseInput,
  LeaseOwner,
  OwnerLiveness,
  WorkspaceLeaseService,
} from "./types.js";

export interface LeaseClock {
  nowIso(): string;
}

export interface LeaseIdSource {
  next(prefix: string): string;
}

export interface CreateWorkspaceLeaseServiceInput {
  readonly state: WorkspaceStateStore;
  readonly clock: LeaseClock;
  readonly ids: LeaseIdSource;
  readonly liveness: OwnerLiveness;
}

function plusMilliseconds(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function sameOwner(lease: WorkspaceWriterLease, input: AcquireWriterLeaseInput): boolean {
  return lease.ownerId === input.ownerId && lease.workspaceId === input.workspaceId;
}

export function createWorkspaceLeaseService(
  deps: CreateWorkspaceLeaseServiceInput,
): WorkspaceLeaseService {
  function record(
    type: Parameters<WorkspaceStateStore["recordLease"]>[0],
    lease: WorkspaceWriterLease,
  ): WorkspaceWriterLease {
    deps.state.recordLease(type, lease);
    const stored = deps.state.lease(lease.checkoutPath);
    if (stored === undefined)
      throw new WorkspaceError("LEASE_NOT_CURRENT", "Lease was not stored.");
    return stored;
  }

  function assertIdentity(current: WorkspaceWriterLease | undefined, lease: WorkspaceWriterLease) {
    if (
      current === undefined ||
      current.state !== "active" ||
      Date.parse(current.expiresAt) <= Date.parse(deps.clock.nowIso()) ||
      current.leaseId !== lease.leaseId ||
      current.ownerId !== lease.ownerId ||
      current.fencingRevision !== lease.fencingRevision
    ) {
      throw new WorkspaceError("LEASE_NOT_CURRENT", "Writer lease is no longer current.");
    }
    return current;
  }

  return {
    acquire(input) {
      if (input.ttlMilliseconds < 1) {
        throw new WorkspaceError("INVALID_CONFIGURATION", "Lease TTL must be positive.");
      }
      const now = deps.clock.nowIso();
      const previous = deps.state.lease(input.checkoutPath);
      if (previous !== undefined && previous.state !== "released") {
        const sameOwnerRecovery =
          previous.state === "recovery-required" &&
          sameOwner(previous, input) &&
          previous.expectedSha === input.expectedSha;
        if (
          previous.state === "active" &&
          Date.parse(previous.expiresAt) > Date.parse(now) &&
          sameOwner(previous, input) &&
          previous.expectedSha === input.expectedSha
        ) {
          return previous;
        }
        if (!sameOwnerRecovery && Date.parse(previous.expiresAt) > Date.parse(now)) {
          throw new WorkspaceError(
            "LEASE_CONTENDED",
            "Checkout already has a live writer lease.",
            true,
          );
        }
        for (const witness of sameOwnerRecovery ? [] : previous.processWitnesses) {
          const state = deps.liveness.witnessState(previous.bootWitness, witness);
          if (state === "alive") {
            throw new WorkspaceError(
              "LEASE_OWNER_ALIVE",
              "Expired lease owner is still alive.",
              true,
            );
          }
          if (state === "unknown") {
            throw new WorkspaceError(
              "LEASE_OWNER_UNKNOWN",
              "Expired lease owner liveness cannot be proven.",
              true,
            );
          }
        }
      }
      const recovered = previous !== undefined;
      const lease: WorkspaceWriterLease = {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        checkoutPath: input.checkoutPath,
        leaseId: deps.ids.next("lease"),
        ownerId: input.ownerId,
        bootWitness: input.bootWitness,
        processWitnesses: [...input.processWitnesses],
        expectedSha: input.expectedSha,
        fencingRevision: (previous?.fencingRevision ?? 0) + 1,
        state: "active",
        acquiredAt: now,
        renewedAt: now,
        expiresAt: plusMilliseconds(now, input.ttlMilliseconds),
        releasedAt: null,
      };
      return record(recovered ? "workspace.lease_recovered" : "workspace.lease_acquired", lease);
    },
    renew(lease, ttlMilliseconds, owner?: LeaseOwner) {
      const current = assertIdentity(deps.state.lease(lease.checkoutPath), lease);
      const now = deps.clock.nowIso();
      return record("workspace.lease_renewed", {
        ...current,
        ...(owner === undefined
          ? {}
          : {
              ownerId: owner.ownerId,
              bootWitness: owner.bootWitness,
              processWitnesses: [...owner.processWitnesses],
            }),
        renewedAt: now,
        expiresAt: plusMilliseconds(now, ttlMilliseconds),
      });
    },
    assertCurrent(lease, actualSha) {
      const current = assertIdentity(deps.state.lease(lease.checkoutPath), lease);
      if (current.expectedSha !== actualSha) {
        throw new WorkspaceError(
          "CHECKOUT_CHANGED",
          "Checkout HEAD no longer matches the lease expected SHA.",
        );
      }
    },
    advanceExpectedSha(lease, nextSha) {
      const current = assertIdentity(deps.state.lease(lease.checkoutPath), lease);
      return record("workspace.lease_expected_sha_advanced", { ...current, expectedSha: nextSha });
    },
    release(lease) {
      const current = assertIdentity(deps.state.lease(lease.checkoutPath), lease);
      const now = deps.clock.nowIso();
      return record("workspace.lease_released", {
        ...current,
        state: "released",
        releasedAt: now,
        renewedAt: now,
        expiresAt: now,
      });
    },
    markRecoveryRequired(lease) {
      const current = assertIdentity(deps.state.lease(lease.checkoutPath), lease);
      return record("workspace.lease_recovery_required", {
        ...current,
        state: "recovery-required",
      });
    },
  };
}
