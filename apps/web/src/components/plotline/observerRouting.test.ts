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
      expect(byId.get(parent)?.y).toBe(byId.get(child)?.y);
      expect(byId.get(child)!.x).toBeGreaterThan(byId.get(parent)!.x);
    }
    const roots = ["A", "B", "C"].map((id) => byId.get(id)!);
    expect(roots[0]!.x).toBe(roots[1]!.x);
    expect(roots[1]!.x).toBe(roots[2]!.x);
    expect(roots[0]!.y).toBeLessThan(roots[1]!.y);
    expect(roots[1]!.y).toBeLessThan(roots[2]!.y);
    const routes = routePlotlineEdges(graph.positions, graph.edges, dependencies);
    for (const route of routes) {
      expect(routeCrossesCards(route.points, graph.positions, route.from, route.to)).toBe(false);
    }
    expect(routes.filter((route) => route.kind === "dependency")).toHaveLength(3);
  });

  it("expands a 21-node festival DAG into horizontal review lanes", () => {
    const nodes = [
      node("root", null),
      node("attendance", "root"), node("capacity", "root"), node("energy", "root"),
      node("attendance-1", "attendance", true), node("capacity-1", "capacity", true),
      node("energy-1", "energy", true),
      node("attendance-2", "attendance", true), node("capacity-2", "capacity", true),
      node("energy-2", "energy", true),
      node("attendance-3", "attendance", true), node("capacity-3", "capacity", true),
      node("energy-3", "energy", true),
      node("budget", "root"), node("logistics", "root"),
      node("integration", "root"), node("resolution", "root"),
      node("resolution-1", "resolution", true), node("summary", "root"),
      node("verification", "root"), node("verification-1", "verification", true),
    ];
    const dependencies = [
      { from: "attendance", to: "budget" },
      { from: "capacity", to: "logistics" },
      { from: "energy", to: "logistics" },
      { from: "budget", to: "integration" },
      { from: "logistics", to: "integration" },
      { from: "integration", to: "resolution" },
      { from: "resolution-1", to: "summary" },
      { from: "summary", to: "verification" },
    ];
    expect(nodes).toHaveLength(21);
    const graph = layoutExecutionGraph(nodes, dependencies);
    const byId = new Map(graph.positions.map((position) => [position.node.id, position]));
    const initialBranches = ["attendance", "capacity", "energy"].map((id) => byId.get(id)!);
    const stageRoots = ["budget", "logistics", "integration", "resolution", "summary", "verification"]
      .map((id) => byId.get(id)!);
    const furthestBranch = Math.max(...initialBranches.map((position) => position.x));
    expect(Math.min(...stageRoots.map((position) => position.x)))
      .toBeGreaterThan(furthestBranch);
    expect(new Set(stageRoots.map((position) => position.x)).size).toBeGreaterThanOrEqual(3);
    expect(graph.width).toBeGreaterThan(1_800);
    // The last six stages should occupy multiple columns, not six stacked rows.
    expect(new Set(stageRoots.map((position) => position.y)).size).toBeLessThan(6);
    expect(byId.get("verification-1")?.y).toBe(byId.get("verification")?.y);
    expect(byId.get("verification-1")!.x).toBeGreaterThan(byId.get("verification")!.x);
    const occupied = new Set(graph.positions.map((position) => `${position.x}:${position.y}`));
    expect(occupied.size).toBe(graph.positions.length);
    // Horizontal placement only: the export and live view retain original links.
    expect(graph.edges).toContainEqual({ from: "resolution", to: "resolution-1" });
    expect(dependencies).not.toContainEqual({ from: "resolution-1", to: "verification" });
  });

  it("places sibling subtasks on the same workstream row, extending its width", () => {
    const nodes = [
      node("root", null), node("A", "root"),
      node("A1", "A", true), node("A2", "A", true), node("A3", "A", true),
      node("B", "root"),
    ];
    const dependencies = [{ from: "A", to: "B" }];
    const graph = layoutExecutionGraph(nodes, dependencies);
    const byId = new Map(graph.positions.map((item) => [item.node.id, item]));
    const chain = ["A", "A1", "A2", "A3"].map((id) => byId.get(id)!);
    expect(new Set(chain.map((item) => item.y)).size).toBe(1);
    expect(chain.map((item) => item.y)).toEqual([chain[0]!.y, chain[0]!.y, chain[0]!.y, chain[0]!.y]);
    for (let index = 1; index < chain.length; index++) {
      expect(chain[index]!.x).toBeGreaterThan(chain[index - 1]!.x);
    }
    expect(byId.get("B")!.x).toBeGreaterThan(byId.get("A3")!.x);
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
    expect(graph.width).toBeGreaterThan(3 * OBSERVER_NODE_WIDTH);
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
