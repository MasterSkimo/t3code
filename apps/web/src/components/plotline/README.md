# Plotline Observer v1 — isolated persistence

Plotline is an optional, read-only view of T3 Code's execution data. It never schedules, verifies, corrects or settles a T3 run.

## Persistence

Based on the isolated database approach used by [drKreshel/t3code](https://github.com/drKreshel/t3code/blob/main/apps/server/src/fork/ForkDatabase.ts).

- SQLite file: `<T3 stateDir>/plotline.sqlite` (beside upstream `statev2.sqlite`).
- Migration history: `plotline_schema_migrations`, **not** `effect_sql_migrations`.
- Append-only migration scripts: `apps/server/src/plotline/migrations/001_DagSnapshots.ts`.
- Table: `plotline_dag_snapshots`, keyed by `(thread_id, run_id)`.
- Full saved graph: nodes, delegation edges, recorded status, model and bounded prompt/result excerpts.
- Existing native T3 migration registry and T3 SQLite tables are unchanged.
- The database is owned by the fork, and deleting it resets Plotline history only.

## Recording

`PlotlineRecorder` observes the current conversation's native T3 projection while it is loaded in the web UI, independently of whether the Plotline panel is open. It debounces updates and upserts snapshots using an authenticated `plotline.observer.save` RPC. Saved runs can be loaded after restart using `plotline.observer.list`. The right panel displays **Live** or a saved run, and offers a reload button.

**Limitations:** Recording currently occurs for a conversation loaded in the UI, not for closed/background conversations. This stores *observed execution DAGs*, not future tasks invented by the model or old Plotline-managed acceptance data. Relationships are native T3 delegation links; sibling placement does not imply dependencies. No legacy `.t3` migration/import is provided.

## Files

- `apps/server/src/plotline/PlotlineDatabase.ts`: isolated SQLite connection and migration runner
- `apps/server/src/plotline/migrations/`: append-only schema scripts
- `apps/server/src/plotline/PlotlineStore.ts`: list/save operations
- `packages/contracts/src/plotlineObserver.ts`: versioned wire shape and RPC method identifiers
- `apps/web/src/components/plotline/`: graph, recorder and tests
- `apps/web/src/state/plotline.ts`: authenticated environment RPC adapter

## Upstream patches

The integration touches only UI registrations in `ChatView.tsx`, `RightPanelTabs.tsx`, `RightPanelSurfaceContent.tsx` and `rightPanelStore.ts`, plus small registrations in server startup, WS RPC, contracts, authorization and request metrics.

**No changes** to T3 orchestrator, providers, native migration scripts, native event persistence or command dispatch. Native agent work proceeds even if a Plotline save fails.

## Removal

Delete Plotline-owned files and revert the small imports/registrations listed above. Remove the `plotline.sqlite` file (and any `-wal`/`-shm` companions) only when the T3 server is stopped. No upstream state migration or repair is required.
