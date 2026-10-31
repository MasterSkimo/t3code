import { layoutHorizontalGraph } from "./observerHorizontalLayout";
import type { OrchestrationV2ThreadProjection, PlotlinePlan } from "@t3tools/contracts";

/**
 * Plotline is only a projection of T3's existing execution data.
 * No node in this model is allowed to mutate or schedule a run.
 */
export interface ObservedTask {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly kind: "run" | "delegation" | "plan";
  /** Plan hierarchy only; native delegates retain their existing appearance. */
  readonly isSubtask?: boolean;
  readonly status: string;
  readonly provider: string | null;
  readonly detail: string;
  readonly result: string | null;
}

export interface ObservedPosition {
  readonly node: ObservedTask;
  readonly x: number;
  readonly y: number;
}


/**
 * Overlay advisory plan nodes on native T3 execution. A native status is used
 * only when the planned task is explicitly bound to a real delegated task ID.
 * Never guess execution state by task title or model response.
 */
export function projectDynamicPlan(
  plan: PlotlinePlan,
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "subagents"> | null,
): { readonly nodes: readonly ObservedTask[]; readonly dependencies: readonly { from: string; to: string }[] } {
  const observed = projectExecutionGraph(projection);
  const root: ObservedTask = observed[0] ?? {
    id: `plan-root:${plan.rootThreadId}`,
    parentId: null,
    title: plan.title,
    kind: "run",
    status: "planned",
    provider: null,
    detail: "Plan created by orchestrator",
    result: null,
  };
  // The planned DAG spans multiple turns. Reconcile all historical native
  // delegations, not only those from the newest T3 run.
  const native = new Map(
    (projection?.subagents ?? []).map((task) => [
      String(task.id),
      {
        id: String(task.id),
        parentId: String(task.parentNodeId),
        title: task.title?.trim() || task.prompt.trim().slice(0, 90) || "Delegated task",
        kind: "delegation" as const,
        status: task.status,
        provider: task.model ?? String(task.providerInstanceId),
        detail: task.prompt,
        result: task.result,
      },
    ]),
  );
  const taskKey = (id: string) => `plan:${id}`;
  // An earlier native retry remains an attempt of the same planned task.
  // Do not render its historical delegate as a new, unplanned DAG node.
  const byNativeId = new Map(plan.tasks.flatMap((task) =>
    [
      ...(task.boundTaskId === null ? [] : [task.boundTaskId]),
      ...(task.bindingHistory ?? []).map((attempt) => attempt.delegatedTaskId),
    ].map((nativeId) => [nativeId, taskKey(task.id)] as const),
  ));
  const tasks: ObservedTask[] = plan.tasks.map((task) => {
    const execution = task.boundTaskId === null ? undefined : native.get(task.boundTaskId);
    return {
      id: taskKey(task.id),
      parentId: task.parentTaskId === null ? root.id : taskKey(task.parentTaskId),
      title: task.title,
      kind: "plan",
      isSubtask: task.parentTaskId !== null,
      // An unbound completion is a plan assertion, not a native execution.
      // Bound tasks always display the native T3 delegation status.
      status: execution?.status ?? (task.boundTaskId === null ? task.planState : "planned"),
      provider: execution?.provider ??
        (task.createdByThreadId === plan.rootThreadId ? "Planned by orchestrator" : "Discovered by worker"),
      detail: [
        task.detail,
        task.reason ? `Plan reason: ${task.reason}` : "",
        task.boundTaskId === null && task.planState === "completed"
          ? "Completed in plan by agent (no native T3 execution)" : "",
        (task.bindingHistory?.length ?? 0) > 0
          ? `Previous native attempts: ${task.bindingHistory!.length}` : "",
      ].filter(Boolean).join("\n") || "Awaiting delegation",
      result: execution?.result ?? task.reason,
    };
  });
  const extra = [...native.values()]
    .filter((node) => !byNativeId.has(node.id))
    .map((node) => ({
      ...node,
      parentId: node.parentId === null ? root.id :
        (byNativeId.get(node.parentId) ?? (native.has(node.parentId) ? node.parentId : root.id)),
    }));
  const dependencies = plan.tasks.flatMap((task) =>
    task.dependsOn.map((id) => ({ from: taskKey(id), to: taskKey(task.id) })),
  );
  return { nodes: [root, ...tasks, ...extra], dependencies };
}

/** Plan settlement is separate from the latest conversation run's native status. */
export function summarizePlanProgress(nodes: readonly ObservedTask[]) {
  const planTasks = nodes.filter((node) => node.kind === "plan");
  const completed = planTasks.filter((node) => node.status === "completed").length;
  const failures = planTasks.filter((node) => ["failed", "interrupted"].includes(node.status)).length;
  const outstanding = planTasks.filter((node) =>
    !["completed", "skipped", "cancelled", "failed", "interrupted"].includes(node.status),
  ).length;
  return {
    total: planTasks.length,
    completed,
    outstanding,
    status: failures > 0 ? "failed" : outstanding === 0 && planTasks.length > 0 ? "completed" : "open",
  } as const;
}

export const OBSERVER_NODE_WIDTH = 216;
export const OBSERVER_NODE_HEIGHT = 106;
// Leave gutters between branches for routed dependencies, and row gaps for bends.


/** Only the latest run and children actually linked to it are included. */
export function projectExecutionGraph(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "subagents"> | null,
): readonly ObservedTask[] {
  if (!projection) return [];
  const latest = projection.runs.reduce<(typeof projection.runs)[number] | null>(
    (selected, run) => (!selected || run.ordinal > selected.ordinal ? run : selected),
    null,
  );
  if (!latest) return [];
  const children = projection.subagents.filter((task) => task.runId === latest.id);
  const taskIds = new Set(children.map((task) => String(task.id)));
  return [
    {
      id: String(latest.id),
      parentId: null,
      title: projection.thread.title || `Run #${latest.ordinal}`,
      kind: "run",
      status: latest.status,
      provider: String(latest.providerInstanceId),
      detail: `Run #${latest.ordinal}`,
      result: null,
    },
    ...children.map((task) => ({
      id: String(task.id),
      // Preserve only known delegation links; unknown parent nodes attach to the run.
      parentId: taskIds.has(String(task.parentNodeId))
        ? String(task.parentNodeId)
        : String(latest.id),
      title: task.title?.trim() || task.prompt.trim().slice(0, 90) || "Delegated task",
      kind: "delegation" as const,
      status: task.status,
      provider: task.model ?? String(task.providerInstanceId),
      detail: task.prompt,
      result: task.result,
    })),
  ];
}

/**
 * Layer by recorded delegation parent IDs. Parallel children share a level;
 * sibling order is visual only and never implies a task dependency.
 */
/**
 * Layout native T3 execution and planned work left-to-right. Geometry is
 * shared by the live view and PNG export; dependencies remain explicit.
 */
export function layoutExecutionGraph(
  nodes: readonly ObservedTask[],
  dependencies: readonly { readonly from: string; readonly to: string }[] = [],
) {
  return layoutHorizontalGraph(nodes, dependencies);
}
