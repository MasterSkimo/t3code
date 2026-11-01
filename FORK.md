# Fork extensions

This fork follows upstream `pingdotgg/t3code`. Fork-specific data and migrations stay in `<stateDir>/fork.sqlite`, **not** in T3's `statev2.sqlite`.

Inspired by the [isolated storage design in drKreshel/t3code](https://github.com/drKreshel/t3code/blob/main/FORK.md).

## Isolation rules

- Native T3 orchestrator, providers, dispatch, run lifecycle and migration registry remain untouched.
- All fork database migrations are append-only, versioned under `apps/server/src/fork/migrations/`.
- `apps/server/src/fork/ForkDatabase.ts` owns the secondary connection and its `fork_schema_migrations` table.
- Each extension exposes a service using that connection, never a fork-owned `SqlClient` in upstream code.
- Fork features are observers unless explicitly designed otherwise; errors must not change agent execution.

## Plotline observer

- Table: `fork_plotline_dag_snapshots` (thread/run-keyed DAG snapshots).
- Service: `apps/server/src/plotline/PlotlineStore.ts`.
- Wire contract: `packages/contracts/src/plotlineObserver.ts`.
- UI and recorder: `apps/web/src/components/plotline/`.

**Upstream touchpoints:** `server.ts` (service layer), `ws.ts` (two RPC handlers), `RpcAuthorization.ts` (scope enforcement), `RpcInstrumentation.ts` (request metrics), `packages/contracts/src/{index,rpc}.ts` (RPC contracts), and four right-panel registration files in `apps/web/`.

No upstream migration file is modified. The entire extension can be deleted without rewriting the main SQLite database. Stop T3 before deleting `fork.sqlite` and its journal files.

## Current limitations

Snapshots are recorded while their conversation projection is loaded in the UI. No background server-wide snapshotter is installed. The graph shows native runs/delegations, not a model-inferred task plan. No legacy Plotline DAG migration or Harness logic is included.

## Dynamic task plans (fork migration 002)

Terra initializes one task plan per root conversation. Workers discover nested tasks; the
plan evolves independently of T3's run execution and native delegation metadata.

- `fork_plotline_plans`: revisioned JSON plan keyed by `root_thread_id`.
- `fork_plotline_plan_events`: append-only mutation receipts per `request_id`; concurrent
  updates are wrapped in a single SQLite transaction and are idempotent.
- `plotline_plan_create`: initial tasks and dependency IDs (root orchestrator only).
- `plotline_task_add`: append a new task (workers only under an assigned/owned task).
- `plotline_task_update`: revise details/prerequisites or mark skipped/cancelled with a reason.
- `plotline_task_bind`: the delegating agent binds the actual T3 delegated `taskId` to its owned plan node.
  The server verifies the native task exists and derives the child thread ID itself.
- Browser view uses the existing authenticated `plotline.plan.get` RPC and refreshes while open.

**The tools only update plan metadata.** They cannot start, stop, retry, verify or settle native
T3 work. Execution state and model information come from native T3 subagent records, including
older runs in the same conversation. Unbound native delegations remain visible.

Solid connectors show hierarchy. Dashed connectors show functional prerequisites. Invalid
dependencies, duplicate IDs, cycles and unrelated worker edits are rejected. The plan remains
visible before any delegation, including tasks marked skipped or cancelled.

Provider instructions mention the tools **only when the user requested Plotline/DAG tracking**.
The existing unplanned conversation observer remains the fallback when no plan is initialized.
