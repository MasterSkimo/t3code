import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE plotline_dags (
      dag_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX plotline_dags_project_idx ON plotline_dags(project_id, updated_at DESC)`;
});
