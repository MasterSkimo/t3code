import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import { plotlineEnvironment } from "../../state/plotline";
import { useEnvironmentQuery } from "../../state/query";
import { CheckCircle2, Circle, CornerDownRight, Download, GitFork, LoaderCircle, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  layoutExecutionGraph,
  OBSERVER_NODE_HEIGHT,
  OBSERVER_NODE_WIDTH,
  projectExecutionGraph,
  projectDynamicPlan,
  summarizePlanProgress,
  type ObservedTask,
} from "./observerModel";
import { downloadPlotlinePng, isDarkPlotlineSurface } from "./plotlinePng";
import { plotlineRoutePath, routePlotlineEdges } from "./observerRouting";

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
  const isSubtask = node.kind === "plan" && node.isSubtask === true;
  const typeStyle = isSubtask
    ? "w-[calc(100%-20px)] border-violet-500/65 bg-violet-500/[0.08] border-l-[3px] border-l-violet-500 dark:bg-violet-500/[0.12]"
    : node.kind === "plan"
      ? "border-sky-500/50 bg-sky-500/[0.04] dark:bg-sky-500/[0.07]"
      : "border-border bg-card";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`mx-auto flex h-full flex-col gap-2 overflow-hidden border p-3 text-left shadow-sm transition-colors hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${typeStyle} ${selected ? "ring-2 ring-primary" : ""} ${isSubtask ? "rounded-lg" : "w-full rounded-xl"}`}
    >
      <div className="flex w-full min-w-0 items-center justify-between gap-2">
        <span className={`flex min-w-0 items-center gap-1 truncate text-[10px] font-semibold uppercase tracking-wider ${isSubtask ? "text-violet-600 dark:text-violet-300" : "text-muted-foreground"}`}>
          {isSubtask ? <CornerDownRight className="size-3 shrink-0" aria-hidden="true" /> : null}
          {node.kind === "run" ? "Conversation" : isSubtask ? "Sub Task" : node.kind === "plan" ? "Task" : "Subagent"}
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
  const surfaceRef = useRef<HTMLElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
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
  const routes = routePlotlineEdges(graph.positions, graph.edges, dependencyEdges);
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  const planProgress = summarizePlanProgress(nodes);
  const running = nodes.filter((node) => ["running", "waiting"].includes(node.status)).length;
  const completed = nodes.filter((node) => node.status === "completed").length;
  const failed = nodes.filter((node) => ["failed", "interrupted"].includes(node.status)).length;
  const skipped = nodes.filter((node) => ["skipped", "cancelled"].includes(node.status)).length;
  const delegated = selectedRunId === "live"
    ? (projection?.subagents.length ?? 0)
    : Math.max(0, nodes.length - 1);

  const exportPng = async () => {
    if (exporting || graph.positions.length === 0) return;
    setExporting(true);
    setExportError(null);
    try {
      // Model positions cover the entire DAG, including nodes outside the scroll viewport.
      await downloadPlotlinePng({
        title: plan?.title ?? stored?.title ?? projection?.thread.title ?? "Plotline DAG",
        nodes: graph.positions,
        edges: graph.edges,
        dependencies: dependencyEdges,
        width: graph.width,
        height: graph.height,
        dark: isDarkPlotlineSurface(surfaceRef.current),
      });
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Unable to export Plotline PNG.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <section ref={surfaceRef} className="flex h-full min-h-0 flex-col bg-background text-foreground" aria-label="Plotline execution observer">
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
            <button
              type="button"
              onClick={() => { void exportPng(); }}
              disabled={exporting || graph.positions.length === 0}
              aria-label="Export Plotline DAG as PNG image"
              title="Export complete DAG as PNG (including off-screen nodes)"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="size-3.5" aria-hidden="true" />
              {exporting ? "Exporting…" : "Export PNG"}
            </button>
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
        {exportError ? <p role="alert" className="mt-2 text-xs text-rose-600">{exportError}</p> : null}
        {saved.error ? <p role="status" className="mt-2 text-xs text-rose-600">{saved.error}</p> : null}
        {planQuery.error ? <p role="status" className="mt-2 text-xs text-rose-600">{planQuery.error}</p> : null}
        {plan ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Plan revision {plan.revision} · {plan.tasks.length} tasks · dependencies shown as dashed lines
          </p>
        ) : null}
        {nodes.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            {plan ? (
              <span>
                Plan {planProgress.status} · {planProgress.completed}/{planProgress.total} completed
                {planProgress.outstanding > 0 ? ` · ${planProgress.outstanding} outstanding` : ""}
              </span>
            ) : null}
            <span>{delegated} delegated</span>
            <span>{running} active</span>
            <span>{completed} completed</span>
            {failed > 0 ? <span>{failed} failed/interrupted</span> : null}
            {skipped > 0 ? <span>{skipped} skipped/cancelled</span> : null}
          </div>
        ) : null}
        {plan ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-muted-foreground" aria-label="Plotline graph legend">
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[3px] border border-sky-500 bg-sky-500/15" />Task</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[3px] border border-violet-500 bg-violet-500/15" />Sub Task</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-6 border-t-[2.5px] border-slate-500 dark:border-slate-300" />Parent / child</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-6 border-t-[2.5px] border-dashed border-sky-600 dark:border-sky-300" />Dependency</span>
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
                className="pointer-events-none absolute inset-0"
                width={graph.width}
                height={graph.height}
                viewBox={`0 0 ${graph.width} ${graph.height}`}
              >
                <defs>
                  {/* No SVG filter on edges: vertical paths have a zero-width bounding box
                      and can disappear when a filter is evaluated in objectBoundingBox units. */}
                  <marker
                    id="plotline-dependency-arrow"
                    markerWidth="9"
                    markerHeight="9"
                    refX="7"
                    refY="4.5"
                    orient="auto"
                    markerUnits="userSpaceOnUse"
                  >
                    <path
                      d="M 0 0 L 7 4.5 L 0 9"
                      fill="none"
                      stroke="#38bdf8"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </marker>
                </defs>
                {/* Geometry is shared with PNG export. Routes stay in row gaps
                    and column gutters instead of crossing other task cards. */}
                {routes.map((route, index) => {
                  const hierarchy = route.kind === "hierarchy";
                  const focused = selectedId === null ||
                    route.from === selectedId || route.to === selectedId;
                  const opacity = selectedId !== null
                    ? (focused ? 1 : 0.12)
                    : hierarchy ? 0.9 : 0.5;
                  const d = plotlineRoutePath(route.points);
                  return (
                    <g
                      key={`${route.kind}:${route.from}:${route.to}:${index}`}
                      className={hierarchy
                        ? "text-slate-500 dark:text-slate-300"
                        : "text-sky-600 dark:text-sky-300"}
                      opacity={opacity}
                    >
                      <path
                        d={d}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={hierarchy ? 2.5 : 2}
                        strokeDasharray={hierarchy ? undefined : "7 5"}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        markerEnd={hierarchy ? undefined : "url(#plotline-dependency-arrow)"}
                      />
                    </g>
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
