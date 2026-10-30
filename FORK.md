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
