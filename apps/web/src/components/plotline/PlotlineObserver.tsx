import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import { plotlineEnvironment } from "../../state/plotline";
import { useEnvironmentQuery } from "../../state/query";
import { CheckCircle2, Circle, GitFork, LoaderCircle, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  layoutExecutionGraph,
  OBSERVER_NODE_HEIGHT,
  OBSERVER_NODE_WIDTH,
  projectExecutionGraph,
  projectDynamicPlan,
  type ObservedTask,
} from "./observerModel";

/**
 * Read-only execution observer. T3 owns all delegation, scheduling, completion,
 * and persistence; this component only renders the current thread projection.
 */
function statusStyle(status: string): string {
  switch (status) {
    case "completed":
      return "text-emerald-600 dark:text-emerald-400";
    case "skipped":
      return "text-muted-foreground";
    case "cancelled":
      return "text-amber-600 dark:text-amber-400";
    case "running":
      return "text-sky-600 dark:text-sky-400";
    case "failed":
    case "interrupted":
      return "text-rose-600 dark:text-rose-400";
    default:
      return "text-muted-foreground";
  }
}

function StatusIcon({ status }: { readonly status: string }) {
  const style = `size-3.5 shrink-0 ${statusStyle(status)}`;
  if (status === "completed") return <CheckCircle2 className={style} />;
  if (status === "running") return <LoaderCircle className={style} />;
  if (["failed", "cancelled", "interrupted"].includes(status))
    return <XCircle className={style} />;
  return <Circle className={style} />;
}

function ObservedNodeCard({
  node,
  selected,
  onSelect,
}: {
  readonly node: ObservedTask;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex h-full w-full flex-col gap-2 overflow-hidden rounded-xl border bg-card p-3 text-left shadow-sm transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${selected ? "border-primary ring-1 ring-primary" : "border-border"}`}
    >
      <div className="flex w-full min-w-0 items-center justify-between gap-2">
        <span className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {node.kind === "run" ? "Conversation" : node.kind === "plan" ? "Planned task" : "Subagent"}
        </span>
        <span className="flex items-center gap-1 text-[10px]">
          <StatusIcon status={node.status} />
          <span className={statusStyle(node.status)}>{node.status}</span>
        </span>
      </div>
      <div className="line-clamp-2 min-w-0 text-xs font-semibold leading-relaxed">{node.title}</div>
      <div className="truncate text-[10px] text-muted-foreground">{node.provider ?? "Model unavailable"}</div>
    </button>
  );
}

export function PlotlineObserver({
  projection,
  threadRef,
}: {
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly threadRef: ScopedThreadRef;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("live");
  const saved = useEnvironmentQuery(plotlineEnvironment.list({
    environmentId: threadRef.environmentId,
    input: { threadId: String(threadRef.threadId) },
  }));
  const planQuery = useEnvironmentQuery(plotlineEnvironment.plan({
    environmentId: threadRef.environmentId,
    input: { rootThreadId: String(threadRef.threadId) },
  }));
  const plan = selectedRunId === "live" ? planQuery.data?.plan ?? null : null;
  useEffect(() => {
    // Refresh only the observed plan, never T3's orchestration.
    const timer = setInterval(() => planQuery.refresh(), 2500);
    return () => clearInterval(timer);
  }, [planQuery.refresh, threadRef.threadId]);
  const history = saved.data?.dags ?? [];
  const stored = history.find((dag) => dag.runId === selectedRunId);
  const live = plan
    ? projectDynamicPlan(plan, projection)
    : { nodes: projectExecutionGraph(projection), dependencies: [] };
  const nodes = stored?.nodes ?? live.nodes;
  const dependencyEdges = stored ? [] : live.dependencies;
  const graph = layoutExecutionGraph(nodes, dependencyEdges);
  const coordinates = new Map(graph.positions.map((item) => [item.node.id, item]));
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  const running = nodes.filter((node) => ["running", "waiting"].includes(node.status)).length;
  const completed = nodes.filter((node) => node.status === "completed").length;
  const failed = nodes.filter((node) => ["failed", "interrupted"].includes(node.status)).length;
  const skipped = nodes.filter((node) => ["skipped", "cancelled"].includes(node.status)).length;
  const delegated = selectedRunId === "live"
    ? (projection?.subagents.length ?? 0)
    : Math.max(0, nodes.length - 1);

  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground" aria-label="Plotline execution observer">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <GitFork className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">Plotline</h2>
              <p className="text-[11px] text-muted-foreground">Execution observer · read only</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <select
              aria-label="Plotline run history"
              value={selectedRunId}
              onChange={(event) => {
                setSelectedRunId(event.target.value);
                setSelectedId(null);
              }}
              className="max-w-32 rounded-md border border-border bg-background px-2 py-1 text-[11px]"
            >
              <option value="live">Live</option>
              {history.map((dag) => (
                <option key={dag.runId} value={dag.runId}>
                  {dag.title} · {dag.runId.slice(-16)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => { saved.refresh(); planQuery.refresh(); }}
              className="rounded-md border border-border px-2 py-1 text-[11px]"
              title="Reload saved DAGs"
            >
              Reload
            </button>
          </div>
        </div>
        {saved.error ? <p role="status" className="mt-2 text-xs text-rose-600">{saved.error}</p> : null}
        {planQuery.error ? <p role="status" className="mt-2 text-xs text-rose-600">{planQuery.error}</p> : null}
        {plan ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Plan revision {plan.revision} · {plan.tasks.length} tasks · dependencies shown as dashed lines
          </p>
        ) : null}
        {nodes.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            {plan ? <span>{plan.tasks.length} planned</span> : null}
            <span>{delegated} delegated</span>
            <span>{running} active</span>
            <span>{completed} completed</span>
            {failed > 0 ? <span>{failed} failed/interrupted</span> : null}
            {skipped > 0 ? <span>{skipped} skipped/cancelled</span> : null}
          </div>
        ) : null}
      </header>

      {nodes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <GitFork className="size-7 text-muted-foreground/60" />
          <p className="text-sm font-medium">No execution yet</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            T3 runs and delegated tasks appear here as they are recorded. Plotline never starts or changes a task.
          </p>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto bg-muted/15" aria-label="Execution graph">
            <div className="relative mx-auto" style={{ width: graph.width, height: graph.height }}>
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 text-border"
                width={graph.width}
                height={graph.height}
                viewBox={`0 0 ${graph.width} ${graph.height}`}
              >
                {[...graph.edges.map((edge) => ({ ...edge, relation: "parent" as const })),
                  ...dependencyEdges.map((edge) => ({ ...edge, relation: "dependency" as const }))]
                  .map((edge) => {
                  const from = coordinates.get(edge.from);
                  const to = coordinates.get(edge.to);
                  if (!from || !to) return null;
                  const startX = from.x + OBSERVER_NODE_WIDTH / 2;
                  const startY = from.y + OBSERVER_NODE_HEIGHT;
                  const endX = to.x + OBSERVER_NODE_WIDTH / 2;
                  const endY = to.y;
                  const middleY = startY + (endY - startY) / 2;
                  return (
                    <path
                      key={`${edge.from}:${edge.to}`}
                      d={`M ${startX} ${startY} V ${middleY} H ${endX} V ${endY}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeDasharray={edge.relation === "dependency" ? "5 5" : undefined}
                      opacity={edge.relation === "dependency" ? 0.65 : 1}
                    />
                  );
                })}
              </svg>
              {graph.positions.map(({ node, x, y }) => (
                <div
                  key={node.id}
                  className="absolute"
                  style={{ left: x, top: y, width: OBSERVER_NODE_WIDTH, height: OBSERVER_NODE_HEIGHT }}
                >
                  <ObservedNodeCard
                    node={node}
                    selected={selected?.id === node.id}
                    onSelect={() => setSelectedId(node.id)}
                  />
                </div>
              ))}
            </div>
          </div>
          <footer className="max-h-44 shrink-0 overflow-auto border-t border-border px-4 py-3">
            {selected ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <StatusIcon status={selected.status} />
                  <span>{selected.title}</span>
                </div>
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {selected.result?.trim() || selected.detail || "No result recorded"}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Select a node to inspect it. Solid lines indicate ownership; dashed lines indicate plan dependencies.
              </p>
            )}
          </footer>
        </>
      )}
    </section>
  );
}
