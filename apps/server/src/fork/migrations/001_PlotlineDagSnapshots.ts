/**
 * Fork migration 001: Plotline DAG snapshots. Never add it to T3's Migrations.ts.
 * Once released, append new migration files instead of editing shipped versions.
 */
export const VERSION = 1;

export const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE fork_plotline_dag_snapshots (
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, run_id)
  )`,
  `CREATE INDEX fork_plotline_dag_snapshots_thread_recent
    ON fork_plotline_dag_snapshots(thread_id, updated_at DESC)`,
];
