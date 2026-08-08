import type { InteractionV2, PendingInteractionV2 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import type { StateDatabase } from "../database/open.js";
import { internalHandle } from "../database/open.js";
import { toSafeInteger, toText } from "../database/pragma.js";
import { StateDatabaseCorruptionError } from "../errors.js";
import type { StateEvent } from "../journal/event.js";
import { readEvents } from "../journal/read.js";
import { canonicalizeBackendInteraction } from "./store.js";

type Interaction = Static<typeof InteractionV2>;

export interface ReplayedInteractionProjection {
  readonly runId: string;
  readonly interactionId: string;
  readonly state: Interaction["status"];
  readonly revision: number;
  readonly deliveryState: Interaction["deliveryState"];
  readonly cancellationReason: Interaction["cancellationReason"] | null;
  readonly lastEventSequence: number;
  readonly updatedAt: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StateDatabaseCorruptionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function interactionId(event: StateEvent, payload: Record<string, unknown>): string {
  if (typeof payload.interactionId !== "string" || payload.interactionId.length === 0) {
    throw new StateDatabaseCorruptionError(`${event.type} has no interaction id`);
  }
  return payload.interactionId;
}

export function replayInteractionEvents(
  events: readonly StateEvent[],
): Readonly<Record<string, ReplayedInteractionProjection>> {
  const projections: Record<string, ReplayedInteractionProjection> = {};
  for (const event of events) {
    if (!event.type.startsWith("interaction.")) continue;
    if (event.runId === null) {
      throw new StateDatabaseCorruptionError(`${event.type} has no run id`);
    }
    const payload = object(event.payload, `${event.type} payload`);
    const id = interactionId(event, payload);
    const key = `${event.runId}\u0000${id}`;
    const previous = projections[key];
    switch (event.type) {
      case "interaction.created": {
        if (previous !== undefined) {
          throw new StateDatabaseCorruptionError(`interaction was created twice: ${id}`);
        }
        if (payload.interaction !== undefined) {
          object(payload.interaction, "canonical interaction");
        } else {
          canonicalizeBackendInteraction(
            payload.sourcePayload as Static<typeof PendingInteractionV2>,
          );
        }
        projections[key] = {
          runId: event.runId,
          interactionId: id,
          state: "pending",
          revision: 1,
          deliveryState: "not_applicable",
          cancellationReason: null,
          lastEventSequence: event.sequence,
          updatedAt: event.recordedAt,
        };
        break;
      }
      case "interaction.answer_accepted": {
        if (previous === undefined || previous.state !== "pending") {
          throw new StateDatabaseCorruptionError(
            `answer does not target a pending interaction: ${id}`,
          );
        }
        projections[key] = {
          ...previous,
          state: "answered",
          revision: previous.revision + 1,
          deliveryState: payload.migrationVersion === 9 ? "delivered" : "pending",
          cancellationReason: null,
          lastEventSequence: event.sequence,
          updatedAt: event.recordedAt,
        };
        break;
      }
      case "interaction.cancelled": {
        if (previous === undefined || previous.state !== "pending") {
          throw new StateDatabaseCorruptionError(
            `cancellation does not target a pending interaction: ${id}`,
          );
        }
        const reason = payload.reason;
        if (
          reason !== "withdrawn" &&
          reason !== "timed_out" &&
          reason !== "run_terminal" &&
          reason !== "migration_unresolved"
        ) {
          throw new StateDatabaseCorruptionError(
            `interaction cancellation reason is invalid: ${id}`,
          );
        }
        projections[key] = {
          ...previous,
          state: "cancelled",
          revision: previous.revision + 1,
          deliveryState: "not_applicable",
          cancellationReason: reason,
          lastEventSequence: event.sequence,
          updatedAt: event.recordedAt,
        };
        break;
      }
      case "interaction.answer_delivered": {
        if (
          previous === undefined ||
          previous.state !== "answered" ||
          previous.deliveryState !== "pending"
        ) {
          throw new StateDatabaseCorruptionError(
            `delivery does not target an accepted answer: ${id}`,
          );
        }
        projections[key] = {
          ...previous,
          revision: previous.revision + 1,
          deliveryState: "delivered",
          lastEventSequence: event.sequence,
          updatedAt: event.recordedAt,
        };
        break;
      }
      default:
        throw new StateDatabaseCorruptionError(`unknown interaction event: ${event.type}`);
    }
  }
  return projections;
}

export function compareInteractionProjectionToJournal(db: StateDatabase): {
  readonly status: "exact" | "diverged";
  readonly divergences: readonly string[];
} {
  const replayed = replayInteractionEvents(readEvents(db));
  const stored = internalHandle(db)
    .prepare(
      `SELECT run_id, interaction_id, state, revision, delivery_state,
              cancellation_reason, last_event_sequence, updated_at
         FROM pending_interaction_projection
        ORDER BY run_id, interaction_id`,
    )
    .all();
  const divergences: string[] = [];
  const seen = new Set<string>();
  for (const raw of stored) {
    const runId = toText(raw.run_id, "pending_interaction_projection.run_id");
    const id = toText(raw.interaction_id, "pending_interaction_projection.interaction_id");
    const key = `${runId}\u0000${id}`;
    seen.add(key);
    const expected = replayed[key];
    if (expected === undefined) {
      divergences.push(`stored-only:${runId}/${id}`);
      continue;
    }
    const actual = {
      state: toText(raw.state, "pending_interaction_projection.state"),
      revision: toSafeInteger(raw.revision, "pending_interaction_projection.revision"),
      deliveryState: toText(raw.delivery_state, "pending_interaction_projection.delivery_state"),
      cancellationReason: raw.cancellation_reason,
      lastEventSequence: toSafeInteger(
        raw.last_event_sequence,
        "pending_interaction_projection.last_event_sequence",
      ),
      updatedAt: toText(raw.updated_at, "pending_interaction_projection.updated_at"),
    };
    if (
      actual.state !== expected.state ||
      actual.revision !== expected.revision ||
      actual.deliveryState !== expected.deliveryState ||
      actual.cancellationReason !== expected.cancellationReason ||
      actual.lastEventSequence !== expected.lastEventSequence ||
      actual.updatedAt !== expected.updatedAt
    ) {
      divergences.push(`mismatch:${runId}/${id}`);
    }
  }
  for (const [key, value] of Object.entries(replayed)) {
    if (!seen.has(key)) divergences.push(`replay-only:${value.runId}/${value.interactionId}`);
  }
  return { status: divergences.length === 0 ? "exact" : "diverged", divergences };
}
