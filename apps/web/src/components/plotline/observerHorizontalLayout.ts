import type { ObservedTask, ObservedPosition } from "./observerModel";
import { OBSERVER_NODE_HEIGHT, OBSERVER_NODE_WIDTH } from "./observerModel";

/**
 * A left-to-right layout is a projection, not a scheduler. Every root workstream
 * occupies one horizontal lane and its discovered subtasks extend that lane.
 * Tasks depending on completed work occupy subsequent columns.
 */
export function layoutHorizontalGraph(
  nodes: readonly ObservedTask[],
  dependencies: readonly { readonly from: string; readonly to: string }[],
) {
  const empty = {
    width: 0, height: 0,
    positions: [] as readonly ObservedPosition[],
    edges: [] as readonly { from: string; to: string }[],
  };
  if (nodes.length === 0) return empty;
  const PADDING = 78;
  const COLUMN_GAP = 94; // room for links and dependency lanes
  const ROW_GAP = 126;
  const STEP_X = OBSERVER_NODE_WIDTH + COLUMN_GAP;
  const STEP_Y = OBSERVER_NODE_HEIGHT + ROW_GAP;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const prereqs = new Map<string, string[]>();
  for (const edge of dependencies) {
    if (!byId.has(edge.to) || !byId.has(edge.from)) continue;
    prereqs.set(edge.to, [...(prereqs.get(edge.to) ?? []), edge.from]);
  }
  const children = new Map<string, ObservedTask[]>();
  for (const node of nodes) {
    if (node.parentId === null || !byId.has(node.parentId)) continue;
    const array = children.get(node.parentId) ?? [];
    array.push(node);
    children.set(node.parentId, array);
  }
  const run = nodes.find((node) => node.parentId === null) ?? nodes[0]!;
  const topLevel = children.get(run.id) ?? [];
  const branches = topLevel.filter((node) => (prereqs.get(node.id)?.length ?? 0) === 0);
  const rows = new Map<string, number>();
  const columns = new Map<string, number>();
  const placed = new Set<string>();
  const usedCells = new Set<string>();
  const put = (id: string, col: number, row: number) => {
    let yRow = row;
    while (usedCells.has(`${col}:${yRow}`)) yRow++;
    rows.set(id, yRow);
    columns.set(id, col);
    usedCells.add(`${col}:${yRow}`);
    placed.add(id);
  };

  // Reserve a horizontal lane for each independent workstream. A subtask
  // never creates a new vertical lane; siblings extend the parent's row.
  const orderedBranches = branches.length ? branches : topLevel;
  let branchEnd = 1;
  for (const [row, branch] of orderedBranches.entries()) {
    if (placed.has(branch.id)) continue;
    put(branch.id, 1, row);
    let nextColumn = 2;
    const visit = (parentId: string, ancestors: Set<string>) => {
      if (ancestors.has(parentId)) return;
      const chain = new Set([...ancestors, parentId]);
      for (const child of children.get(parentId) ?? []) {
        if (placed.has(child.id)) continue;
        // A discovered subtask may have prerequisites outside its branch.
        // Defer it rather than displaying it before its real dependency.
        if ((prereqs.get(child.id) ?? []).some((id) => !placed.has(id))) continue;
        put(child.id, nextColumn++, row);
        visit(child.id, chain);
      }
    };
    visit(branch.id, new Set());
    branchEnd = Math.max(branchEnd, nextColumn - 1);
  }

  // The second phase starts to the right of the longest branch. Rank
  // dependent tasks by their real prerequisites, never by visual siblings.
  const downstream = nodes.filter((node) => node.id !== run.id && !placed.has(node.id));
  const phaseStart = branchEnd + 1;
  let pending = [...downstream];
  const latestChildColumn = new Map<string, number>();
  let safety = nodes.length + 1;
  while (pending.length > 0 && safety-- > 0) {
    let progressed = false;
    const remaining: ObservedTask[] = [];
    for (const node of pending) {
      const incoming = [
        ...(prereqs.get(node.id) ?? []),
        ...(node.parentId !== null && node.parentId !== run.id ? [node.parentId] : []),
      ].filter((id) => byId.has(id));
      if (incoming.some((id) => !placed.has(id))) {
        remaining.push(node);
        continue;
      }
      // A parent may create several child tasks. Display them side by side
      // along its row rather than spilling those siblings into new rows.
      const siblingColumn = node.parentId
        ? (latestChildColumn.get(node.parentId) ?? (columns.get(node.parentId) ?? 0)) + 1
        : 0;
      const col = Math.max(
        phaseStart,
        siblingColumn,
        ...incoming.map((id) => (columns.get(id) ?? 0) + 1),
      );
      const parentRow = node.parentId ? rows.get(node.parentId) : undefined;
      const incomingRows = incoming.flatMap((id) => {
        const value = rows.get(id);
        return value === undefined ? [] : [value];
      });
      const row = parentRow ?? (incomingRows.length > 0
        ? Math.round(incomingRows.reduce((a, b) => a + b, 0) / incomingRows.length)
        : Math.floor((orderedBranches.length - 1) / 2));
      put(node.id, col, Math.max(0, row));
      if (node.parentId !== null && node.parentId !== run.id)
        latestChildColumn.set(node.parentId, col);
      progressed = true;
    }
    if (!progressed) {
      // A corrupted/cyclic projection is still inspectable and cannot hang UI.
      for (const node of remaining) put(node.id, phaseStart, usedCells.size);
      pending = [];
      break;
    }
    pending = remaining;
  }
  // Conversation remains on the left, centred on the main workstreams.
  const rowsUsed = orderedBranches.length;
  rows.set(run.id, Math.max(0, (rowsUsed - 1) / 2));
  columns.set(run.id, 0);
  const positions: ObservedPosition[] = nodes.map((node) => ({
    node,
    x: PADDING + (columns.get(node.id) ?? phaseStart) * STEP_X,
    y: PADDING + (rows.get(node.id) ?? 0) * STEP_Y,
  }));
  const edges = nodes
    .filter((node) => node.parentId !== null && byId.has(node.parentId))
    // Root ownership of dependent work is omitted when an actual dependency
    // already supplies the link, avoiding an implied extra relationship.
    .filter((node) => !(node.parentId === run.id && (prereqs.get(node.id)?.length ?? 0) > 0))
    .map((node) => ({ from: node.parentId!, to: node.id }));
  return {
    width: Math.max(...positions.map((position) =>
      position.x + OBSERVER_NODE_WIDTH + PADDING)),
    height: Math.max(...positions.map((position) =>
      position.y + OBSERVER_NODE_HEIGHT + PADDING)),
    positions,
    edges,
  };
}
