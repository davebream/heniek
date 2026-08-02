/**
 * The recovery-pass fatal error (design C12's Error Handling section, plan
 * Task 4 Step 8).
 *
 * `../lifecycle/errors.ts` deliberately carries no exit-12 class — its own
 * docblock names exit 12 (recovery failure) as "Task 4's concern". A
 * `RecoveryFailedError` is thrown for exactly the two failures the design
 * calls fatal: the owned state database failing to open or migrate, or
 * artifact recovery failing (constructing the store or running its sweep).
 * Both leave the daemon unable to serve over reconciled state, and because
 * this always happens before the socket is bound (`reconcile()` runs
 * entirely in `recovering`), no client can ever have observed the failed
 * instance. The caller releases the claim before throwing this — see
 * `reconcile.ts`.
 *
 * A claim lost *during* the pass (`assertStillHeld()`'s `ClaimLostError`) is
 * a different failure mode and is never wrapped here — see `reconcile.ts`'s
 * docblock for why.
 */
export class RecoveryFailedError extends Error {
  readonly exitCode = 12 as const;

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RecoveryFailedError";
  }
}
