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
  const byId = new Map(positions.map((item) => [item.node.id, item]));
  const routes: PlotlineRoute[] = [];
  const bottom = (item: ObservedPosition): PlotlinePoint => ({
    x: item.x + OBSERVER_NODE_WIDTH / 2, y: item.y + OBSERVER_NODE_HEIGHT,
  });
  const top = (item: ObservedPosition): PlotlinePoint => ({
    x: item.x + OBSERVER_NODE_WIDTH / 2, y: item.y,
  });

  for (const edge of hierarchy) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const start = bottom(from);
    const finish = top(to);
    const midpoint = start.y + (finish.y - start.y) / 2;
    const direct = [
      start,
      { x: start.x, y: midpoint },
      { x: finish.x, y: midpoint },
      finish,
    ];
    if (finish.y > start.y + 16 &&
        !routeCrossesCards(direct, positions, edge.from, edge.to)) {
      routes.push({ ...edge, kind: "hierarchy", points: direct });
      continue;
    }

    // A distant child belongs in the parent's branch but may have unrelated
    // work between it and the parent. Use the gutter instead of a vertical
    // connector that would pass through those cards.
    const right = to.x >= from.x;
    const laneOffset = 20;
    const departure = {
      x: from.x + (right ? OBSERVER_NODE_WIDTH : 0),
      y: from.y + OBSERVER_NODE_HEIGHT / 2,
    };
    const destination = {
      x: to.x + (right ? 0 : OBSERVER_NODE_WIDTH),
      y: to.y + OBSERVER_NODE_HEIGHT / 2,
    };
    const sourceLane = departure.x + (right ? laneOffset : -laneOffset);
    const targetLane = destination.x + (right ? -laneOffset : laneOffset);
    const transferY = from.y + OBSERVER_NODE_HEIGHT +
      Math.min(28, Math.max(10, (to.y - from.y - OBSERVER_NODE_HEIGHT) / 2));
    const points = [
      departure,
      { x: sourceLane, y: departure.y },
      { x: sourceLane, y: transferY },
      { x: targetLane, y: transferY },
      { x: targetLane, y: destination.y },
      destination,
    ];
    routes.push({ ...edge, kind: "hierarchy", points });
  }

  dependencies.forEach((edge, index) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return;
    // Always exit and enter on the closest free side of each card. The same
    // column uses its right gutter. Never connect to an intermediate subtask.
    const sameColumn = Math.abs(from.x - to.x) < 1;
    const goingRight = to.x > from.x || sameColumn;
    const start = {
      x: from.x + (goingRight ? OBSERVER_NODE_WIDTH : 0),
      y: from.y + OBSERVER_NODE_HEIGHT / 2,
    };
    const finish = {
      x: to.x + (sameColumn ? OBSERVER_NODE_WIDTH : goingRight ? 0 : OBSERVER_NODE_WIDTH),
      y: to.y + OBSERVER_NODE_HEIGHT / 2,
    };
    const lane = 22 + (index % 3) * 6;
    const sourceLane = start.x + (goingRight ? lane : -lane);
    const targetLane = finish.x + (sameColumn || !goingRight ? lane : -lane);
    // Cross columns in the first clear row gap below the source, never at card
    // mid-height. Then descend inside a column gutter to the destination.
    const transferY = from.y + OBSERVER_NODE_HEIGHT +
      Math.min(30, Math.max(12, (to.y - from.y - OBSERVER_NODE_HEIGHT) / 2));
    routes.push({
      ...edge,
      kind: "dependency",
      points: [
        start,
        { x: sourceLane, y: start.y },
        { x: sourceLane, y: transferY },
        { x: targetLane, y: transferY },
        { x: targetLane, y: finish.y },
        finish,
      ],
    });
  });
  return routes;
}

/** One path format for both SVG and Canvas2D, including explicit bend points. */
export function plotlineRoutePath(points: readonly PlotlinePoint[]): string {
  return points.map((point, index) =>
    `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`,
  ).join(" ");
}
