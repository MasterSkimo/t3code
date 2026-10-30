import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE harness_proposals (
    proposal_id TEXT PRIMARY KEY NOT NULL,
    scope_key TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX harness_proposals_scope_status_idx ON harness_proposals(scope_key, status, updated_at DESC)`;
  yield* sql`CREATE TABLE harness_audit (
    audit_id TEXT PRIMARY KEY NOT NULL,
    proposal_id TEXT NOT NULL REFERENCES harness_proposals(proposal_id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    at TEXT NOT NULL,
    note TEXT,
    proposal_status TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX harness_audit_proposal_idx ON harness_audit(proposal_id, at DESC)`;
  yield* sql`CREATE TABLE harness_defaults (
    scope_key TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE harness_analysis_budget (
    scope_key TEXT NOT NULL,
    day_key TEXT NOT NULL,
    analyses INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope_key, day_key)
  )`;
  yield* sql`CREATE TABLE harness_analysis_attempts (
    scope_key TEXT NOT NULL,
    day_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    PRIMARY KEY (scope_key, day_key, request_id)
  )`;
});
