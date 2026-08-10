import { createHmac } from "node:crypto";

export const JSON_RPC_VERSION = "2.0";
export const TRANSPORT_VERSION = 1;
export const MAX_LINE_BYTES = 64 * 1024;

export const DAEMON_HELLO_METHOD = "daemon.hello";
export const DAEMON_NEGOTIATE_METHOD = "daemon.negotiate";
export const DAEMON_STATUS_METHOD = "daemon.status";
export const DAEMON_STATUS_V1_METHOD = "daemon.status.v1";
export const DAEMON_RECOVERY_METHOD = "daemon.recovery";
export const DAEMON_RECOVERY_V1_METHOD = "daemon.recovery.v1";
export const CODEBASE_DETECT_METHOD = "codebase.detect";
export const CODEBASE_DETECT_V1_METHOD = "codebase.detect.v1";
export const CODEBASE_REGISTER_METHOD = "codebase.register";
export const CODEBASE_REGISTER_V1_METHOD = "codebase.register.v1";
export const CODEBASE_ONBOARD_PROPOSE_METHOD = "codebase.onboard.propose";
export const CODEBASE_ONBOARD_PROPOSE_V1_METHOD = "codebase.onboard.propose.v1";
export const CODEBASE_ONBOARD_APPLY_METHOD = "codebase.onboard.apply";
export const CODEBASE_ONBOARD_APPLY_V1_METHOD = "codebase.onboard.apply.v1";
export const STAGE_START_METHOD = "stage.start";
export const STAGE_START_V1_METHOD = "stage.start.v1";
export const STAGE_START_V2_METHOD = "stage.start.v2";
export const STAGE_START_V3_METHOD = "stage.start.v3";
export const RUN_STATUS_METHOD = "run.status";
export const RUN_STATUS_V1_METHOD = "run.status.v1";
export const RUN_STATUS_V2_METHOD = "run.status.v2";
export const RUN_STATUS_V3_METHOD = "run.status.v3";
export const RUN_STATUS_V4_METHOD = "run.status.v4";
export const RUN_ANSWER_METHOD = "run.answer";
export const RUN_ANSWER_V1_METHOD = "run.answer.v1";
export const RUN_ANSWER_V2_METHOD = "run.answer.v2";
export const RUN_RESUME_METHOD = "run.resume";
export const RUN_RESUME_V1_METHOD = "run.resume.v1";
export const RUN_RESUME_V2_METHOD = "run.resume.v2";
export const INBOX_LIST_METHOD = "inbox.list";
export const INBOX_LIST_V1_METHOD = "inbox.list.v1";
export const RUN_CANCEL_METHOD = "run.cancel";
export const RUN_CANCEL_V1_METHOD = "run.cancel.v1";
export const RUN_RESULT_METHOD = "run.result";
export const RUN_RESULT_V1_METHOD = "run.result.v1";
export const RUN_RESULT_V2_METHOD = "run.result.v2";
export const RUN_RESULT_V3_METHOD = "run.result.v3";

/**
 * Q023's native bridge. Two families on purpose: `parentSession.*` is
 * connection identity, called once per attached session; `nativeStage.*` is
 * per-dispatch work, called continuously. Collapsing them would lose that
 * distinction without saving anything — negotiation is per-connection over
 * the set of required methods regardless of how they are named.
 */
export const PARENT_SESSION_ATTACH_METHOD = "parentSession.attach";
export const PARENT_SESSION_ATTACH_V1_METHOD = "parentSession.attach.v1";
export const PARENT_SESSION_DETACH_METHOD = "parentSession.detach";
export const PARENT_SESSION_DETACH_V1_METHOD = "parentSession.detach.v1";
export const NATIVE_STAGE_POLL_METHOD = "nativeStage.poll";
export const NATIVE_STAGE_POLL_V1_METHOD = "nativeStage.poll.v1";
export const NATIVE_STAGE_QUESTION_METHOD = "nativeStage.question";
export const NATIVE_STAGE_QUESTION_V1_METHOD = "nativeStage.question.v1";
export const NATIVE_STAGE_SUBMIT_METHOD = "nativeStage.submit";
export const NATIVE_STAGE_SUBMIT_V1_METHOD = "nativeStage.submit.v1";
export const NATIVE_STAGE_STATUS_METHOD = "nativeStage.status";
export const NATIVE_STAGE_STATUS_V1_METHOD = "nativeStage.status.v1";
export const ARTIFACT_GET_METHOD = "artifact.get";
export const ARTIFACT_GET_V1_METHOD = "artifact.get.v1";
export const DOCTOR_METHOD = "doctor";
export const DOCTOR_V1_METHOD = "doctor.v1";
export const DOCTOR_V2_METHOD = "doctor.v2";
export const ENGINE_CATALOGUE_METHOD = "engine.catalogue";
export const ENGINE_CATALOGUE_V1_METHOD = "engine.catalogue.v1";
export const PIPELINE_VALIDATE_METHOD = "pipeline.validate";
export const PIPELINE_VALIDATE_V1_METHOD = "pipeline.validate.v1";
export const PIPELINE_RUN_METHOD = "pipeline.run";
export const PIPELINE_RUN_V1_METHOD = "pipeline.run.v1";
export const PIPELINE_ATTACH_METHOD = "pipeline.attach";
export const PIPELINE_ATTACH_V1_METHOD = "pipeline.attach.v1";
export const RPC_CANCEL_METHOD = "rpc.cancel";

export const ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  draining: -32000,
  unauthorized: -32001,
  requestCancelled: -32002,
  protocolNotNegotiated: -32003,
} as const;

export const ERROR_MESSAGES = {
  draining: "draining",
  unauthorized: "unauthorized",
  requestCancelled: "request cancelled",
  protocolNotNegotiated: "protocol not negotiated",
} as const;

export type JsonRpcId = string | number;

export interface DaemonCredential {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

export interface NegotiatedMethodV1 {
  readonly name: string;
  readonly methodVersion: number;
  readonly wireMethod: string;
  readonly resultSchemaId: string;
  readonly resultSchemaSha256: string;
}

export const DAEMON_STATUS_SCHEMA_ID = "heniek://contract/DaemonStatus/v1";
export const DAEMON_STATUS_SCHEMA_SHA256 =
  "a91375e3509ceb2663a96e656d18e32c722085a1cb574328159cee7ff4fef854";
export const DAEMON_RECOVERY_SCHEMA_ID = "heniek://contract/DaemonRecoveryResult/v1";
export const DAEMON_RECOVERY_SCHEMA_SHA256 =
  "8c4099c58b018a809e8708451e33ccdc4e24fa74fb65865d35953af9f3672e9a";
export const CODEBASE_DETECTION_SCHEMA_ID = "heniek://contract/CodebaseDetectionResult/v1";
export const CODEBASE_DETECTION_SCHEMA_SHA256 =
  "0ff6101822ed1ba516ea106ace09d8a6f15fd5c8c8a605bf6b788cb43355b210";
export const REGISTERED_CODEBASE_SCHEMA_ID = "heniek://contract/RegisteredCodebase/v1";
export const REGISTERED_CODEBASE_SCHEMA_SHA256 =
  "46aaf927a7b496d3da5b4c438c2f49ab7c6638363384cb0d6aca61fa0258b10f";
export const CODEBASE_ONBOARD_PROPOSE_RESULT_SCHEMA_ID =
  "heniek://contract/CodebaseOnboardProposeResult/v1";
export const CODEBASE_ONBOARD_PROPOSE_RESULT_SCHEMA_SHA256 =
  "a9e39c12bb7ca60bf6b1c7f758ea5067ca1d131d6dbd0274bbb6666399a85af9";
export const CODEBASE_ONBOARD_APPLY_RESULT_SCHEMA_ID =
  "heniek://contract/CodebaseOnboardApplyResult/v1";
export const CODEBASE_ONBOARD_APPLY_RESULT_SCHEMA_SHA256 =
  "33083526dd9864eb2cbe4338bfe3e460d2390c7de12480a070a41479f898606a";
export const STAGE_START_SCHEMA_ID = "heniek://contract/StageStartResult/v1";
export const STAGE_START_SCHEMA_SHA256 =
  "35776620780b4a150ab249801125096c4edfd9bfb8713c5c3e57e3d41c616341";
export const STAGE_START_V2_SCHEMA_ID = "heniek://contract/StageStartResult/v2";
export const STAGE_START_V2_SCHEMA_SHA256 =
  "f3b5fc903ec2b65c6541b16c753974f7dabd77c44eee941317cec492bd3be6cd";
export const RUN_STATUS_SCHEMA_ID = "heniek://contract/StageRunStatusResult/v1";
export const RUN_STATUS_SCHEMA_SHA256 =
  "69c0bd03d97d24dab4ee7b8b552b224ec23ddc5536db25e08bdd70b82a88fc79";
export const RUN_STATUS_V2_SCHEMA_ID = "heniek://contract/StageRunStatusResult/v2";
export const RUN_STATUS_V2_SCHEMA_SHA256 =
  "f9d6117ced1e9ecf64569e2a15285e13999d0d67cd28e83f6b909a7df0c15601";
export const RUN_STATUS_V3_SCHEMA_ID = "heniek://contract/StageRunStatusResult/v3";
export const RUN_STATUS_V3_SCHEMA_SHA256 =
  "4812a646b8cf1b9d4f7cabfca9e96c1fb8b24857caf3d48fc2c855ea8caa0eb4";
export const RUN_MUTATION_SCHEMA_ID = "heniek://contract/StageRunMutationResult/v1";
export const RUN_MUTATION_SCHEMA_SHA256 =
  "7491e0d1842751707d3658b7c71c058f1d2a6b1194d8c6752511b8293f1c9e3b";
export const RUN_ANSWER_V2_SCHEMA_ID = "heniek://contract/StageRunAnswerResult/v2";
export const RUN_ANSWER_V2_SCHEMA_SHA256 =
  "f2a8f8fc1020ec5371e769db12fe0aeaca865caa669077d7c35167a29efc265c";
export const RUN_RESUME_V2_SCHEMA_ID = "heniek://contract/StageRunResumeResult/v2";
export const RUN_RESUME_V2_SCHEMA_SHA256 =
  "39164d439fdce631fadae6a7baa7ca926d6c3fc76b76c25f8f9411e6da65b4c7";
export const INBOX_LIST_SCHEMA_ID = "heniek://contract/InteractionInboxResult/v1";
export const INBOX_LIST_SCHEMA_SHA256 =
  "5df66ed00d0e1f61793299773df14d61885013e5d234bcb533f69d16bac04428";
export const RUN_RESULT_SCHEMA_ID = "heniek://contract/StageRunResult/v1";
export const RUN_RESULT_SCHEMA_SHA256 =
  "8f0faffeabe166f355b7033e9a45b6cf2bae829d1ab64ab10f086fce501fc8fa";
export const RUN_RESULT_V2_SCHEMA_ID = "heniek://contract/StageRunResult/v2";
export const RUN_RESULT_V2_SCHEMA_SHA256 =
  "046a7e45967777b4ebb50bfb734207a8a369b90d50002768891e3e6d50f715d9";
export const ARTIFACT_GET_SCHEMA_ID = "heniek://contract/ArtifactGetResult/v1";
export const ARTIFACT_GET_SCHEMA_SHA256 =
  "f7b3994c57cb536a8bcca368a33c38d24d5ffafaf60144ce3382e89a03d38223";
export const DOCTOR_SCHEMA_ID = "heniek://contract/DoctorReport/v1";
export const DOCTOR_SCHEMA_SHA256 =
  "1645c1a617331955c3a515bd3942e423e71e3fbc460093092fc149b0cee6e56c";
export const DOCTOR_V2_SCHEMA_ID = "heniek://contract/DoctorReport/v2";
export const DOCTOR_V2_SCHEMA_SHA256 =
  "f0628f4e37b38cfd03042960f72927b0d36234a9a27df3f8222191ce79b93b11";
export const CAPABILITY_CATALOGUE_SCHEMA_ID = "heniek://contract/CapabilityCatalogue/v1";
export const CAPABILITY_CATALOGUE_SCHEMA_SHA256 =
  "5fe61be4e0fb222028c0078740e0b407250dddb911855a5dc14e15ed3a55a54c";

/**
 * Q023 additions. `StageRunStatusResult/v4` and `StageRunResult/v3` exist
 * only because `SchedulingDecision/v1` could not express four decision kinds
 * the scheduler has always written; v2/v3 stay pinned above and remain
 * selectable for any client that negotiated them.
 */
export const STAGE_START_V3_SCHEMA_ID = "heniek://contract/StageStartResult/v3";
export const STAGE_START_V3_SCHEMA_SHA256 =
  "d5af71ad48d08b715ebf38715e04186466414c1eb4723e13664244439c989715";
export const RUN_STATUS_V4_SCHEMA_ID = "heniek://contract/StageRunStatusResult/v4";
export const RUN_STATUS_V4_SCHEMA_SHA256 =
  "448d39bcafb560b28c47b04c07ae649e2053d7674e6ca6bd15d8ac448fd6ef09";
export const RUN_RESULT_V3_SCHEMA_ID = "heniek://contract/StageRunResult/v3";
export const RUN_RESULT_V3_SCHEMA_SHA256 =
  "0bcc4f412bf6574a4f75f26b77979fa6c56963497e8a16efc886bfd119959557";
export const PARENT_SESSION_ATTACH_SCHEMA_ID = "heniek://contract/ParentSessionAttachment/v1";
export const PARENT_SESSION_ATTACH_SCHEMA_SHA256 =
  "bdfc12500ea76159d46d9da097dc41569cbc0004df2dc55daa58088bcb2fc555";
export const PARENT_SESSION_DETACH_SCHEMA_ID = "heniek://contract/ParentSessionDetachResult/v1";
export const PARENT_SESSION_DETACH_SCHEMA_SHA256 =
  "a945c521166ae607a61052dcc1b3d93824dc327d2badf18546fea108dc1f90d1";
export const NATIVE_STAGE_POLL_SCHEMA_ID = "heniek://contract/NativeStagePollResult/v1";
export const NATIVE_STAGE_POLL_SCHEMA_SHA256 =
  "0e87c1f1fe5605faf0a1e1abf866c5771c3874234156bb11383e015019988e15";
export const NATIVE_STAGE_QUESTION_SCHEMA_ID = "heniek://contract/NativeStageQuestionResult/v1";
export const NATIVE_STAGE_QUESTION_SCHEMA_SHA256 =
  "04594a8c6786a0b580bcbe23bd5d961cd472ed1e7b05caff3c21f6474748b3be";
export const NATIVE_STAGE_SUBMIT_SCHEMA_ID = "heniek://contract/NativeStageSubmitResult/v1";
export const NATIVE_STAGE_SUBMIT_SCHEMA_SHA256 =
  "1acbf78f9cd4d1db91efab9ebef1f36afbba99609e096ce82d5fa315031483c5";
export const NATIVE_STAGE_STATUS_SCHEMA_ID = "heniek://contract/NativeStageStatusResult/v1";
export const NATIVE_STAGE_STATUS_SCHEMA_SHA256 =
  "18900c67f5cc173368e22f630e8f468ea7d98b834ad1997bd6ed8f8ce22bfa82";

/** Q032 pipeline admission RPCs — result schema pins from the contracts manifest. */
export const PIPELINE_VALIDATE_SCHEMA_ID = "heniek://contract/PipelineValidateResult/v1";
export const PIPELINE_VALIDATE_SCHEMA_SHA256 =
  "cc43b1eace8beb7509396232b797662871282cbf396da8c0b38561fc30ddd863";
export const PIPELINE_RUN_SCHEMA_ID = "heniek://contract/PipelineRunResult/v1";
export const PIPELINE_RUN_SCHEMA_SHA256 =
  "084191f330472f113e55bbc71ae9c75b7f961e1ae3b72993d32f0121a32817e1";
export const PIPELINE_ATTACH_SCHEMA_ID = "heniek://contract/PipelineAttachResult/v1";
export const PIPELINE_ATTACH_SCHEMA_SHA256 =
  "c2b7e4ef3d5a7b2cca929e307bb9b1d5a179f225310774bce0a5f7f966afd5a5";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function authMessage(challenge: Uint8Array, sequence: number, canonical: string): Uint8Array {
  const suffix = new TextEncoder().encode(`\n${sequence}\n${canonical}`);
  const message = new Uint8Array(challenge.length + suffix.length);
  message.set(challenge);
  message.set(suffix, challenge.length);
  return message;
}

/** Builds the one canonical request spelling this client emits. */
export function buildSignedRequest(
  credential: DaemonCredential,
  challenge: Uint8Array,
  id: JsonRpcId,
  method: string,
  sequence: number,
  params: Readonly<Record<string, unknown>> = {},
): string {
  const canonical = JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, params });
  const mac = createHmac("sha256", credential.secret)
    .update(authMessage(challenge, sequence, canonical))
    .digest("hex");
  return JSON.stringify({
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
    params: {
      ...params,
      auth: { schemaVersion: 1, keyId: credential.keyId, sequence, mac },
    },
  });
}

export function encodeRequest(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

export function zeroCredential(credential: DaemonCredential): void {
  credential.secret.fill(0);
}

export function credentialFromPersisted(value: string): DaemonCredential | undefined {
  const match = /^([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(value);
  if (match === null) {
    return undefined;
  }
  const keyId = match[1];
  const secretHex = match[2];
  if (keyId === undefined || secretHex === undefined) {
    return undefined;
  }
  return { keyId, secret: new Uint8Array(Buffer.from(secretHex, "hex")) };
}

export function toHex(bytes: Uint8Array): string {
  return hex(bytes);
}
