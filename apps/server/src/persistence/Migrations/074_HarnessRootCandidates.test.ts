import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0074 from "./074_HarnessRootCandidates.ts";

it.effect("creates an idempotent durable root candidate queue", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Migration0074;
    const eventJson = '{"id":"success:root-event","sourceRefs":["event:1","run:1"]}';
    yield* sql`INSERT INTO harness_root_candidates (event_id, project_id, root_thread_id, run_id, event_json, created_at, updated_at)
      VALUES ('success:root-event', 'project:1', 'thread:root', 'run:1', ${eventJson}, '2026-01-01', '2026-01-01')`;
    yield* sql`INSERT INTO harness_root_candidates (event_id, project_id, root_thread_id, run_id, event_json, created_at, updated_at)
      VALUES ('success:root-event', 'project:1', 'thread:root', 'run:1', ${eventJson}, '2026-01-01', '2026-01-01') ON CONFLICT(event_id) DO NOTHING`;
    const rows = yield* sql<{
      readonly event_id: string;
      readonly status: string;
      readonly delivery_attempts: number;
      readonly run_id: string;
      readonly event_json: string;
    }>`SELECT event_id, status, delivery_attempts, run_id, event_json FROM harness_root_candidates`;
    assert.deepStrictEqual(rows, [
      {
        event_id: "success:root-event",
        status: "pending",
        delivery_attempts: 0,
        run_id: "run:1",
        event_json: eventJson,
      },
    ]);
    yield* sql`UPDATE harness_root_candidates SET delivery_attempts = delivery_attempts + 1,
      status = CASE WHEN delivery_attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
      failure_detail = 'projection missing' WHERE event_id = 'success:root-event'`;
    yield* sql`UPDATE harness_root_candidates SET delivery_attempts = delivery_attempts + 1,
      status = CASE WHEN delivery_attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
      failure_detail = 'projection missing' WHERE event_id = 'success:root-event'`;
    yield* sql`UPDATE harness_root_candidates SET delivery_attempts = delivery_attempts + 1,
      status = CASE WHEN delivery_attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
      failure_detail = 'projection missing' WHERE event_id = 'success:root-event'`;
    const failed = yield* sql<{
      readonly status: string;
      readonly delivery_attempts: number;
      readonly failure_detail: string;
    }>`SELECT status, delivery_attempts, failure_detail FROM harness_root_candidates`;
    assert.deepStrictEqual(failed, [
      { status: "failed", delivery_attempts: 3, failure_detail: "projection missing" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
