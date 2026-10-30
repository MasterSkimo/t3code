# Plotline Observer v1

Plotline is an optional, read-only view of T3 Code's native execution projection.

## Scope

- Shows the latest run of the selected T3 conversation and delegated tasks linked to that run.
- Uses T3's existing `runs` and `subagents` projection. Colors represent statuses recorded by T3.
- Lines represent recorded delegation only, **not** execution order or task dependencies.
- Task details display existing prompt/result text without submitting any command.
- Opens manually from **Right panel → + → Plotline**. It does not open automatically or change native orchestration.

This first version intentionally does not visualize a pre-execution DAG plan, descendants in other T3 threads, or model-inferred dependencies. Those require an upstream-supported source of plan metadata and should not be fabricated.

## Architecture

- `observerModel.ts`: pure read-only projection and graph layout
- `PlotlineObserver.tsx`: UI rendering using the existing live thread projection
- No additional server, MCP tool, event bus, background worker, SQLite table, migration, or provider hook
- No task scheduling, correction, acceptance, retry, or settlement behavior
- `rightPanelStore.ts`: one optional `plotline` panel surface
- `ChatView.tsx` and existing right-panel components: small UI registration

## Removing the extension

1. Remove `apps/web/src/components/plotline/`.
2. Remove the `plotline` surface registration from `rightPanelStore.ts`.
3. Remove the Plotline entries from `RightPanelTabs.tsx`, `RightPanelSurfaceContent.tsx`, and `ChatView.tsx`.

T3's native database and orchestration remain unchanged. Existing panel preferences can be reset without touching server data.

## Compatibility

This version targets the upstream baseline `pingdotgg/t3code@6575ce32508bd7908444241f3719aa33aaf77f90`. It intentionally does not import experimental Plotline/Harness schema or persistence from the old fork branches.
