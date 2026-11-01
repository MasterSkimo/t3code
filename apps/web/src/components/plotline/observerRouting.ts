import { OBSERVER_NODE_HEIGHT, OBSERVER_NODE_WIDTH, type ObservedPosition } from "./observerModel";

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
  readonly unroutable?: boolean;
}

/** A drawable piece of geometry and every dependency that uses it. */
export interface PlotlineRouteSegment {
  readonly from: PlotlinePoint;
  readonly to: PlotlinePoint;
  readonly edges: readonly Pick<PlotlineRoute, "from" | "to" | "kind">[];
}

/** Crossings are not junctions: interrupt the vertical stroke beneath the horizontal one. */
export function plotlineCrossings(
  segments: readonly PlotlineRouteSegment[],
): readonly PlotlinePoint[] {
  const dependencies = segments.filter((segment) =>
    segment.edges.some((edge) => edge.kind === "dependency"),
  );
  const horizontal = dependencies.filter((segment) => segment.from.y === segment.to.y);
  const vertical = dependencies.filter((segment) => segment.from.x === segment.to.x);
  const result = new Map<string, PlotlinePoint>();
  for (const h of horizontal)
    for (const v of vertical) {
      const x = v.from.x,
        y = h.from.y;
      if (x <= h.from.x || x >= h.to.x || y <= v.from.y || y >= v.to.y) continue;
      result.set(`${x}:${y}`, { x, y });
    }
  return [...result.values()];
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
    const right = position.x + (position.width ?? OBSERVER_NODE_WIDTH) + padding;
    const top = position.y - padding;
    const bottom = position.y + (position.height ?? OBSERVER_NODE_HEIGHT) + padding;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      if (
        a.x === b.x &&
        a.x > left &&
        a.x < right &&
        Math.max(a.y, b.y) > top &&
        Math.min(a.y, b.y) < bottom
      )
        return true;
      if (
        a.y === b.y &&
        a.y > top &&
        a.y < bottom &&
        Math.max(a.x, b.x) > left &&
        Math.min(a.x, b.x) < right
      )
        return true;
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
      x: source.x + (source.width ?? OBSERVER_NODE_WIDTH),
      y: source.y + OBSERVER_NODE_HEIGHT / 2,
    };
    const finish = {
      x: target.x + (forward ? 0 : (target.width ?? OBSERVER_NODE_WIDTH)),
      y: target.y + OBSERVER_NODE_HEIGHT / 2,
    };
    const straight = [start, finish];
    if (
      forward &&
      start.y === finish.y &&
      !routeCrossesCards(straight, positions, edge.from, edge.to)
    ) {
      result.push({ ...edge, points: straight });
      continue;
    }
    const exitX = start.x + 20;
    const entryX = finish.x + (forward ? -20 : 20);
    const candidates = [
      target.y - 30,
      target.y + OBSERVER_NODE_HEIGHT + 30,
      source.y - 30,
      source.y + OBSERVER_NODE_HEIGHT + 30,
    ].map((y) => [
      start,
      { x: exitX, y: start.y },
      { x: exitX, y },
      { x: entryX, y },
      { x: entryX, y: finish.y },
      finish,
    ]);
    const local = candidates.find(
      (candidate) => !routeCrossesCards(candidate, positions, edge.from, edge.to),
    );
    const points = local ?? findCardSafeRoute(start, finish, positions, edge.from, edge.to, index);
    result.push(points ? { ...edge, points } : { ...edge, points: [], unroutable: true });
  }
  return result;
}

/** Decompose routes into canonical shared segments without losing edge identity. */
export function groupPlotlineRouteSegments(
  routes: readonly PlotlineRoute[],
): readonly PlotlineRouteSegment[] {
  type Edge = Pick<PlotlineRoute, "from" | "to" | "kind">;
  const lines = new Map<
    string,
    { horizontal: boolean; fixed: number; spans: { start: number; end: number; edge: Edge }[] }
  >();
  for (const route of routes) {
    for (let index = 1; index < route.points.length; index++) {
      const a = route.points[index - 1]!;
      const b = route.points[index]!;
      if (a.x === b.x && a.y === b.y) continue;
      const horizontal = a.y === b.y;
      const fixed = horizontal ? a.y : a.x;
      const key = `${horizontal ? "h" : "v"}:${fixed}`;
      const line = lines.get(key) ?? { horizontal, fixed, spans: [] };
      const first = horizontal ? a.x : a.y;
      const last = horizontal ? b.x : b.y;
      line.spans.push({
        start: Math.min(first, last),
        end: Math.max(first, last),
        edge: { from: route.from, to: route.to, kind: route.kind },
      });
      lines.set(key, line);
    }
  }
  const segments: PlotlineRouteSegment[] = [];
  for (const line of lines.values()) {
    const events = new Map<number, { edge: Edge; delta: number }[]>();
    for (const span of line.spans) {
      for (const [point, delta] of [
        [span.start, 1],
        [span.end, -1],
      ] as const) {
        const entries = events.get(point) ?? [];
        entries.push({ edge: span.edge, delta });
        events.set(point, entries);
      }
    }
    const stops = [...events.keys()].sort((a, b) => a - b);
    const active = new Map<string, { edge: Edge; count: number }>();
    for (let i = 0; i < stops.length - 1; i++) {
      const start = stops[i]!,
        end = stops[i + 1]!;
      for (const { edge, delta } of events.get(start) ?? []) {
        const key = `${edge.kind}:${edge.from}:${edge.to}`;
        const count = (active.get(key)?.count ?? 0) + delta;
        if (count === 0) active.delete(key);
        else active.set(key, { edge, count });
      }
      if (!active.size) continue;
      segments.push({
        from: line.horizontal ? { x: start, y: line.fixed } : { x: line.fixed, y: start },
        to: line.horizontal ? { x: end, y: line.fixed } : { x: line.fixed, y: end },
        edges: [...active.values()].map(({ edge }) => edge),
      });
    }
  }
  return segments;
}

function findCardSafeRoute(
  start: PlotlinePoint,
  finish: PlotlinePoint,
  positions: readonly ObservedPosition[],
  sourceId: string,
  destinationId: string,
  tieBreak: number,
): readonly PlotlinePoint[] | null {
  const padding = 8;
  const obstacles = positions.filter((p) => p.node.id !== sourceId && p.node.id !== destinationId);
  const minX = Math.min(start.x, finish.x, ...obstacles.map((p) => p.x)) - 64 - (tieBreak % 3) * 4;
  const maxX =
    Math.max(start.x, finish.x, ...obstacles.map((p) => p.x + (p.width ?? OBSERVER_NODE_WIDTH))) +
    64 +
    (tieBreak % 3) * 4;
  const minY = Math.min(start.y, finish.y, ...obstacles.map((p) => p.y)) - 64 - (tieBreak % 3) * 4;
  const maxY =
    Math.max(start.y, finish.y, ...obstacles.map((p) => p.y + (p.height ?? OBSERVER_NODE_HEIGHT))) +
    64 +
    (tieBreak % 3) * 4;
  const candidates: PlotlinePoint[][] = [];
  const xs = new Set<number>([minX, maxX]);
  const ys = new Set<number>([minY, maxY]);
  for (const p of obstacles) {
    xs.add(p.x - padding);
    xs.add(p.x + (p.width ?? OBSERVER_NODE_WIDTH) + padding);
    ys.add(p.y - padding);
    ys.add(p.y + (p.height ?? OBSERVER_NODE_HEIGHT) + padding);
  }
  for (const x of xs) candidates.push([start, { x, y: start.y }, { x, y: finish.y }, finish]);
  for (const y of ys) candidates.push([start, { x: start.x, y }, { x: finish.x, y }, finish]);
  // The outer perimeter expands with the graph, guaranteeing an escape lane for card-dense layouts.
  candidates.push(
    [start, { x: start.x, y: minY }, { x: finish.x, y: minY }, finish],
    [start, { x: start.x, y: maxY }, { x: finish.x, y: maxY }, finish],
    [start, { x: minX, y: start.y }, { x: minX, y: finish.y }, finish],
    [start, { x: maxX, y: start.y }, { x: maxX, y: finish.y }, finish],
  );
  const safe = candidates
    .map(simplifyOrthogonalPath)
    .filter((candidate) => !routeCrossesCards(candidate, positions, sourceId, destinationId))
    .sort((a, b) => pathLength(a) - pathLength(b) || a.length - b.length);
  // The axis-aligned outer lanes are outside every obstacle; this fallback is for malformed coordinates only.
  return safe[0] ?? null;
}

function pathLength(points: readonly PlotlinePoint[]): number {
  return points
    .slice(1)
    .reduce(
      (total, point, index) =>
        total + Math.abs(point.x - points[index]!.x) + Math.abs(point.y - points[index]!.y),
      0,
    );
}

function simplifyOrthogonalPath(points: readonly PlotlinePoint[]): readonly PlotlinePoint[] {
  return points.filter((point, index) => {
    if (index === 0 || index === points.length - 1) return true;
    const before = points[index - 1]!,
      after = points[index + 1]!;
    return !(
      (before.x === point.x && point.x === after.x) ||
      (before.y === point.y && point.y === after.y)
    );
  });
}

/** One path format for both SVG and Canvas2D, including explicit bend points. */
export function plotlineRoutePath(points: readonly PlotlinePoint[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}
