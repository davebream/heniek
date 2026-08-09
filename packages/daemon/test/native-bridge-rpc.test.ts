/**
 * The plugin-to-daemon native stage canary (Q023, ADR 0021). Everything
 * below `packages/daemon/test/native-bridge-binding.test.ts` proves already
 * holds through the service layer; this file is the one place that proves
 * the *wire* actually carries it — a real assembled daemon (`startDaemon`),
 * a real Unix domain socket, real HMAC-signed frames, driving the exact
 * sequence a Claude Code plugin (Q050) will: hello, one negotiate listing
 * every native-bridge method and schema digest together (proving
 * `dispatch.ts`'s `availableByName` wiring, not just that each method
 * exists in isolation), stage.start.v3 admitting a native stage with nobody
 * connected, attach, poll, a real question/answer round trip through
 * inbox.list.v1 and run.answer.v2, a second poll delivering the resume,
 * submit, and artifact.get.v1 reading the published bytes back. A second,
 * shorter block proves graceful detach → re-attach → cancel.
 *
 * The full transcript is written to stdout at the end as the ADR's sequence
 * trace evidence — `docs/adr/evidence/0021-q023-bridge-sequence-trace.md`
 * is authored from a real run of this file, not from a hand-written mockup.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { detectCodebaseViaDaemon, registerCodebaseViaDaemon } from "@heniek/client";
import {
  type ApplicationHome,
  ensureApplicationHomeDirectories,
  resolveApplicationHome,
} from "@heniek/config";
import type { ResolvedProfileChainV1 } from "@heniek/contracts";
import {
  ARTIFACT_GET_SCHEMA_ID,
  ARTIFACT_GET_SCHEMA_SHA256,
  ARTIFACT_GET_V1_METHOD,
  buildSignedRequest,
  credentialFromPersisted,
  DAEMON_NEGOTIATE_METHOD,
  type DaemonCredential,
  INBOX_LIST_SCHEMA_ID,
  INBOX_LIST_SCHEMA_SHA256,
  INBOX_LIST_V1_METHOD,
  NATIVE_STAGE_POLL_SCHEMA_ID,
  NATIVE_STAGE_POLL_SCHEMA_SHA256,
  NATIVE_STAGE_POLL_V1_METHOD,
  NATIVE_STAGE_QUESTION_SCHEMA_ID,
  NATIVE_STAGE_QUESTION_SCHEMA_SHA256,
  NATIVE_STAGE_QUESTION_V1_METHOD,
  NATIVE_STAGE_STATUS_SCHEMA_ID,
  NATIVE_STAGE_STATUS_SCHEMA_SHA256,
  NATIVE_STAGE_STATUS_V1_METHOD,
  NATIVE_STAGE_SUBMIT_SCHEMA_ID,
  NATIVE_STAGE_SUBMIT_SCHEMA_SHA256,
  NATIVE_STAGE_SUBMIT_V1_METHOD,
  PARENT_SESSION_ATTACH_SCHEMA_ID,
  PARENT_SESSION_ATTACH_SCHEMA_SHA256,
  PARENT_SESSION_ATTACH_V1_METHOD,
  PARENT_SESSION_DETACH_SCHEMA_ID,
  PARENT_SESSION_DETACH_SCHEMA_SHA256,
  PARENT_SESSION_DETACH_V1_METHOD,
  RUN_ANSWER_V2_METHOD,
  RUN_ANSWER_V2_SCHEMA_ID,
  RUN_ANSWER_V2_SCHEMA_SHA256,
  RUN_CANCEL_V1_METHOD,
  RUN_MUTATION_SCHEMA_ID,
  RUN_MUTATION_SCHEMA_SHA256,
  STAGE_START_METHOD,
  STAGE_START_V3_METHOD,
  STAGE_START_V3_SCHEMA_ID,
  STAGE_START_V3_SCHEMA_SHA256,
  TRANSPORT_VERSION,
} from "@heniek/protocol";
import { createFileSecretStore } from "@heniek/secrets";
import { openStateDatabase, readStageArtifacts } from "@heniek/state";
import type { Static } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/runtime/compose.js";
import { createScriptedBackend } from "./helpers/scripted-backend.js";

const exec = promisify(execFile);
const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

function nativeProfile(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    profileId: "opus-native",
    engine: "claude",
    model: "opus",
    effort: "high",
    executionMode: "native",
    questions: "parent-mediated",
    instructionsPath: "docs/instructions.md",
    artifactContract: "heniek://contract/ExternalStageResult/v1",
    permissions: { workspace: "read-write", identifiers: [] },
    fallbackProfileIds: [],
  };
}

function nativeChain(): Static<typeof ResolvedProfileChainV1> {
  return {
    schemaVersion: 1,
    primaryProfileId: "opus-native",
    primary: nativeProfile(),
    fallbacks: [],
  } as unknown as Static<typeof ResolvedProfileChainV1>;
}

/** A raw NDJSON line socket — write one line, resolve with the next full response line. Mirrors `runtime-socket.test.ts`'s own `connectLineClient`, duplicated locally rather than imported (a test file exports nothing for another to import). */
function connectLineSocket(path: string): Promise<{
  readonly socket: Socket;
  send(line: string): Promise<string>;
  close(): void;
}> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let buffer = "";
    const pending: Array<(line: string) => void> = [];
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        pending.shift()?.(line);
        newlineIndex = buffer.indexOf("\n");
      }
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      resolve({
        socket,
        send(line: string): Promise<string> {
          return new Promise((res) => {
            pending.push(res);
            socket.write(`${line}\n`);
          });
        },
        close(): void {
          socket.destroy();
        },
      });
    });
  });
}

/**
 * One persistent, HMAC-signed session over one connection — exactly the
 * shape a plugin holds open across `poll` cycles. `call()` throws on a
 * JSON-RPC error so a rejected-outcome assertion (`accepted: false`) reads
 * as data, never as a thrown protocol failure.
 */
class NativeBridgeRpcSession {
  #line: Awaited<ReturnType<typeof connectLineSocket>>;
  #credential: DaemonCredential;
  #challenge: Uint8Array;
  #nextId = 1;
  #sequence = 0;
  readonly trace: string[] = [];

  private constructor(
    line: Awaited<ReturnType<typeof connectLineSocket>>,
    credential: DaemonCredential,
    challenge: Uint8Array,
  ) {
    this.#line = line;
    this.#credential = credential;
    this.#challenge = challenge;
  }

  static async open(path: string, credential: DaemonCredential): Promise<NativeBridgeRpcSession> {
    const line = await connectLineSocket(path);
    const helloResponse = JSON.parse(
      await line.send('{"jsonrpc":"2.0","id":0,"method":"daemon.hello"}'),
    ) as { result: { challenge: string } };
    const challenge = new Uint8Array(Buffer.from(helloResponse.result.challenge, "hex"));
    return new NativeBridgeRpcSession(line, credential, challenge);
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.#sequence += 1;
    const id = this.#nextId++;
    const request = buildSignedRequest(
      this.#credential,
      this.#challenge,
      id,
      method,
      this.#sequence,
      params,
    );
    const responseLine = await this.#line.send(request);
    const parsed = JSON.parse(responseLine) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    this.trace.push(`--> ${method} ${JSON.stringify(params)}`);
    this.trace.push(`<-- ${responseLine}`);
    if (parsed.error !== undefined) {
      throw new Error(`${method} rejected: ${parsed.error.code} ${parsed.error.message}`);
    }
    return parsed.result;
  }

  close(): void {
    this.#line.close();
  }
}

async function fixture() {
  const homeDirectory = await mkdtemp(join(tmpdir(), "heniek-q023-canary-"));
  homes.push(homeDirectory);
  const home: ApplicationHome = resolveApplicationHome({
    platform: "linux",
    env: { HENIEK_HOME: homeDirectory },
    homeDirectory,
  });
  await ensureApplicationHomeDirectories(home);

  const remote = join(homeDirectory, "remote.git");
  await mkdir(join(homeDirectory, "source"));
  // `detectCodebase` registers the `realpath`-resolved root — macOS's
  // `os.tmpdir()` returns a path with a symlinked component
  // (`/var/folders/...` -> `/private/var/folders/...`), so the daemon would
  // otherwise register a path this test never actually passes back to it.
  const source = await realpath(join(homeDirectory, "source"));
  await git(homeDirectory, "init", "--bare", remote);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Heniek Test");
  await git(source, "config", "user.email", "heniek@example.invalid");
  await writeFile(join(source, "README.md"), "fixture\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "fixture");
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-u", "origin", "main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  // `detectCodebase` derives the default branch from the LOCAL
  // `refs/remotes/origin/HEAD` symref, which `git clone` sets automatically
  // but a manual `remote add` + `push` never does.
  await git(source, "remote", "set-head", "origin", "main");

  const outcome = await startDaemon({
    home,
    backend: createScriptedBackend({}),
    nativeBridge: { resolveProfileChain: () => nativeChain() },
  });
  if (outcome.kind !== "serving") {
    throw new Error(`expected the canary daemon to reach "serving": ${outcome.error.message}`);
  }

  const detection = await detectCodebaseViaDaemon(home, [source]);
  await registerCodebaseViaDaemon(home, {
    roots: [source],
    expectedTopologySha256: detection.topologySha256,
  });

  return { home, source, outcome };
}

describe("Q023 native bridge — plugin-to-daemon canary over a real socket", () => {
  it("drives the full native stage protocol: negotiate, admission while waiting, dispatch, question, resume, submit and artifact retrieval", async () => {
    const { home, source, outcome } = await fixture();
    try {
      const secretStore = createFileSecretStore({ directory: home.paths.secretsDirectory });
      const credentialText = await secretStore.read("daemon.local-control");
      if (credentialText === undefined) throw new Error("expected a persisted daemon credential");
      const credential = credentialFromPersisted(credentialText.expose());
      if (credential === undefined) throw new Error("expected a parseable daemon credential");

      const session = await NativeBridgeRpcSession.open(home.paths.daemonSocketFile, credential);
      try {
        const negotiation = (await session.call(DAEMON_NEGOTIATE_METHOD, {
          schemaVersion: 1,
          transportVersions: [TRANSPORT_VERSION],
          requiredMethods: [
            {
              name: STAGE_START_METHOD,
              methodVersions: [3],
              resultSchemas: [
                { schemaId: STAGE_START_V3_SCHEMA_ID, sha256: STAGE_START_V3_SCHEMA_SHA256 },
              ],
            },
            {
              name: "parentSession.attach",
              methodVersions: [1],
              resultSchemas: [
                {
                  schemaId: PARENT_SESSION_ATTACH_SCHEMA_ID,
                  sha256: PARENT_SESSION_ATTACH_SCHEMA_SHA256,
                },
              ],
            },
            {
              name: "parentSession.detach",
              methodVersions: [1],
              resultSchemas: [
                {
                  schemaId: PARENT_SESSION_DETACH_SCHEMA_ID,
                  sha256: PARENT_SESSION_DETACH_SCHEMA_SHA256,
                },
              ],
            },
            {
              name: "nativeStage.poll",
              methodVersions: [1],
              resultSchemas: [
                { schemaId: NATIVE_STAGE_POLL_SCHEMA_ID, sha256: NATIVE_STAGE_POLL_SCHEMA_SHA256 },
              ],
            },
            {
              name: "nativeStage.question",
              methodVersions: [1],
              resultSchemas: [
                {
                  schemaId: NATIVE_STAGE_QUESTION_SCHEMA_ID,
                  sha256: NATIVE_STAGE_QUESTION_SCHEMA_SHA256,
                },
              ],
            },
            {
              name: "nativeStage.submit",
              methodVersions: [1],
              resultSchemas: [
                {
                  schemaId: NATIVE_STAGE_SUBMIT_SCHEMA_ID,
                  sha256: NATIVE_STAGE_SUBMIT_SCHEMA_SHA256,
                },
              ],
            },
            {
              name: "nativeStage.status",
              methodVersions: [1],
              resultSchemas: [
                {
                  schemaId: NATIVE_STAGE_STATUS_SCHEMA_ID,
                  sha256: NATIVE_STAGE_STATUS_SCHEMA_SHA256,
                },
              ],
            },
            {
              name: "inbox.list",
              methodVersions: [1],
              resultSchemas: [{ schemaId: INBOX_LIST_SCHEMA_ID, sha256: INBOX_LIST_SCHEMA_SHA256 }],
            },
            {
              name: "run.answer",
              methodVersions: [2],
              resultSchemas: [
                { schemaId: RUN_ANSWER_V2_SCHEMA_ID, sha256: RUN_ANSWER_V2_SCHEMA_SHA256 },
              ],
            },
            {
              name: "run.cancel",
              methodVersions: [1],
              resultSchemas: [
                { schemaId: RUN_MUTATION_SCHEMA_ID, sha256: RUN_MUTATION_SCHEMA_SHA256 },
              ],
            },
            {
              name: "artifact.get",
              methodVersions: [1],
              resultSchemas: [
                { schemaId: ARTIFACT_GET_SCHEMA_ID, sha256: ARTIFACT_GET_SCHEMA_SHA256 },
              ],
            },
          ],
        })) as { compatibility: string; methods: readonly unknown[] };
        expect(negotiation.compatibility).toBe("compatible");
        expect(negotiation.methods).toHaveLength(11);

        const started = (await session.call(STAGE_START_V3_METHOD, {
          schemaVersion: 2,
          currentDirectory: source,
          prompt: "Do the thing.",
          artifactPath: "out/result.md",
          profileId: "opus-native",
          priority: 0,
          requestedIdentifiers: [],
          limits: {},
        })) as { runId: string; stageId: string; status: string; executionMode: string };
        expect(started.executionMode).toBe("native");
        expect(started.status).toBe("waiting_for_parent_session");

        const statusBeforeAttach = (await session.call(NATIVE_STAGE_STATUS_V1_METHOD, {
          runId: started.runId,
        })) as { status: string };
        expect(statusBeforeAttach.status).toBe("waiting_for_parent_session");

        const attached = (await session.call(PARENT_SESSION_ATTACH_V1_METHOD, {
          schemaVersion: 1,
          currentDirectory: source,
          resumeDispatchIds: [],
        })) as { sessionId: string; sessionRevision: number };

        const polled = (await session.call(NATIVE_STAGE_POLL_V1_METHOD, {
          schemaVersion: 1,
          sessionId: attached.sessionId,
          sessionRevision: attached.sessionRevision,
        })) as {
          accepted: boolean;
          sessionRevision: number;
          dispatches: readonly {
            dispatchId: string;
            dispatchRevision: number;
            runId: string;
            stageId: string;
            attemptId: string;
            workingDirectory: string;
          }[];
        };
        expect(polled.accepted).toBe(true);
        expect(polled.dispatches).toHaveLength(1);
        const dispatch = polled.dispatches[0];
        if (dispatch === undefined) throw new Error("expected a claimed dispatch");

        await mkdir(join(dispatch.workingDirectory, "out"), { recursive: true });
        await writeFile(join(dispatch.workingDirectory, "out", "result.md"), "# Done\n");

        const questioned = (await session.call(NATIVE_STAGE_QUESTION_V1_METHOD, {
          schemaVersion: 1,
          sessionId: attached.sessionId,
          sessionRevision: polled.sessionRevision,
          dispatchId: dispatch.dispatchId,
          expectedDispatchRevision: dispatch.dispatchRevision,
          runId: dispatch.runId,
          stageId: dispatch.stageId,
          attemptId: dispatch.attemptId,
          interaction: {
            schemaVersion: 2,
            id: "question-canary",
            questions: [
              {
                id: "q1",
                prompt: "Which approach?",
                options: [{ label: "a" }, { label: "b" }],
                multiSelect: false,
              },
            ],
            requestedAt: new Date().toISOString(),
          },
        })) as { accepted: boolean; interactionId: string; interactionRevision: number };
        expect(questioned.accepted).toBe(true);

        const inbox = (await session.call(INBOX_LIST_V1_METHOD)) as {
          items: readonly { runId: string; interaction: { id: string } }[];
        };
        expect(inbox.items.some((item) => item.runId === dispatch.runId)).toBe(true);

        const answered = (await session.call(RUN_ANSWER_V2_METHOD, {
          schemaVersion: 2,
          runId: dispatch.runId,
          answer: {
            schemaVersion: 2,
            interactionId: questioned.interactionId,
            expectedInteractionRevision: questioned.interactionRevision,
            answers: [{ questionId: "q1", kind: "single_choice", selectedLabels: ["a"] }],
          },
        })) as { status: string };
        expect(answered.status).toBe("running");

        const secondPoll = (await session.call(NATIVE_STAGE_POLL_V1_METHOD, {
          schemaVersion: 1,
          sessionId: attached.sessionId,
          sessionRevision: polled.sessionRevision,
        })) as {
          accepted: boolean;
          sessionRevision: number;
          resumes: readonly { dispatchId: string; dispatchRevision: number }[];
        };
        expect(secondPoll.accepted).toBe(true);
        expect(secondPoll.resumes).toHaveLength(1);
        const resume = secondPoll.resumes[0];
        if (resume === undefined) throw new Error("expected a resume entry");

        const submitted = (await session.call(NATIVE_STAGE_SUBMIT_V1_METHOD, {
          schemaVersion: 1,
          sessionId: attached.sessionId,
          sessionRevision: secondPoll.sessionRevision,
          dispatchId: resume.dispatchId,
          expectedDispatchRevision: resume.dispatchRevision,
          runId: dispatch.runId,
          stageId: dispatch.stageId,
          attemptId: dispatch.attemptId,
          submissionId: "submission-canary",
          outcome: "succeeded",
          result: { schemaVersion: 1, summary: "Done.", artifactPath: "out/result.md" },
        })) as { accepted: boolean; status: string };
        expect(submitted).toMatchObject({ accepted: true, status: "succeeded" });

        const finalStatus = (await session.call(NATIVE_STAGE_STATUS_V1_METHOD, {
          runId: dispatch.runId,
        })) as { status: string };
        expect(finalStatus.status).toBe("succeeded");

        // `nativeStage.status.v1` does not surface an artifact id (D2's
        // shared terminal path publishes through the same content-addressed
        // store `run.result` reads; native's own result surface for it is
        // tracked as follow-up, not part of Q023's RPC surface). Read it
        // directly from the daemon's own state file — a second, independent
        // reader connection, exactly as `artifact.get.v1`'s own handler
        // does internally.
        const reader = openStateDatabase({
          path: home.paths.stateDatabaseFile,
          clock: { nowIso: () => new Date().toISOString() },
          ids: { next: (prefix: string) => `${prefix}-canary` },
        });
        let artifactId: string;
        try {
          const artifacts = readStageArtifacts(reader, dispatch.runId);
          const artifact = artifacts[0];
          if (artifact === undefined) throw new Error("expected a published artifact");
          artifactId = artifact.artifactId;
        } finally {
          reader.close();
        }

        const fetched = (await session.call(ARTIFACT_GET_V1_METHOD, { artifactId })) as {
          contentBase64: string;
          eof: boolean;
        };
        expect(fetched.eof).toBe(true);
        expect(Buffer.from(fetched.contentBase64, "base64").toString("utf8")).toBe("# Done\n");

        // --- Second block: graceful detach -> re-attach -> cancel ---------
        const secondStarted = (await session.call(STAGE_START_V3_METHOD, {
          schemaVersion: 2,
          currentDirectory: source,
          prompt: "Do another thing.",
          artifactPath: "out/second.md",
          profileId: "opus-native",
          priority: 0,
          requestedIdentifiers: [],
          limits: {},
        })) as { runId: string };

        const secondSessionAttach = (await session.call(PARENT_SESSION_ATTACH_V1_METHOD, {
          schemaVersion: 1,
          currentDirectory: source,
          resumeDispatchIds: [],
        })) as { sessionId: string; sessionRevision: number };
        const secondSessionPoll = (await session.call(NATIVE_STAGE_POLL_V1_METHOD, {
          schemaVersion: 1,
          sessionId: secondSessionAttach.sessionId,
          sessionRevision: secondSessionAttach.sessionRevision,
        })) as {
          sessionRevision: number;
          dispatches: readonly { dispatchId: string; runId: string }[];
        };
        const secondDispatch = secondSessionPoll.dispatches[0];
        if (secondDispatch === undefined) throw new Error("expected a second claimed dispatch");

        const detached = (await session.call(PARENT_SESSION_DETACH_V1_METHOD, {
          schemaVersion: 1,
          sessionId: secondSessionAttach.sessionId,
          sessionRevision: secondSessionPoll.sessionRevision,
          dispatches: [{ dispatchId: secondDispatch.dispatchId, outcome: "not_started" }],
        })) as { accepted: boolean; released: readonly { disposition: string }[] };
        expect(detached).toMatchObject({
          accepted: true,
          released: [{ disposition: "redispatchable" }],
        });

        const reattached = (await session.call(PARENT_SESSION_ATTACH_V1_METHOD, {
          schemaVersion: 1,
          currentDirectory: source,
          resumeDispatchIds: [],
        })) as { sessionId: string; sessionRevision: number };
        const reclaimedPoll = (await session.call(NATIVE_STAGE_POLL_V1_METHOD, {
          schemaVersion: 1,
          sessionId: reattached.sessionId,
          sessionRevision: reattached.sessionRevision,
        })) as { dispatches: readonly { runId: string }[] };
        expect(reclaimedPoll.dispatches.some((claim) => claim.runId === secondStarted.runId)).toBe(
          true,
        );

        const cancelled = (await session.call(RUN_CANCEL_V1_METHOD, {
          runId: secondStarted.runId,
        })) as { status: string; accepted: boolean };
        expect(cancelled).toMatchObject({ status: "cancelled", accepted: true });

        process.stdout.write(
          `\n--- Q023 native bridge canary sequence trace ---\n${session.trace.join("\n")}\n--- end trace ---\n`,
        );
      } finally {
        session.close();
      }
    } finally {
      outcome.requestDrain();
      await outcome.stopped;
    }
  });
});
