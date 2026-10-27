import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE harness_event_cursor (
    consumer_id TEXT PRIMARY KEY NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT INTO harness_event_cursor (consumer_id, sequence) VALUES ('significant-events', 0)`;
  yield* sql`CREATE TABLE harness_significant_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    sequence INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'pending',
    delivery_attempts INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX harness_significant_events_sequence_idx ON harness_significant_events(sequence DESC)`;
  yield* sql`CREATE TABLE harness_significant_event_dedupe (
    signal_id TEXT PRIMARY KEY NOT NULL,
    sequence INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX harness_significant_event_dedupe_sequence_idx ON harness_significant_event_dedupe(sequence DESC)`;
  yield* sql`ALTER TABLE harness_analysis_attempts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`;
});
