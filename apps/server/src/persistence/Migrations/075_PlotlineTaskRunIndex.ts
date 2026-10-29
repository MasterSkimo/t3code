import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { PlotlineDag } from "@t3tools/contracts";

const decodeDag = Schema.decodeUnknownSync(Schema.fromJsonString(PlotlineDag));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE plotline_task_run_index (
      project_id TEXT NOT NULL,
      dag_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      PRIMARY KEY (project_id, dag_id, task_id)
    )
  `;
  yield* sql`CREATE INDEX plotline_task_run_lookup_idx ON plotline_task_run_index(thread_id, run_id)`;
  const rows = yield* sql<{
    readonly dag_id: string;
    readonly project_id: string;
    readonly payload_json: string;
  }>`
    SELECT dag_id, project_id, payload_json FROM plotline_dags
  `;
  for (const row of rows) {
    const decoded = yield* Effect.try({
      try: () => decodeDag(row.payload_json),
      catch: (cause) => ({
        _tag: "MalformedPlotlineDagMigration",
        dagId: row.dag_id,
        message: `Cannot migrate Plotline DAG '${row.dag_id}': persisted payload is malformed.`,
        cause,
      }),
    });
    for (const task of decoded.tasks) {
      if (task.threadId === null || task.runId === null) continue;
      yield* sql`INSERT INTO plotline_task_run_index (project_id, dag_id, task_id, thread_id, run_id)
        VALUES (${row.project_id}, ${row.dag_id}, ${task.id}, ${task.threadId}, ${task.runId})
        ON CONFLICT(project_id, dag_id, task_id) DO UPDATE SET thread_id = excluded.thread_id, run_id = excluded.run_id`;
    }
  }
});
