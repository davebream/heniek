/**
 * The wire message every authentication failure emits — paired with
 * `ERROR_CODES.unauthorized` (`src/rpc/codec.ts`) to produce a byte-identical
 * response for a real method and a fabricated one alike (design C6/C8,
 * STD-9). `src/rpc/dispatch.ts` is the only caller; the message never
 * varies, and no `data` field is ever attached alongside it.
 */
export const UNAUTHORIZED_MESSAGE = "unauthorized";
