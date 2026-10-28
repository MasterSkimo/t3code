import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE harness_mcp_deployments (
    deployment_id TEXT PRIMARY KEY NOT NULL,
    source_resource_id TEXT NOT NULL,
    source_scope TEXT NOT NULL,
    source_project_id TEXT NOT NULL,
    target_provider TEXT NOT NULL,
    target_scope TEXT NOT NULL,
    target_project_id TEXT NOT NULL,
    server_name TEXT NOT NULL,
    configuration_fingerprint TEXT NOT NULL,
    tracking_origin TEXT NOT NULL,
    pending_fingerprint TEXT,
    pending_is_new INTEGER NOT NULL DEFAULT 0,
    tracked_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (target_provider, target_scope, target_project_id, server_name)
  )`;
  yield* sql`CREATE INDEX harness_mcp_deployments_source_idx ON harness_mcp_deployments(source_resource_id, updated_at DESC)`;
});
