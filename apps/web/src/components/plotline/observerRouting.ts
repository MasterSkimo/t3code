import {
  OBSERVER_NODE_HEIGHT,
  OBSERVER_NODE_WIDTH,
  type ObservedPosition,
} from "./observerModel";

/** Routed polylines are shared by the live SVG and the PNG renderer. */
export interface PlotlinePoint {
  readonly x: number;
  readonly y: number;
}

export interface PlotlineRoute {
  readonly from: string;
  readonly to: string;
  readonly kind: "hierarchy" | "dependency";
  readonly points: readonly PlotlinePoint[];
}

/** A route can touch its endpoint cards but must not cut through any other card. */
export function routeCrossesCards(
  points: readonly PlotlinePoint[],
  positions: readonly ObservedPosition[],
  sourceId: string,
  destinationId: string,
): boolean {
  const padding = 3;
  for (const position of positions) {
    if (position.node.id === sourceId || position.node.id === destinationId) continue;
    const left = position.x - padding;
    const right = position.x + OBSERVER_NODE_WIDTH + padding;
    const top = position.y - padding;
    const bottom = position.y + OBSERVER_NODE_HEIGHT + padding;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      if (a.x === b.x && a.x > left && a.x < right &&
          Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom) return true;
      if (a.y === b.y && a.y > top && a.y < bottom &&
          Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right) return true;
    }
  }
  return false;
}

/** Assemble an orthogonal connection path with a small number of bends. */
export function routePlotlineEdges(
  positions: readonly ObservedPosition[],
  hierarchy: readonly { readonly from: string; readonly to: string }[],
  dependencies: readonly { readonly from: string; readonly to: string }[],
): readonly PlotlineRoute[] {
  const byId = new Map(positions.map((position) => [position.node.id, position]));
  const result: PlotlineRoute[] = [];
  const all = [
    ...hierarchy.map((edge) => ({ ...edge, kind: "hierarchy" as const })),
    ...dependencies.map((edge) => ({ ...edge, kind: "dependency" as const })),
  ];
  for (const [index, edge] of all.entries()) {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) continue;
    const forward = target.x > source.x + 2;
    const start = {
      x: source.x + OBSERVER_NODE_WIDTH,
      y: source.y + OBSERVER_NODE_HEIGHT / 2,
    };
    const finish = {
      x: target.x + (forward ? 0 : OBSERVER_NODE_WIDTH),
      y: target.y + OBSERVER_NODE_HEIGHT / 2,
    };
    const straight = [start, finish];
    if (forward && start.y === finish.y &&
        !routeCrossesCards(straight, positions, edge.from, edge.to)) {
      result.push({ ...edge, points: straight });
      continue;
    }
    // Depart through the gutter to avoid painting on top of intervening cards.
    // Use a horizontal lane above/below the destination row to keep branch
    // labels free even when two siblings share the same visual workstream.
    const offset = 22 + (index % 3) * 7;
    const entryX = forward ? finish.x - 20 : finish.x + 20;
    const exitX = forward
      ? Math.min(start.x + offset, entryX - 8)
      : Math.max(start.x + offset, entryX + 8);
    const candidateYs = [
      target.y - 30,
      target.y + OBSERVER_NODE_HEIGHT + 30,
      source.y - 30,
      source.y + OBSERVER_NODE_HEIGHT + 30,
    ];
    const candidates = candidateYs.map((laneY) => [
      start,
      { x: exitX, y: start.y },
      { x: exitX, y: laneY },
      { x: entryX, y: laneY },
      { x: entryX, y: finish.y },
      finish,
    ]);
    const preferred = candidates.find((candidate) =>
      !routeCrossesCards(candidate, positions, edge.from, edge.to),
    );
    // A fallback remains visible if the graph is unusually constrained;
    // horizontal layout allocates 94px between columns and 126px between rows.
    result.push({ ...edge, points: preferred ?? candidates[0]! });
  }
  return result;
}

/** One path format for both SVG and Canvas2D, including explicit bend points. */
export function plotlineRoutePath(points: readonly PlotlinePoint[]): string {
  return points.map((point, index) =>
    `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`,
  ).join(" ");
}
