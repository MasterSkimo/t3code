import { describe, expect, it } from "vite-plus/test";

import {
  layoutExecutionGraph,
  OBSERVER_NODE_HEIGHT,
  OBSERVER_NODE_WIDTH,
  type ObservedTask,
} from "./observerModel";
import {
  plotlineRoutePath,
  routeCrossesCards,
  routePlotlineEdges,
} from "./observerRouting";

const node = (
  id: string,
  parentId: string | null,
  isSubtask = false,
): ObservedTask => ({
  id, parentId, isSubtask,
  title: id, kind: parentId === null ? "run" : "plan",
  status: "completed", provider: null, detail: "", result: null,
});

describe("Plotline live and PNG routing", () => {
  it("keeps child A1 separate from B's real A -> B dependency", () => {
    const nodes = [node("root", null), node("A", "root"), node("A1", "A", true), node("B", "root")];
    const dependencies = [{ from: "A", to: "B" }];
    const graph = layoutExecutionGraph(nodes, dependencies);
    const routes = routePlotlineEdges(graph.positions, graph.edges, dependencies);

    expect(routes).toHaveLength(3);
    expect(routes.filter((route) => route.kind === "dependency"))
      .toEqual([expect.objectContaining({ from: "A", to: "B" })]);
    expect(routes).not.toContainEqual(expect.objectContaining({ from: "A1", to: "B" }));
    for (const route of routes) {
      expect(routeCrossesCards(route.points, graph.positions, route.from, route.to)).toBe(false);
    }
    expect(plotlineRoutePath(routes[0]!.points)).toMatch(/^M /);
  });

  it("preserves branch lanes through three parallel streams", () => {
    const nodes = [
      node("root", null),
      node("A", "root"), node("B", "root"), node("C", "root"),
      node("A1", "A", true), node("B1", "B", true), node("C1", "C", true),
      node("A2", "A1", true), node("B2", "B1", true), node("C2", "C1", true),
      node("summary", "root"),
    ];
    const dependencies = [
      { from: "A2", to: "summary" },
      { from: "B2", to: "summary" },
      { from: "C2", to: "summary" },
    ];
    const graph = layoutExecutionGraph(nodes, dependencies);
    const byId = new Map(graph.positions.map((entry) => [entry.node.id, entry]));
    for (const [parent, child] of [["A", "A1"], ["B", "B1"], ["C", "C1"], ["A1", "A2"], ["B1", "B2"], ["C1", "C2"]]) {
      expect(byId.get(parent)?.x).toBe(byId.get(child)?.x);
    }
    const roots = ["A", "B", "C"].map((id) => byId.get(id)!.x);
    expect(roots[0]).toBeLessThan(roots[1]!);
    expect(roots[1]).toBeLessThan(roots[2]!);
    expect(roots[1]! - roots[0]!).toBeGreaterThan(OBSERVER_NODE_WIDTH + 70);
    const routes = routePlotlineEdges(graph.positions, graph.edges, dependencies);
    for (const route of routes) {
      expect(routeCrossesCards(route.points, graph.positions, route.from, route.to)).toBe(false);
    }
    expect(routes.filter((route) => route.kind === "dependency")).toHaveLength(3);
  });

  it("does not connect unrelated cards through a large vertical gap", () => {
    const nodes = [
      node("root", null), node("A", "root"), node("other", "root"),
      node("otherChild", "other", true), node("deep", "A", true),
    ];
    const dependencies = [{ from: "otherChild", to: "deep" }];
    const graph = layoutExecutionGraph(nodes, dependencies);
    const routes = routePlotlineEdges(graph.positions, graph.edges, dependencies);
    for (const route of routes) {
      expect(routeCrossesCards(route.points, graph.positions, route.from, route.to)).toBe(false);
    }
    expect(graph.height).toBeGreaterThan(3 * OBSERVER_NODE_HEIGHT);
  });

  it("does not infer a dependency from the physical ordering of nodes", () => {
    const positions = [
      { node: node("A", "root"), x: 70, y: 200 },
      { node: node("A1", "A", true), x: 70, y: 400 },
      { node: node("B", "root"), x: 70, y: 600 },
    ];
    const routes = routePlotlineEdges(
      positions,
      [{ from: "A", to: "A1" }],
      [{ from: "A", to: "B" }],
    );
    expect(routes.map((route) => [route.kind, route.from, route.to])).toEqual([
      ["hierarchy", "A", "A1"],
      ["dependency", "A", "B"],
    ]);
    expect(routes[1]?.points.some((point) => point.x > 70 + OBSERVER_NODE_WIDTH))
      .toBe(true);
    expect(routeCrossesCards(routes[1]!.points, positions, "A", "B")).toBe(false);
  });
});
