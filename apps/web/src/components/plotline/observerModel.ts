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
        parentId: null,
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
  const byNativeId = new Map(plan.tasks.filter((task) => task.boundTaskId !== null)
    .map((task) => [task.boundTaskId!, taskKey(task.id)]));
  const tasks: ObservedTask[] = plan.tasks.map((task) => {
    const execution = task.boundTaskId === null ? undefined : native.get(task.boundTaskId);
    return {
      id: taskKey(task.id),
      parentId: task.parentTaskId === null ? root.id : taskKey(task.parentTaskId),
      title: task.title,
      kind: "plan",
      status: execution?.status ?? task.planState,
      provider: execution?.provider ??
        (task.createdByThreadId === plan.rootThreadId ? "Planned by orchestrator" : "Discovered by worker"),
      detail: [task.detail, task.reason ? `Plan reason: ${task.reason}` : ""]
        .filter(Boolean).join("\\n") || "Awaiting delegation",
      result: execution?.result ?? task.reason,
    };
  });
  const extra = [...native.values()]
    .filter((node) => !byNativeId.has(node.id))
    .map((node) => ({
      ...node,
      parentId: node.parentId === null ? root.id : (byNativeId.get(node.parentId) ?? root.id),
    }));
  const dependencies = plan.tasks.flatMap((task) =>
    task.dependsOn.map((id) => ({ from: taskKey(id), to: taskKey(task.id) })),
  );
  return { nodes: [root, ...tasks, ...extra], dependencies };
}

export const OBSERVER_NODE_WIDTH = 216;
export const OBSERVER_NODE_HEIGHT = 106;
const HORIZONTAL_GAP = 36;
const VERTICAL_GAP = 70;
const PADDING = 36;

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
export function layoutExecutionGraph(
  nodes: readonly ObservedTask[],
  dependencies: readonly { readonly from: string; readonly to: string }[] = [],
) {
  if (nodes.length === 0) {
    return { width: 0, height: 0, positions: [] as readonly ObservedPosition[], edges: [] as readonly { from: string; to: string }[] };
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const levels = new Map<string, number>();
  const prerequisites = new Map<string, string[]>();
  for (const edge of dependencies) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const list = prerequisites.get(edge.to) ?? [];
    list.push(edge.from);
    prerequisites.set(edge.to, list);
  }
  const depth = (id: string, visiting: Set<string>): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    if (!node || visiting.has(id)) return 0;
    visiting.add(id);
    const parents = [
      ...(node.parentId !== null && byId.has(node.parentId) ? [node.parentId] : []),
      ...(prerequisites.get(id) ?? []),
    ];
    const next = parents.length === 0 ? 0 : Math.max(...parents.map((parent) => depth(parent, visiting) + 1));
    visiting.delete(id);
    levels.set(id, next);
    return next;
  };
  for (const node of nodes) levels.set(node.id, depth(node.id, new Set()));
  const groups = new Map<number, ObservedTask[]>();
  for (const node of nodes) {
    const level = levels.get(node.id) ?? 0;
    const group = groups.get(level) ?? [];
    group.push(node);
    groups.set(level, group);
  }
  // Bound horizontal growth: a mission with many workers must remain navigable
  // in T3's right panel rather than creating a single enormous sibling row.
  const maxColumns = Math.min(4, Math.max(1, ...[...groups.values()].map((group) => group.length)));
  const width = PADDING * 2 + maxColumns * OBSERVER_NODE_WIDTH + (maxColumns - 1) * HORIZONTAL_GAP;
  const positions: ObservedPosition[] = [];
  let nextY = PADDING;
  for (const [level, group] of [...groups].sort(([a], [b]) => a - b)) {
    const rowCount = Math.ceil(group.length / maxColumns);
    for (let row = 0; row < rowCount; row++) {
      const chunk = group.slice(row * maxColumns, (row + 1) * maxColumns);
      const rowWidth = chunk.length * OBSERVER_NODE_WIDTH + (chunk.length - 1) * HORIZONTAL_GAP;
      const offset = (width - rowWidth) / 2;
      chunk.forEach((node, column) =>
        positions.push({
          node,
          x: offset + column * (OBSERVER_NODE_WIDTH + HORIZONTAL_GAP),
          y: nextY + row * (OBSERVER_NODE_HEIGHT + VERTICAL_GAP),
        }),
      );
    }
    nextY += rowCount * (OBSERVER_NODE_HEIGHT + VERTICAL_GAP);
  }
  const edges = nodes
    .filter((node) => node.parentId !== null && byId.has(node.parentId))
    .map((node) => ({ from: node.parentId!, to: node.id }));
  return {
    width,
    height: nextY + PADDING,
    positions,
    edges,
  };
}
