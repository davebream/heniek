/**
 * The claim-record grammar (design C3) — a tab-separated, LF-terminated,
 * fixed-arity line living at `runtime/daemon.pid`:
 *
 *   heniek-daemon\t<recordVersion>\t<state>\t<pid>\t<bootWitness>\t<instanceId>\n
 *
 * Pure `parseClaimRecord`/`serialiseClaimRecord` — no I/O, no `Date`, no
 * `randomUUID`. A text record rather than JSON is deliberate (design C3): it
 * makes "complete iff LF-terminated" a one-byte check, which is exactly the
 * property the torn-write rule needs — a partial `writeSync` (the only way
 * this file is ever written; see `lifecycle/acquire.ts`) cannot land a
 * trailing LF by accident.
 *
 * `malformed` and `claim-in-progress` are DIFFERENT verdicts driving
 * different branches of `acquire.ts`'s contended-path classification
 * (design C1 step 6): a missing trailing LF always means "the writer has
 * not finished" — never "stale", never "malformed" — because a zero-length
 * or unterminated file is indistinguishable from a torn write in progress.
 * Treating it as stale would let two cold starts each take over the other,
 * yielding zero daemons. A *complete* record with a wrong magic, wrong
 * arity, an unknown `state`, a non-integer or out-of-range `pid`, or a byte
 * length over 1 KiB is instead genuinely malformed.
 */

/** The two record states this grammar names (design C3). */
export type ClaimState = "claiming" | "serving";

/** The record version every writer in this package emits (design C3). */
export const CLAIM_RECORD_VERSION = 1;

export interface ClaimRecord {
  readonly recordVersion: number;
  readonly state: ClaimState;
  /** `[1, 2^31)` — `kill(0, …)` targets the whole process group, so a planted `pid: 0` must never parse. */
  readonly pid: number;
  /** `undefined` when the writer's platform could not obtain a boot witness (encoded on disk as `-`). */
  readonly bootWitness: string | undefined;
  readonly instanceId: string;
}

export type ParsedClaimRecord =
  | { readonly kind: "well-formed"; readonly record: ClaimRecord }
  | { readonly kind: "claim-in-progress" }
  | { readonly kind: "malformed"; readonly reason: string };

const MAGIC = "heniek-daemon";
const FIELD_COUNT = 6;

/**
 * The `state` field is written **space-padded to a fixed width** so publish
 * can rewrite it in place through the held fd (design C1 step 8 / plan
 * round-2 override 3) instead of `rename`ing a new inode onto
 * `daemon.pid` — a rename would install a different inode and break
 * `assertStillHeld()` on the first client connection. A variable-width
 * field would make the record change length on the `claiming → serving`
 * transition, which an in-place positional write cannot express.
 *
 * 8 = `"claiming".length`, the longer of the two legal states.
 */
const STATE_FIELD_WIDTH = 8;
const WITNESS_UNOBTAINABLE = "-";
const PID_MIN = 1;
const PID_MAX_EXCLUSIVE = 2 ** 31;
const PID_PATTERN = /^[0-9]+$/;
const RECORD_VERSION_PATTERN = /^[0-9]+$/;

/**
 * The claim-record hard byte cap (design C1 step 6: "a hard 1 KiB cap
 * checked … before reading"). Enforced here too, independently of
 * `LockFileSystem.readFile`'s caller-side `maxBytes` argument, so the
 * grammar is closed on its own terms and directly testable.
 */
export const MAX_CLAIM_RECORD_BYTES = 1024;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The exact bytes the `state` field occupies on disk — the state name
 * right-padded with spaces to `STATE_FIELD_WIDTH`. Publish writes precisely
 * this string at `claimStateFieldOffset()`, so the record length is
 * invariant across the `claiming → serving` transition.
 */
export function serialiseClaimState(state: ClaimState): string {
  return state.padEnd(STATE_FIELD_WIDTH, " ");
}

/**
 * Byte offset of the `state` field within a serialised record — the two
 * preceding fixed fields (`magic`, `recordVersion`) plus their tabs. Both
 * are ASCII, so byte offset and code-unit offset coincide; the function
 * still measures bytes because `ClaimFileHandle.writeAt` is positional in
 * bytes.
 */
export function claimStateFieldOffset(recordVersion: number): number {
  return byteLength(`${MAGIC}\t${recordVersion}\t`);
}

/**
 * Parses one claim-record line per the closed grammar above. Field order,
 * checked in this order deliberately:
 *
 * 1. The 1 KiB byte cap — a hard wall, independent of termination or
 *    content.
 * 2. LF-termination — a one-byte check; anything unterminated is
 *    `claim-in-progress`, full stop, regardless of what the rest of the
 *    bytes look like.
 * 3. Only once both of those pass: arity, magic, record version, `state`,
 *    `pid` range, each mapping an unrecognised value to `malformed`.
 */
export function parseClaimRecord(raw: string): ParsedClaimRecord {
  const size = byteLength(raw);
  if (size > MAX_CLAIM_RECORD_BYTES) {
    return {
      kind: "malformed",
      reason: `record is ${size} bytes, exceeding the ${MAX_CLAIM_RECORD_BYTES}-byte cap`,
    };
  }

  if (!raw.endsWith("\n")) {
    return { kind: "claim-in-progress" };
  }

  const fields = raw.slice(0, -1).split("\t");
  if (fields.length !== FIELD_COUNT) {
    return {
      kind: "malformed",
      reason: `expected ${FIELD_COUNT} tab-separated fields, got ${fields.length}`,
    };
  }
  const [magic, recordVersionField, stateField, pidField, bootWitnessField, instanceId] =
    fields as [string, string, string, string, string, string];

  if (magic !== MAGIC) {
    return { kind: "malformed", reason: `wrong magic: ${JSON.stringify(magic)}` };
  }

  if (!RECORD_VERSION_PATTERN.test(recordVersionField)) {
    return {
      kind: "malformed",
      reason: `non-integer record version: ${JSON.stringify(recordVersionField)}`,
    };
  }
  const recordVersion = Number(recordVersionField);

  // The field is written space-padded to a fixed width (see
  // `STATE_FIELD_WIDTH`); the padding is not part of the state name.
  const stateName = stateField.trimEnd();
  if (stateName !== "claiming" && stateName !== "serving") {
    return { kind: "malformed", reason: `unknown state: ${JSON.stringify(stateField)}` };
  }
  const state: ClaimState = stateName;

  if (!PID_PATTERN.test(pidField)) {
    return { kind: "malformed", reason: `non-integer pid: ${JSON.stringify(pidField)}` };
  }
  const pid = Number(pidField);
  if (pid < PID_MIN || pid >= PID_MAX_EXCLUSIVE) {
    return {
      kind: "malformed",
      reason: `pid out of range [${PID_MIN}, ${PID_MAX_EXCLUSIVE}): ${pid}`,
    };
  }

  const bootWitness = bootWitnessField === WITNESS_UNOBTAINABLE ? undefined : bootWitnessField;

  return { kind: "well-formed", record: { recordVersion, state, pid, bootWitness, instanceId } };
}

/**
 * Serialises one complete, LF-terminated record — the only shape this
 * module ever produces. `acquire.ts` writes the result in a single
 * `writeSync` call; there is deliberately no incremental/streaming writer,
 * because a partial write is exactly the "unterminated ⇒ claim-in-progress"
 * case this grammar exists to make detectable.
 */
export function serialiseClaimRecord(record: ClaimRecord): string {
  if (!Number.isInteger(record.pid) || record.pid < PID_MIN || record.pid >= PID_MAX_EXCLUSIVE) {
    throw new RangeError(
      `claim record pid out of range [${PID_MIN}, ${PID_MAX_EXCLUSIVE}): ${record.pid}`,
    );
  }
  const witnessField = record.bootWitness ?? WITNESS_UNOBTAINABLE;
  const line =
    `${MAGIC}\t${record.recordVersion}\t${serialiseClaimState(record.state)}\t${record.pid}\t` +
    `${witnessField}\t${record.instanceId}\n`;
  if (byteLength(line) > MAX_CLAIM_RECORD_BYTES) {
    throw new RangeError(`serialised claim record exceeds the ${MAX_CLAIM_RECORD_BYTES}-byte cap`);
  }
  return line;
}
