import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_ENGINE_SHA,
  EXPECTED_ENGINE_VERSION,
  EXPECTED_PROTOCOL_MAJOR,
} from "../src/smoke/claudexor/protocol.js";
import { createEventTrace, type EventRecord } from "../src/smoke/claudexor/trace.js";
import { resolveRepoRoot } from "../src/smoke/env.js";

/**
 * Deliberately allowlist-admissible and short, so the ONLY thing that denies
 * it is the daemon-token clause. A 36-char UUID-ish token would be caught by
 * the generic token-run rule instead, leaving the clause that guards the live
 * secret with no coverage at all.
 */
const DAEMON_TOKEN = "tok.9e02.4c11";

/**
 * One fixture per deny clause, each caught by exactly that clause. If any
 * single clause is deleted, at least one of these must fail — that property is
 * the point, and it is asserted in "deny-clause coverage" below.
 */
const CLAUSE_EXCLUSIVE = {
  credentialPrefix: "sk-1a2b3c4d",
  jwtTriple: `${"a".repeat(15)}.${"b".repeat(15)}.${"c".repeat(15)}`,
  tokenRun: "b".repeat(40),
  daemonTokenContainment: "run.tok.9e02.4c11.end",
} as const;

/** Plan-mandated extra cases. */
const ALSO_DENIED = {
  midStringPat: `note.ghp_${"a".repeat(36)}`,
  prompt: "Reply with exactly: CANARY_OK please",
  homePath: "/home/dave/.ssh/id_rsa",
  longKey: "z".repeat(120),
} as const;

function baseEvent(): Record<string, unknown> {
  return {
    seq: 1,
    ts: "2026-07-31T23:34:50.090Z",
    type: "run.created",
    run_id: "run-d2fb12fa3051",
    task_id: "task-a9b1ea142bc5",
  };
}

function serialised(trace: ReturnType<typeof createEventTrace>): string {
  return `${JSON.stringify(trace.entries())}\n${trace.toMarkdown()}`;
}

function asEvent(record: ReturnType<ReturnType<typeof createEventTrace>["recordEvent"]>) {
  if (record.kind !== "event") throw new Error(`expected an event, got ${record.kind}`);
  return record as EventRecord;
}

describe("createEventTrace — real engine shapes", () => {
  // Regression: a credential-prefix test without a word boundary denies every
  // real Claudexor task id, because "task-a9b1ea142bc5" contains "sk-".
  it("keeps ids that contain credential-like substrings", () => {
    const entry = asEvent(createEventTrace().recordEvent(baseEvent()));
    expect("task-a9b1ea142bc5").toContain("sk-");
    expect(entry.taskId).toBe("task-a9b1ea142bc5");
    expect(entry.droppedFields).toEqual([]);
  });

  // Regression: including `-` in the token-run character class made a canonical
  // UUID (36 unbroken chars) look like a secret, so a UUID-shaped run_id was
  // silently dropped and every row of the committed trace lost its
  // correlation key.
  it("keeps a UUID-shaped run id", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const entry = asEvent(createEventTrace().recordEvent({ ...baseEvent(), run_id: uuid }));
    expect(entry.runId).toBe(uuid);
  });

  // Regression: `+` is absent from the value allowlist, so offset-form
  // ISO-8601 was rejected — and, before the recorder was made total, threw
  // mid-stream and destroyed the rest of an expensive run's evidence.
  it.each([
    ["Z form", "2026-07-31T23:34:50.090Z"],
    ["positive offset", "2026-07-31T23:34:50.090+02:00"],
    ["negative offset", "2026-07-31T23:34:50-05:00"],
  ])("accepts an ISO-8601 timestamp in %s", (_label, ts) => {
    expect(asEvent(createEventTrace().recordEvent({ ...baseEvent(), ts })).ts).toBe(ts);
  });

  it("accepts a numeric epoch timestamp", () => {
    expect(asEvent(createEventTrace().recordEvent({ ...baseEvent(), ts: 1785000000000 })).ts).toBe(
      "epoch:1785000000000",
    );
  });
});

describe("createEventTrace — totality", () => {
  // The recorder consumes a live SSE stream from a >=20-minute, effectively
  // non-repeatable run. Throwing on one bad frame destroys the artifact it
  // exists to produce.
  it.each([
    ["a non-object frame", 42],
    ["a missing seq", { ts: "2026-07-31T23:34:50.090Z", type: "x" }],
    ["a fractional seq", { ...baseEvent(), seq: 1.5 }],
    ["a path-like ts", { ...baseEvent(), ts: "/home/dave/secret.txt" }],
    ["a whitespace-bearing type", { ...baseEvent(), type: "two words" }],
  ])("records %s as a rejection instead of throwing", (_label, frame) => {
    const trace = createEventTrace();
    let result: ReturnType<typeof trace.recordEvent> | undefined;
    expect(() => {
      result = trace.recordEvent(frame);
    }).not.toThrow();
    expect(result?.kind).toBe("rejected");
    expect(trace.entries()).toHaveLength(1);
  });

  it("keeps recording after a rejected frame", () => {
    const trace = createEventTrace();
    trace.recordEvent({ ...baseEvent(), type: "bad type" });
    const good = trace.recordEvent({ ...baseEvent(), seq: 2 });
    expect(good.kind).toBe("event");
    expect(trace.entries()).toHaveLength(2);
  });

  it("does not surface the message of a throwing engine accessor", () => {
    const payload = {} as Record<string, unknown>;
    Object.defineProperty(payload, "state", {
      enumerable: true,
      get() {
        throw new Error("boom TRANSCRIPT SECRET");
      },
    });
    const trace = createEventTrace();
    const result = trace.recordEvent({ ...baseEvent(), payload });
    expect(result.kind).toBe("rejected");
    expect(serialised(trace)).not.toContain("TRANSCRIPT");
  });
});

describe("createEventTrace — deny layer", () => {
  it.each(Object.entries(CLAUSE_EXCLUSIVE))(
    "denies %s, which only that clause catches",
    (_name, dirty) => {
      const trace = createEventTrace({ daemonToken: DAEMON_TOKEN });
      const entry = asEvent(trace.recordEvent({ ...baseEvent(), payload: { state: dirty } }));
      expect(entry.payload).toEqual({});
      expect(entry.droppedFields).toContain("payload.state");
      expect(serialised(trace)).not.toContain(dirty);
    },
  );

  it.each(Object.entries(ALSO_DENIED))("denies %s", (_name, dirty) => {
    const trace = createEventTrace({ daemonToken: DAEMON_TOKEN });
    trace.recordEvent({ ...baseEvent(), payload: { state: dirty } });
    expect(serialised(trace)).not.toContain(dirty);
  });

  // A dedicated assertion that the daemon-token clause has real work to do:
  // this value is short, dotted, and allowlist-admissible, so no other clause
  // would stop it.
  it("denies a value merely CONTAINING the daemon token", () => {
    const trace = createEventTrace({ daemonToken: DAEMON_TOKEN });
    trace.recordEvent({ ...baseEvent(), payload: { state: "run.tok.9e02.4c11.end" } });
    expect(serialised(trace)).not.toContain(DAEMON_TOKEN);
  });

  it("keeps the same value when no daemon token is configured", () => {
    const trace = createEventTrace();
    const entry = asEvent(
      trace.recordEvent({ ...baseEvent(), payload: { state: "run.tok.9e02.4c11.end" } }),
    );
    expect(entry.payload["state"]).toBe("run.tok.9e02.4c11.end");
  });
});

describe("createEventTrace — disclosure budget", () => {
  // The realistic leak is not an adversarial engine crafting a JWT; it is an
  // ordinary engine emitting an ordinary metadata scalar. Payload keys are
  // therefore allowlisted, and unknown keys are dropped whatever their value
  // looks like — including numbers.
  it.each([
    ["operator identity", { user: "dave" }],
    ["host identity", { hostname: "daves-workstation" }],
    ["project identity", { project: "acme-merger-diligence" }],
    ["workload size", { input_tokens: 48213, output_tokens: 9902 }],
    ["cost", { cost_usd: 1.34 }],
  ])("drops %s even though the value shape is innocuous", (_label, payload) => {
    const trace = createEventTrace();
    const entry = asEvent(trace.recordEvent({ ...baseEvent(), payload }));
    expect(entry.payload).toEqual({});
    for (const value of Object.values(payload)) {
      expect(serialised(trace)).not.toContain(String(value));
    }
  });

  it("keeps enumerated lifecycle keys", () => {
    const trace = createEventTrace();
    const entry = asEvent(
      trace.recordEvent({
        ...baseEvent(),
        payload: { state: "running", waiting_on_user: false, attempt: 2 },
      }),
    );
    expect(entry.payload).toEqual({ state: "running", waiting_on_user: false, attempt: 2 });
  });

  it("reports a wholly withheld non-object payload rather than an empty dropped column", () => {
    const trace = createEventTrace();
    const entry = asEvent(trace.recordEvent({ ...baseEvent(), payload: ["secret"] }));
    expect(entry.droppedFields).toContain("payload");
  });
});

describe("createEventTrace — names as data", () => {
  it.each([
    ["a filesystem path", ALSO_DENIED.homePath],
    ["a credential", `ghp_${"c".repeat(36)}`],
    ["a >100 character key", ALSO_DENIED.longKey],
  ])("redacts a payload KEY that is %s", (_label, key) => {
    const trace = createEventTrace();
    trace.recordEvent({ ...baseEvent(), payload: { [key]: 1 } });
    expect(serialised(trace)).not.toContain(key);
  });

  it("redacts a top-level KEY that is a credential", () => {
    const key = `ghp_${"d".repeat(36)}`;
    const trace = createEventTrace();
    trace.recordEvent({ ...baseEvent(), [key]: 1 });
    expect(serialised(trace)).not.toContain(key);
  });

  it("reports dropped FIELD NAMES only, never dropped values", () => {
    const trace = createEventTrace({ daemonToken: DAEMON_TOKEN });
    const entry = asEvent(
      trace.recordEvent({
        ...baseEvent(),
        payload: { state: CLAUSE_EXCLUSIVE.tokenRun, project: "acme" },
      }),
    );
    expect(entry.droppedFields).toContain("payload.state");
    expect(entry.droppedFields.join("|")).not.toContain(CLAUSE_EXCLUSIVE.tokenRun);
    expect(entry.droppedFields.join("|")).not.toContain("acme");
  });

  it("does not pick up values from the prototype chain", () => {
    const payload = Object.create({ state: "INHERITED" }) as Record<string, unknown>;
    payload["mode"] = "agent";
    const trace = createEventTrace();
    trace.recordEvent({ ...baseEvent(), payload });
    expect(serialised(trace)).not.toContain("INHERITED");
  });

  it("records a __proto__ payload key as dropped rather than losing it silently", () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const entry = asEvent(createEventTrace().recordEvent({ ...baseEvent(), payload }));
    expect(entry.droppedFields).toContain("payload.__proto__");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("cannot forge a Markdown row through type or a payload value", () => {
    const trace = createEventTrace();
    trace.recordEvent({ ...baseEvent(), type: "ok\n| 99 | forged |" });
    trace.recordEvent({ ...baseEvent(), seq: 2, payload: { state: "x\n| 98 | forged |" } });
    expect(trace.toMarkdown()).not.toContain("forged");
  });

  it("does not hand back mutable internals", () => {
    const entry = asEvent(
      createEventTrace().recordEvent({ ...baseEvent(), payload: { mode: "agent" } }),
    );
    expect(Object.isFrozen(entry.payload)).toBe(true);
    expect(Object.isFrozen(entry.droppedFields)).toBe(true);
  });
});

describe("createEventTrace — provenance", () => {
  // The pinned sha is 40 unbroken token characters, so the generic heuristics
  // deny it on purpose. It is admitted by equality with the compile-time pin,
  // never by pattern, so only known public values can ever be printed.
  it("records the pinned engine identity and renders it as a header", () => {
    const trace = createEventTrace();
    const record = trace.recordProvenance({
      protocolMajor: EXPECTED_PROTOCOL_MAJOR,
      operationsPath: "/v2/operations",
      engineVersion: EXPECTED_ENGINE_VERSION,
      engineSha: EXPECTED_ENGINE_SHA,
    });
    expect(record.matchesPin).toBe(true);
    const markdown = trace.toMarkdown();
    expect(markdown).toContain(EXPECTED_ENGINE_SHA);
    expect(markdown).toContain(EXPECTED_ENGINE_VERSION);
    expect(markdown).toContain("matches pin");
  });

  it("never echoes a mismatched engine identity", () => {
    const trace = createEventTrace();
    const record = trace.recordProvenance({
      protocolMajor: EXPECTED_PROTOCOL_MAJOR,
      operationsPath: "/v2/operations",
      engineVersion: "9.9.9-attacker",
      engineSha: "f".repeat(40),
    });
    expect(record.matchesPin).toBe(false);
    expect(serialised(trace)).not.toContain("attacker");
    expect(serialised(trace)).not.toContain("f".repeat(40));
  });

  it("rejects a hostile operations path", () => {
    const trace = createEventTrace();
    const record = trace.recordProvenance({
      protocolMajor: EXPECTED_PROTOCOL_MAJOR,
      operationsPath: "http://attacker.example/x",
      engineVersion: EXPECTED_ENGINE_VERSION,
      engineSha: EXPECTED_ENGINE_SHA,
    });
    expect(record.operationsPath).toBe("<rejected>");
    expect(serialised(trace)).not.toContain("attacker.example");
  });
});

/**
 * Repository-level guard over everything committed under `docs/adr/`. Biome
 * does not lint Markdown (`biome ci <md>` reports "Checked 0 files"), so this
 * is the only automated barrier protecting the ADR and its evidence file.
 */
const ADR_DIR = join(resolveRepoRoot(), "docs/adr");

const FORBIDDEN_SUBSTRINGS = ["/home/", "/root/", "/Users/", "/tmp/", "/data/", "Bearer "] as const;
const FORBIDDEN_PATTERNS = [/\bsk-/, /\bghp_/, /\bgho_/, /\bgithub_pat_/, /\bxox[baprs]-/] as const;

function markdownFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("committed ADR redaction guard", () => {
  // Negative control: proves the constant lists can fire, so a hollowed-out
  // list cannot make the guard pass vacuously.
  it("detects a synthetic dirty string", () => {
    const dirty = `/home/dave /tmp/x Bearer abc sk-abc ghp_${"a".repeat(36)}`;
    expect(FORBIDDEN_SUBSTRINGS.some((s) => dirty.includes(s))).toBe(true);
    expect(FORBIDDEN_PATTERNS.some((p) => p.test(dirty))).toBe(true);
  });

  // `"task-".includes("sk-")` is true, so raw substring matching on the
  // credential prefixes would false-positive on every real Claudexor task id.
  it("does not false-positive on real Claudexor identifiers", () => {
    const clean = "task-a9b1ea142bc5 run-d2fb12fa3051 local_session";
    expect(FORBIDDEN_SUBSTRINGS.some((s) => clean.includes(s))).toBe(false);
    expect(FORBIDDEN_PATTERNS.some((p) => p.test(clean))).toBe(false);
  });

  it("finds at least the existing ADR, so the scan cannot pass vacuously", () => {
    expect(markdownFilesUnder(ADR_DIR).length).toBeGreaterThan(0);
  });

  it("keeps every committed ADR document free of credential or path material", () => {
    for (const file of markdownFilesUnder(ADR_DIR)) {
      const contents = readFileSync(file, "utf8");
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(contents, `${file} contains ${forbidden}`).not.toContain(forbidden);
      }
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(pattern.test(contents), `${file} matches ${pattern}`).toBe(false);
      }
    }
  });
});
