import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE harness_opencode_reconciliation ADD COLUMN next_attempt_at TEXT`;
  yield* sql`UPDATE harness_opencode_reconciliation SET next_attempt_at = CURRENT_TIMESTAMP
    WHERE status IN ('pending', 'failed')`;
  yield* sql`CREATE INDEX harness_opencode_reconciliation_due_idx
    ON harness_opencode_reconciliation(status, next_attempt_at, sequence)`;
});
