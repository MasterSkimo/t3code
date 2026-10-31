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
const HORIZONTAL_GAP = 112;
const VERTICAL_GAP = 88;
const PADDING = 70;

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
  const prerequisites = new Map<string, string[]>();
  const predecessors = new Map<string, Set<string>>();
  const successors = new Map<string, Set<string>>();
  const addConstraint = (from: string, to: string) => {
    if (from === to || !byId.has(from) || !byId.has(to)) return;
    const into = predecessors.get(to) ?? new Set<string>();
    into.add(from);
    predecessors.set(to, into);
    const out = successors.get(from) ?? new Set<string>();
    out.add(to);
    successors.set(from, out);
  };
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null || !byId.has(node.parentId)) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
    addConstraint(node.parentId, node.id);
  }
  for (const edge of dependencies) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const list = prerequisites.get(edge.to) ?? [];
    list.push(edge.from);
    prerequisites.set(edge.to, list);
    addConstraint(edge.from, edge.to);
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const pending = [from];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(successors.get(id) ?? []));
    }
    return false;
  };
  const descendants = (parentId: string): string[] => {
    const found: string[] = [];
    const pending = [...(children.get(parentId) ?? [])];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(id);
      pending.push(...(children.get(id) ?? []));
    }
    return found;
  };
  // When B depends on A and A owns A1, place B below A1's subtree.
  // These are layout-only constraints: they NEVER create A1 -> B dependencies.
  // Skip a spacing constraint if it would contradict the actual DAG.
  for (const edge of dependencies) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    for (const descendant of descendants(edge.from)) {
      if (!reaches(edge.to, descendant)) addConstraint(descendant, edge.to);
    }
  }
  const levels = new Map<string, number>();
  const depth = (id: string, visiting: Set<string>): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = [...(predecessors.get(id) ?? [])];
    const next = parents.length === 0 ? 0 : Math.max(...parents.map((parent) => depth(parent, visiting) + 1));
    visiting.delete(id);
    levels.set(id, next);
    return next;
  };
  for (const node of nodes) depth(node.id, new Set());
  const groups = new Map<number, ObservedTask[]>();
  for (const node of nodes) {
    const level = levels.get(node.id) ?? 0;
    const group = groups.get(level) ?? [];
    group.push(node);
    groups.set(level, group);
  }
  // A stable column per root workstream prevents subtasks drifting sideways
  // when other branches grow. Dependent summary tasks inherit the centre of
  // their prerequisite branches rather than being centred anew on every row.
  const maxColumns = Math.min(4, Math.max(1, ...[...groups.values()].map((group) => group.length)));
  const width = PADDING * 2 + maxColumns * OBSERVER_NODE_WIDTH + (maxColumns - 1) * HORIZONTAL_GAP;
  const branchRoots = nodes.filter((node) =>
    node.parentId !== null && byId.get(node.parentId)?.kind === "run" &&
    (prerequisites.get(node.id)?.length ?? 0) === 0,
  );
  const branchIndex = new Map(branchRoots.map((node, index) => [node.id, index % maxColumns]));
  const preferred = new Map<string, number>();
  const preferredColumn = (id: string, visiting: Set<string>): number => {
    const existing = preferred.get(id);
    if (existing !== undefined) return existing;
    if (visiting.has(id)) return (maxColumns - 1) / 2;
    visiting.add(id);
    const node = byId.get(id);
    const deps = prerequisites.get(id) ?? [];
    let value: number;
    if (branchIndex.has(id)) value = branchIndex.get(id)!;
    else if (node?.parentId !== null && node?.parentId !== undefined &&
             byId.get(node.parentId)?.kind !== "run") {
      value = preferredColumn(node.parentId, visiting);
    } else if (deps.length > 0) {
      value = deps.reduce((sum, dep) => sum + preferredColumn(dep, visiting), 0) / deps.length;
    } else value = (maxColumns - 1) / 2;
    visiting.delete(id);
    preferred.set(id, value);
    return value;
  };
  const positions: ObservedPosition[] = [];
  let nextY = PADDING;
  for (const [, group] of [...groups].sort(([a], [b]) => a - b)) {
    const rowCount = Math.ceil(group.length / maxColumns);
    for (let row = 0; row < rowCount; row++) {
      const chunk = group.slice(row * maxColumns, (row + 1) * maxColumns);
      const used = new Set<number>();
      // Assign work to its existing lane first; only collision siblings move.
      const ordered = chunk.map((node, index) => ({
        node, index, target: preferredColumn(node.id, new Set()),
      })).sort((a, b) => a.target - b.target || a.index - b.index);
      for (const item of ordered) {
        const columns = Array.from({ length: maxColumns }, (_, index) => index)
          .filter((index) => !used.has(index));
        const column = columns.sort((a, b) =>
          Math.abs(a - item.target) - Math.abs(b - item.target) || a - b,
        )[0]!;
        used.add(column);
        positions.push({
          node: item.node,
          x: PADDING + column * (OBSERVER_NODE_WIDTH + HORIZONTAL_GAP),
          y: nextY + row * (OBSERVER_NODE_HEIGHT + VERTICAL_GAP),
        });
      }
    }
    nextY += rowCount * (OBSERVER_NODE_HEIGHT + VERTICAL_GAP);
  }
  const edges = nodes
    .filter((node) => node.parentId !== null && byId.has(node.parentId))
    // Root-owned tasks with explicit prerequisites are connected through their
    // dashed dependency edges. Suppress the root ownership line so it cannot
    // cross a nested subtask and suggest a nonexistent A1 -> B relationship.
    .filter((node) => !(node.kind === "plan" &&
      byId.get(node.parentId!)?.kind === "run" &&
      (prerequisites.get(node.id)?.length ?? 0) > 0))
    .map((node) => ({ from: node.parentId!, to: node.id }));
  return {
    width,
    height: nextY + PADDING,
    positions,
    edges,
  };
}
