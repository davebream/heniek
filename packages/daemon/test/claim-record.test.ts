/**
 * The closed claim-record grammar (design C3, plan Task 2 Step 2).
 */

import { describe, expect, it } from "vitest";
import {
  type ClaimRecord,
  MAX_CLAIM_RECORD_BYTES,
  parseClaimRecord,
  serialiseClaimRecord,
} from "../src/lifecycle/claim-record.js";

const RECORD: ClaimRecord = {
  recordVersion: 1,
  state: "claiming",
  pid: 4242,
  bootWitness: "boot-witness-abc",
  instanceId: "instance-abc",
};

describe("serialiseClaimRecord / parseClaimRecord round-trip", () => {
  it("serialises the exact tab-separated, LF-terminated line", () => {
    const line = serialiseClaimRecord(RECORD);
    expect(line).toBe("heniek-daemon\t1\tclaiming\t4242\tboot-witness-abc\tinstance-abc\n");
  });

  it("round-trips a claiming record", () => {
    const line = serialiseClaimRecord(RECORD);
    const parsed = parseClaimRecord(line);
    expect(parsed).toEqual({ kind: "well-formed", record: RECORD });
  });

  it("round-trips a serving record", () => {
    const record: ClaimRecord = { ...RECORD, state: "serving" };
    const parsed = parseClaimRecord(serialiseClaimRecord(record));
    expect(parsed).toEqual({ kind: "well-formed", record });
  });

  it("encodes an unobtainable boot witness as '-' and decodes it back to undefined", () => {
    const record: ClaimRecord = { ...RECORD, bootWitness: undefined };
    const line = serialiseClaimRecord(record);
    expect(line).toBe("heniek-daemon\t1\tclaiming\t4242\t-\tinstance-abc\n");
    expect(parseClaimRecord(line)).toEqual({ kind: "well-formed", record });
  });
});

describe("parseClaimRecord — the missing-trailing-LF verdict is claim-in-progress, never stale or malformed", () => {
  it("a record with no trailing LF parses as claim-in-progress", () => {
    const line = serialiseClaimRecord(RECORD).slice(0, -1);
    expect(parseClaimRecord(line)).toEqual({ kind: "claim-in-progress" });
  });

  it("a zero-length record parses as claim-in-progress", () => {
    expect(parseClaimRecord("")).toEqual({ kind: "claim-in-progress" });
  });

  it("garbage content with no trailing LF still parses as claim-in-progress, not malformed", () => {
    expect(parseClaimRecord("not even close to the grammar")).toEqual({
      kind: "claim-in-progress",
    });
  });
});

describe("parseClaimRecord — malformed content (LF-terminated but otherwise invalid)", () => {
  it("wrong magic", () => {
    const parsed = parseClaimRecord("not-heniek-daemon\t1\tclaiming\t1\tw\ti\n");
    expect(parsed.kind).toBe("malformed");
  });

  it("wrong arity (too few fields)", () => {
    const parsed = parseClaimRecord("heniek-daemon\t1\tclaiming\t1\tw\n");
    expect(parsed.kind).toBe("malformed");
  });

  it("wrong arity (too many fields)", () => {
    const parsed = parseClaimRecord("heniek-daemon\t1\tclaiming\t1\tw\ti\textra\n");
    expect(parsed.kind).toBe("malformed");
  });

  it("unknown state", () => {
    const parsed = parseClaimRecord("heniek-daemon\t1\tunknown-state\t1\tw\ti\n");
    expect(parsed.kind).toBe("malformed");
  });

  it("non-integer pid", () => {
    const parsed = parseClaimRecord("heniek-daemon\t1\tclaiming\tabc\tw\ti\n");
    expect(parsed.kind).toBe("malformed");
  });

  it("pid: 0 — kill(0, …) would target the whole process group", () => {
    const parsed = parseClaimRecord("heniek-daemon\t1\tclaiming\t0\tw\ti\n");
    expect(parsed.kind).toBe("malformed");
  });

  it("pid: -1", () => {
    const parsed = parseClaimRecord("heniek-daemon\t1\tclaiming\t-1\tw\ti\n");
    expect(parsed.kind).toBe("malformed");
  });

  it("pid >= 2^31", () => {
    const parsed = parseClaimRecord(`heniek-daemon\t1\tclaiming\t${2 ** 31}\tw\ti\n`);
    expect(parsed.kind).toBe("malformed");
  });

  it("pid at the top of the legal range (2^31 - 1) is well-formed", () => {
    const parsed = parseClaimRecord(`heniek-daemon\t1\tclaiming\t${2 ** 31 - 1}\tw\ti\n`);
    expect(parsed.kind).toBe("well-formed");
  });

  it("a byte length over 1 KiB is malformed", () => {
    const oversizeInstanceId = "a".repeat(MAX_CLAIM_RECORD_BYTES);
    const line = `heniek-daemon\t1\tclaiming\t1\tw\t${oversizeInstanceId}\n`;
    expect(new TextEncoder().encode(line).length).toBeGreaterThan(MAX_CLAIM_RECORD_BYTES);
    expect(parseClaimRecord(line)).toEqual({
      kind: "malformed",
      reason: expect.stringContaining("exceeding the 1024-byte cap"),
    });
  });

  it("non-integer record version", () => {
    const parsed = parseClaimRecord("heniek-daemon\tabc\tclaiming\t1\tw\ti\n");
    expect(parsed.kind).toBe("malformed");
  });
});

describe("serialiseClaimRecord — refuses to produce an out-of-grammar record", () => {
  it("throws on pid 0", () => {
    expect(() => serialiseClaimRecord({ ...RECORD, pid: 0 })).toThrow(RangeError);
  });

  it("throws on pid >= 2^31", () => {
    expect(() => serialiseClaimRecord({ ...RECORD, pid: 2 ** 31 })).toThrow(RangeError);
  });

  it("throws when the serialised line would exceed the 1 KiB cap", () => {
    expect(() =>
      serialiseClaimRecord({ ...RECORD, instanceId: "a".repeat(MAX_CLAIM_RECORD_BYTES) }),
    ).toThrow(RangeError);
  });
});
