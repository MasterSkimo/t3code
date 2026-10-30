import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE harness_root_candidates (
    event_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT,
    root_thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    event_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    failure_detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX harness_root_candidates_pending_idx ON harness_root_candidates(status, created_at)`;
});
