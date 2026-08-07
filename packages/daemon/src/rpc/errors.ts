/**
 * The wire message for the drain-rejection response, paired with
 * `ERROR_CODES.draining` (`./codec.js`). `daemon.hello` is exempt from this
 * rejection (design C9) — `src/rpc/dispatch.ts` answers it before this
 * message is ever reached.
 */
export const DRAINING_MESSAGE = "draining";
