import type {
  VariantIntegrationTrace,
  WorkspaceId,
  WorkspaceVariantId,
  WorkspaceVariantManifest,
} from "@heniek/contracts";
import type { StateDatabase } from "../database/open.js";
import { internalHandle } from "../database/open.js";

interface VariantRow {
  readonly manifest_json: string;
  readonly revision: number;
}

export interface WorkspaceVariantStateStore {
  load(
    workspaceId: WorkspaceId,
    variantId: WorkspaceVariantId,
  ): Promise<WorkspaceVariantManifest | undefined>;
  record(manifest: WorkspaceVariantManifest): Promise<void>;
  append(trace: VariantIntegrationTrace): Promise<void>;
  list(workspaceId: WorkspaceId): readonly WorkspaceVariantManifest[];
  traces(variantId: WorkspaceVariantId): readonly VariantIntegrationTrace[];
  nextSequence(workspaceId: WorkspaceId, variantId: WorkspaceVariantId): Promise<number>;
}

export function createWorkspaceVariantStateStore(db: StateDatabase): WorkspaceVariantStateStore {
  const handle = internalHandle(db);
  return {
    async load(workspaceId, variantId) {
      const row = handle
        .prepare(
          "SELECT manifest_json, revision FROM workspace_variant_projection WHERE variant_id = ? AND workspace_id = ?",
        )
        .get(variantId, workspaceId) as VariantRow | undefined;
      return row === undefined
        ? undefined
        : (JSON.parse(row.manifest_json) as WorkspaceVariantManifest);
    },
    async record(manifest) {
      const previous = handle
        .prepare("SELECT revision FROM workspace_variant_projection WHERE variant_id = ?")
        .get(manifest.variantId) as Pick<VariantRow, "revision"> | undefined;
      const revision = (previous?.revision ?? 0) + 1;
      if (previous === undefined) {
        handle
          .prepare(`INSERT INTO workspace_variant_projection
            (variant_id, workspace_id, lifecycle_status, revision, manifest_json, updated_at)
            VALUES (?, ?, ?, 1, ?, ?)`)
          .run(
            manifest.variantId,
            manifest.workspaceId,
            manifest.lifecycle,
            JSON.stringify(manifest),
            manifest.updatedAt,
          );
      } else {
        handle
          .prepare(`UPDATE workspace_variant_projection SET
            lifecycle_status = ?, revision = ?, manifest_json = ?, updated_at = ?
            WHERE variant_id = ? AND workspace_id = ? AND revision = ?`)
          .run(
            manifest.lifecycle,
            revision,
            JSON.stringify(manifest),
            manifest.updatedAt,
            manifest.variantId,
            manifest.workspaceId,
            previous.revision,
          );
      }
    },
    async append(trace) {
      handle
        .prepare(`INSERT INTO workspace_variant_integration_trace
          (variant_id, sequence, trace_json, recorded_at) VALUES (?, ?, ?, ?)`)
        .run(trace.variantId, trace.sequence, JSON.stringify(trace), trace.recordedAt);
    },
    list(workspaceId) {
      return (
        handle
          .prepare(
            "SELECT manifest_json FROM workspace_variant_projection WHERE workspace_id = ? ORDER BY variant_id",
          )
          .all(workspaceId) as { manifest_json: string }[]
      ).map((row) => JSON.parse(row.manifest_json) as WorkspaceVariantManifest);
    },
    traces(variantId) {
      return (
        handle
          .prepare(
            "SELECT trace_json FROM workspace_variant_integration_trace WHERE variant_id = ? ORDER BY sequence",
          )
          .all(variantId) as { trace_json: string }[]
      ).map((row) => JSON.parse(row.trace_json) as VariantIntegrationTrace);
    },
    async nextSequence(_workspaceId, variantId) {
      const row = internalHandle(db)
        .prepare(
          "SELECT max(sequence) AS sequence FROM workspace_variant_integration_trace WHERE variant_id = ?",
        )
        .get(variantId) as { sequence: number | null };
      return (row.sequence ?? 0) + 1;
    },
  };
}
