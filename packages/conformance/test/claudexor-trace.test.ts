import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventTrace, InvalidTraceEventError } from "../src/smoke/claudexor/trace.js";
import { resolveRepoRoot } from "../src/smoke/env.js";

const DAEMON_TOKEN = "5f1c9a2e-daemon-token-3b7d-4c11-9e02";

/**
 * Values that the deny layer alone must reject. Each is chosen so the narrow
 * allowlist would NOT have caught it on its own — otherwise the deny layer
 * could be deleted and these tests would still pass.
 */
const DENY_EXCLUSIVE = {
  midStringPat: `note.ghp_${"a".repeat(36)}`,
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r-2f",
  opaqueRun: "b".repeat(40),
  daemonToken: DAEMON_TOKEN,
} as const;

const ALLOWLIST_ALSO_REJECTS = {
  prompt: "Reply with exactly: CANARY_OK please",
  answer: "The model said something with spaces",
  homePath: "/home/dave/.ssh/id_rsa",
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

describe("createEventTrace — happy path", () => {
  // Regression: a credential-prefix test without a word boundary denies every
  // real Claudexor task id, because "task-a9b1ea142bc5" contains "sk-". The
  // first canary run would then have recorded no task ids at all.
  it("keeps real Claudexor run and task ids, which contain credential-like substrings", () => {
    const trace = createEventTrace();
    const entry = trace.recordEvent(baseEvent());
    expect("task-a9b1ea142bc5").toContain("sk-");
    expect(entry.taskId).toBe("task-a9b1ea142bc5");
    expect(entry.droppedFields).toEqual([]);
  });

  it("keeps the allowlisted engine fields", () => {
    const trace = createEventTrace({ daemonToken: DAEMON_TOKEN });
    const entry = trace.recordEvent({ ...baseEvent(), payload: { mode: "agent", turns: 3 } });
    expect(entry.seq).toBe(1);
    expect(entry.type).toBe("run.created");
    expect(entry.runId).toBe("run-d2fb12fa3051");
    expect(entry.taskId).toBe("task-a9b1ea142bc5");
    expect(entry.payload).toEqual({ mode: "agent", turns: 3 });
    expect(entry.droppedFields).toEqual([]);
  });

  it("records process observations with pid and timestamp", () => {
    const trace = createEventTrace();
    trace.recordProcess({ label: "launcher", pid: 4242, at: "2026-07-31T23:34:50.090Z" });
    const markdown = trace.toMarkdown();
    expect(markdown).toContain("4242");
    expect(markdown).toContain("2026-07-31T23:34:50.090Z");
    expect(markdown).toContain("launcher");
  });
});

describe("createEventTrace — redaction", () => {
  it.each(Object.entries(DENY_EXCLUSIVE))(
    "drops payload value %s that the allowlist alone would admit",
    (name, dirty) => {
      const trace = createEventTrace({ daemonToken: DAEMON_TOKEN });
      const entry = trace.recordEvent({ ...baseEvent(), payload: { [name]: dirty } });
      expect(entry.payload).toEqual({});
      expect(entry.droppedFields).toContain(`payload.${name}`);
      expect(serialised(trace)).not.toContain(dirty);
    },
  );

  it.each(Object.entries(ALLOWLIST_ALSO_REJECTS))("drops payload value %s", (name, dirty) => {
    const trace = createEventTrace({ daemonToken: DAEMON_TOKEN });
    trace.recordEvent({ ...baseEvent(), payload: { [name]: dirty } });
    expect(serialised(trace)).not.toContain(dirty);
  });

  // A key can itself be the secret. Sanitising values only would publish it.
  it("redacts a payload KEY that is a filesystem path", () => {
    const trace = createEventTrace({ daemonToken: DAEMON_TOKEN });
    const entry = trace.recordEvent({
      ...baseEvent(),
      payload: { [ALLOWLIST_ALSO_REJECTS.homePath]: 1 },
    });
    expect(entry.payload).toEqual({});
    expect(serialised(trace)).not.toContain(ALLOWLIST_ALSO_REJECTS.homePath);
    expect(serialised(trace)).not.toContain("/home/");
  });

  it("redacts a payload KEY that is a credential", () => {
    const key = `ghp_${"c".repeat(36)}`;
    const trace = createEventTrace({ daemonToken: DAEMON_TOKEN });
    trace.recordEvent({ ...baseEvent(), payload: { [key]: 1 } });
    expect(serialised(trace)).not.toContain(key);
  });

  it("redacts a >100 character object KEY", () => {
    const key = "k".repeat(120);
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

  // `ts` and `type` are engine-controlled and must pass the same deny layer.
  it("rejects an event whose type carries the daemon token", () => {
    const trace = createEventTrace({ daemonToken: DAEMON_TOKEN });
    expect(() => trace.recordEvent({ ...baseEvent(), type: DAEMON_TOKEN })).toThrow(
      InvalidTraceEventError,
    );
    expect(serialised(trace)).not.toContain(DAEMON_TOKEN);
  });

  it("rejects an event whose ts is a filesystem path", () => {
    const trace = createEventTrace();
    expect(() =>
      trace.recordEvent({ ...baseEvent(), ts: "/home/dave/secret/transcript.txt" }),
    ).toThrow(InvalidTraceEventError);
  });

  // A newline in `type` would forge an extra row in the rendered table.
  it("rejects a type containing a newline, so Markdown rows cannot be forged", () => {
    const trace = createEventTrace();
    expect(() =>
      trace.recordEvent({ ...baseEvent(), type: "ok\n| 99 | forged | event |" }),
    ).toThrow(InvalidTraceEventError);
    expect(trace.toMarkdown()).not.toContain("forged");
  });

  it("never lets a thrown error echo the offending value", () => {
    const trace = createEventTrace({ daemonToken: DAEMON_TOKEN });
    try {
      trace.recordEvent({ ...baseEvent(), type: DAEMON_TOKEN });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("type");
      expect((error as Error).message).not.toContain(DAEMON_TOKEN);
    }
  });

  it("does not pick up values from the prototype chain", () => {
    const payload = Object.create({ inherited: "INHERITED-FROM-PROTOTYPE" }) as Record<
      string,
      unknown
    >;
    payload["mode"] = "agent";
    const trace = createEventTrace();
    trace.recordEvent({ ...baseEvent(), payload });
    expect(serialised(trace)).not.toContain("INHERITED-FROM-PROTOTYPE");
  });

  it("records a __proto__ payload key as dropped rather than losing it silently", () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const trace = createEventTrace();
    const entry = trace.recordEvent({ ...baseEvent(), payload });
    expect(entry.droppedFields.length).toBeGreaterThan(0);
    expect(Object.keys(entry.payload)).not.toContain("polluted");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("reports dropped FIELD NAMES only, never dropped values", () => {
    const trace = createEventTrace({ daemonToken: DAEMON_TOKEN });
    const entry = trace.recordEvent({
      ...baseEvent(),
      payload: { secret: DENY_EXCLUSIVE.opaqueRun, prompt: ALLOWLIST_ALSO_REJECTS.prompt },
    });
    expect(entry.droppedFields).toContain("payload.secret");
    for (const dirty of [DENY_EXCLUSIVE.opaqueRun, ALLOWLIST_ALSO_REJECTS.prompt]) {
      expect(entry.droppedFields.join("|")).not.toContain(dirty);
    }
  });

  it("does not hand back mutable internals", () => {
    const trace = createEventTrace();
    const entry = trace.recordEvent({ ...baseEvent(), payload: { mode: "agent" } });
    expect(Object.isFrozen(entry.payload)).toBe(true);
    expect(Object.isFrozen(entry.droppedFields)).toBe(true);
    expect(Object.isFrozen(trace.entries())).toBe(true);
  });
});

/**
 * Repository-level guard over the committed ADR evidence. Biome does not lint
 * Markdown (`biome ci <md>` reports "Checked 0 files"), so this test is the
 * only automated barrier protecting the committed trace from a future edit.
 */
const EVIDENCE_PATH = join(resolveRepoRoot(), "docs/adr/evidence/0002-claudexor-v2-event-trace.md");

/** Plain substrings, plus credential prefixes matched on a word boundary. */
const FORBIDDEN_SUBSTRINGS = ["/home/", "/root/", "Bearer "] as const;
const FORBIDDEN_PATTERNS = [/\bsk-/, /\bghp_/, /\bgho_/, /\bgithub_pat_/, /\bxox[baprs]-/] as const;

describe("committed ADR evidence redaction guard", () => {
  // Negative control: proves the constant lists can actually fire, so a
  // hollowed-out list cannot make the guard below pass vacuously.
  it("detects a synthetic dirty string", () => {
    const dirty = `/home/dave secret Bearer abc sk-abc ghp_${"a".repeat(36)}`;
    expect(FORBIDDEN_SUBSTRINGS.some((s) => dirty.includes(s))).toBe(true);
    expect(FORBIDDEN_PATTERNS.some((p) => p.test(dirty))).toBe(true);
  });

  // `"task-".includes("sk-")` is true, so raw substring matching would
  // false-positive on every real Claudexor task id.
  it("does not false-positive on real Claudexor identifiers", () => {
    const clean = "task-a9b1ea142bc5 run-d2fb12fa3051 local_session";
    expect(FORBIDDEN_SUBSTRINGS.some((s) => clean.includes(s))).toBe(false);
    expect(FORBIDDEN_PATTERNS.some((p) => p.test(clean))).toBe(false);
  });

  describe.skipIf(!existsSync(EVIDENCE_PATH))(
    "docs/adr/evidence/0002-claudexor-v2-event-trace.md [skipped until the canary run writes it]",
    () => {
      it("contains no credential, transcript, or home-path material", () => {
        const contents = readFileSync(EVIDENCE_PATH, "utf8");
        for (const forbidden of FORBIDDEN_SUBSTRINGS) {
          expect(contents, `evidence contains ${forbidden}`).not.toContain(forbidden);
        }
        for (const pattern of FORBIDDEN_PATTERNS) {
          expect(pattern.test(contents), `evidence matches ${pattern}`).toBe(false);
        }
      });
    },
  );
});
