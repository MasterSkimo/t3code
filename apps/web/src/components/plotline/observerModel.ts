import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/**
 * Plotline is only a projection of T3's existing execution data.
 * No node in this model is allowed to mutate or schedule a run.
 */
export interface ObservedTask {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly kind: "run" | "delegation";
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
export function layoutExecutionGraph(nodes: readonly ObservedTask[]) {
  if (nodes.length === 0) {
    return { width: 0, height: 0, positions: [] as readonly ObservedPosition[], edges: [] as readonly { from: string; to: string }[] };
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const levels = new Map<string, number>();
  const depth = (id: string, visiting: Set<string>): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    if (!node || !node.parentId || !byId.has(node.parentId) || visiting.has(id)) return 0;
    visiting.add(id);
    const next = depth(node.parentId, visiting) + 1;
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
  const maxColumns = Math.max(1, ...[...groups.values()].map((group) => group.length));
  const maxLevel = Math.max(...groups.keys());
  const width = PADDING * 2 + maxColumns * OBSERVER_NODE_WIDTH + (maxColumns - 1) * HORIZONTAL_GAP;
  const positions: ObservedPosition[] = [];
  for (const [level, group] of [...groups].sort(([a], [b]) => a - b)) {
    const rowWidth = group.length * OBSERVER_NODE_WIDTH + (group.length - 1) * HORIZONTAL_GAP;
    const offset = (width - rowWidth) / 2;
    group.forEach((node, index) =>
      positions.push({
        node,
        x: offset + index * (OBSERVER_NODE_WIDTH + HORIZONTAL_GAP),
        y: PADDING + level * (OBSERVER_NODE_HEIGHT + VERTICAL_GAP),
      }),
    );
  }
  const edges = nodes
    .filter((node) => node.parentId !== null && byId.has(node.parentId))
    .map((node) => ({ from: node.parentId!, to: node.id }));
  return {
    width,
    height: PADDING * 2 + (maxLevel + 1) * OBSERVER_NODE_HEIGHT + maxLevel * VERTICAL_GAP,
    positions,
    edges,
  };
}
