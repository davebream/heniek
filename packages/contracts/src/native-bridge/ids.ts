import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

/**
 * One attached parent Claude Code session. Minted fresh by every
 * `parentSession.attach` — a reattach never reuses the previous id, so the
 * session id *is* the binding token and there is no second epoch counter
 * that could disagree with it (ADR 0021 D3).
 *
 * Scoped to a codebase, never to a transcript: §9.5 allows a native stage to
 * be dispatched by *a* later Claude session, not by the one that started it.
 */
export const ParentSessionId = defineIdNamespace("ParentSessionId");
export type ParentSessionId = Static<typeof ParentSessionId>;

/**
 * One handing-over of a native stage attempt to an attached session. The
 * unit the daemon fences on: a dispatch is bound to exactly one attempt, is
 * settled at most once, and carries a `revision` that every rebind bumps.
 */
export const NativeDispatchId = defineIdNamespace("NativeDispatchId");
export type NativeDispatchId = Static<typeof NativeDispatchId>;

/**
 * Client-minted idempotency key for a terminal submission, following
 * `execution_operation_outbox.operation_id` rather than a payload digest: a
 * digest answers "same bytes?" when the question is "same intent?". A retry
 * whose payload differs only in an incidental field must still be
 * recognised as the same submission, and two genuinely distinct submissions
 * that happen to serialise identically must not be silently collapsed.
 *
 * The caller must persist this before its first send — a key minted afresh
 * after a client crash defeats the mechanism entirely.
 */
export const NativeSubmissionId = defineIdNamespace("NativeSubmissionId");
export type NativeSubmissionId = Static<typeof NativeSubmissionId>;
