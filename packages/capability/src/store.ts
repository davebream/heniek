import {
  readLatestCapabilitySnapshot,
  type StateDatabase,
  writeCapabilitySnapshot,
} from "@heniek/state";
import type { CapabilitySnapshotStore } from "./types.js";

export function createStateCapabilitySnapshotStore(
  database: StateDatabase,
): CapabilitySnapshotStore {
  return {
    readLatest(engine, accountId) {
      return readLatestCapabilitySnapshot(database, engine, accountId);
    },
    write(entry) {
      writeCapabilitySnapshot(database, entry);
    },
  };
}
