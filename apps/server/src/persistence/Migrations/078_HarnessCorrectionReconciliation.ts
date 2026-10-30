import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE harness_opencode_reconciliation
    ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'opencode_run'`;
  yield* sql`CREATE INDEX harness_reconciliation_kind_due_idx
    ON harness_opencode_reconciliation(event_kind, status, next_attempt_at, sequence)`;
});
