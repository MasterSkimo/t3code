/**
 * Fork-only migration 002. The plan is independent of native execution and can
 * be deleted without touching T3's own database or its migration history.
 */
export const VERSION = 2;
export const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE fork_plotline_plans (
    root_thread_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE fork_plotline_plan_events (
    root_thread_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    actor_thread_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(root_thread_id, request_id),
    UNIQUE(root_thread_id, revision)
  )`,
  `CREATE INDEX fork_plotline_plan_events_thread_revision
    ON fork_plotline_plan_events(root_thread_id, revision)`,
];
