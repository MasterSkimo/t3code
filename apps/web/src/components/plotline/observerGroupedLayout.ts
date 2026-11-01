import type { ObservedPosition, ObservedTask } from "./observerModel";
import { OBSERVER_NODE_HEIGHT, OBSERVER_NODE_WIDTH } from "./observerModel";

export interface ObserverGroupBounds {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly expanded: boolean;
  readonly childIds: readonly string[];
}

export interface ObserverGroupedPosition extends ObservedPosition {
  readonly width: number;
  readonly height: number;
}

export interface ObserverGroupedLayout {
  readonly width: number;
  readonly height: number;
  readonly positions: readonly ObserverGroupedPosition[];
  /** Explicit dependencies and non-container ownership links. */
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly groups: readonly ObserverGroupBounds[];
}

const PADDING = 78;
const COLUMN_GAP = 94;
const ROW_GAP = 72;
const GROUP_INSET = 20;
const CHILD_GAP_X = 32;
const CHILD_GAP_Y = 18;

/**
 * Lay out a live plan as task containers. Direct planned subtasks are placed
 * inside expanded roots; other observed nodes (including unplanned delegates)
 * remain independent cards. This is a projection and never changes the DAG.
 */
export function layoutObserverGroupedGraph(
  nodes: readonly ObservedTask[],
  dependencies: readonly { readonly from: string; readonly to: string }[] = [],
  expandedGroups: ReadonlySet<string> = new Set(),
): ObserverGroupedLayout {
  if (nodes.length === 0) return { width: 0, height: 0, positions: [], edges: [], groups: [] };

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const run = nodes.find((node) => node.parentId === null);
  const roots = nodes.filter((node) => node.kind === "plan" && !node.isSubtask);
  const rootIds = new Set(roots.map((node) => node.id));
  const directChildren = new Map<string, ObservedTask[]>();
  for (const node of nodes) {
    if (!node.isSubtask || !node.parentId || !rootIds.has(node.parentId)) continue;
    directChildren.set(node.parentId, [...(directChildren.get(node.parentId) ?? []), node]);
  }
  const groupedChildIds = new Set([...directChildren.values()].flat().map((node) => node.id));
  // Group roots and all non-contained nodes are the top-level layout units.
  const units = nodes.filter(
    (node) => node !== run && !node.isSubtask && !groupedChildIds.has(node.id),
  );
  const unitFor = new Map<string, string>();
  for (const node of nodes) {
    const groupId = node.parentId && groupedChildIds.has(node.id) ? node.parentId : undefined;
    if (groupId) unitFor.set(node.id, groupId);
    else if (node !== run) unitFor.set(node.id, node.id);
  }

  const childrenOf = (id: string) => directChildren.get(id) ?? [];
  const unitSize = (node: ObservedTask) => {
    const children = childrenOf(node.id);
    if (!rootIds.has(node.id) || !expandedGroups.has(node.id) || children.length === 0)
      return {
        width: OBSERVER_NODE_WIDTH,
        height: OBSERVER_NODE_HEIGHT + Math.max(0, Math.ceil(children.length / 19) - 1) * 9,
      };
    const cols = Math.min(3, children.length);
    const rows = Math.ceil(children.length / cols);
    return {
      width: Math.max(
        OBSERVER_NODE_WIDTH,
        GROUP_INSET * 2 + cols * OBSERVER_NODE_WIDTH + (cols - 1) * CHILD_GAP_X,
      ),
      height:
        GROUP_INSET * 2 +
        OBSERVER_NODE_HEIGHT +
        14 +
        rows * OBSERVER_NODE_HEIGHT +
        (rows - 1) * CHILD_GAP_Y,
    };
  };
  const unitIds = new Set(units.map((node) => node.id));
  const prereqs = new Map<string, Set<string>>();
  for (const edge of dependencies) {
    const from = unitFor.get(edge.from);
    const to = unitFor.get(edge.to);
    if (!from || !to || from === to || !unitIds.has(from) || !unitIds.has(to)) continue;
    const set = prereqs.get(to) ?? new Set<string>();
    set.add(from);
    prereqs.set(to, set);
  }

  // Longest prerequisite path gives deterministic left-to-right dependency order.
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  const rank = (id: string): number => {
    const known = ranks.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // malformed cyclic input stays renderable
    visiting.add(id);
    const value = Math.max(0, ...[...(prereqs.get(id) ?? [])].map((from) => rank(from) + 1));
    visiting.delete(id);
    ranks.set(id, value);
    return value;
  };
  for (const unit of units) rank(unit.id);

  const sizes = new Map(units.map((node) => [node.id, unitSize(node)]));
  const coords = new Map<string, { x: number; y: number }>();
  const byRank = new Map<number, ObservedTask[]>();
  for (const unit of units) {
    const col = ranks.get(unit.id) ?? 0;
    byRank.set(col, [...(byRank.get(col) ?? []), unit]);
  }
  let cursorX = PADDING + (run ? OBSERVER_NODE_WIDTH + COLUMN_GAP : 0);
  for (const col of [...byRank.keys()].sort((a, b) => a - b)) {
    const column = byRank.get(col)!;
    const laneCount = Math.min(4, Math.ceil(Math.sqrt(column.length)));
    const lanes = Array.from({ length: laneCount }, () => [] as ObservedTask[]);
    column.forEach((node, index) => lanes[index % laneCount]!.push(node));
    for (const lane of lanes) {
      let y = PADDING;
      const width = Math.max(...lane.map((node) => sizes.get(node.id)!.width));
      for (const unit of lane) {
        coords.set(unit.id, { x: cursorX, y });
        y += sizes.get(unit.id)!.height + ROW_GAP;
      }
      cursorX += width + COLUMN_GAP;
    }
  }

  const positions: ObserverGroupedPosition[] = [];
  const maxY = Math.max(
    PADDING + OBSERVER_NODE_HEIGHT,
    ...units.map((unit) => coords.get(unit.id)!.y + sizes.get(unit.id)!.height),
  );
  if (run)
    positions.push({
      node: run,
      x: PADDING,
      y: Math.max(PADDING, (maxY - OBSERVER_NODE_HEIGHT) / 2),
      width: OBSERVER_NODE_WIDTH,
      height: OBSERVER_NODE_HEIGHT,
    });
  for (const unit of units) {
    const point = coords.get(unit.id)!;
    const size = sizes.get(unit.id)!;
    positions.push({ node: unit, ...point, ...size });
    const children = childrenOf(unit.id);
    if (!expandedGroups.has(unit.id)) continue;
    const cols = Math.min(3, children.length);
    children.forEach((child, index) =>
      positions.push({
        node: child,
        x: point.x + GROUP_INSET + (index % cols) * (OBSERVER_NODE_WIDTH + CHILD_GAP_X),
        y:
          point.y +
          GROUP_INSET +
          OBSERVER_NODE_HEIGHT +
          14 +
          Math.floor(index / cols) * (OBSERVER_NODE_HEIGHT + CHILD_GAP_Y),
        width: OBSERVER_NODE_WIDTH,
        height: OBSERVER_NODE_HEIGHT,
      }),
    );
  }
  const positionById = new Map(positions.map((position) => [position.node.id, position]));
  const groups = roots.map((root): ObserverGroupBounds => {
    const position = positionById.get(root.id)!;
    return {
      id: root.id,
      x: position.x,
      y: position.y,
      width: position.width,
      height: position.height,
      expanded: expandedGroups.has(root.id),
      childIds: childrenOf(root.id).map((node) => node.id),
    };
  });
  const edges: { from: string; to: string }[] = [];
  for (const edge of dependencies) {
    if (positionById.has(edge.from) && positionById.has(edge.to)) edges.push(edge);
  }
  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId) || groupedChildIds.has(node.id)) continue;
    if (!positionById.has(node.id)) continue;
    let parentId: string | null = node.parentId;
    const visited = new Set<string>();
    while (parentId && !positionById.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    if (!parentId || !positionById.has(parentId)) continue;
    if (edges.some((edge) => edge.from === parentId && edge.to === node.id)) continue;
    edges.push({ from: parentId, to: node.id });
  }
  return {
    width: Math.max(...positions.map((position) => position.x + position.width)) + PADDING,
    height: Math.max(...positions.map((position) => position.y + position.height)) + PADDING,
    positions,
    edges,
    groups,
  };
}
