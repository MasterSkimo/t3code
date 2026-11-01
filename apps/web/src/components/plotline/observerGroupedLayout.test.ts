import { describe, expect, it } from "vite-plus/test";
import type { ObservedTask } from "./observerModel";
import { layoutObserverGroupedGraph } from "./observerGroupedLayout";

const task = (
  id: string,
  parentId: string | null,
  kind: ObservedTask["kind"] = "plan",
  isSubtask = false,
): ObservedTask => ({
  id,
  parentId,
  title: id,
  kind,
  isSubtask,
  status: "planned",
  provider: null,
  detail: "",
  result: null,
});

describe("grouped observer layout", () => {
  it("keeps direct subtasks within expanded root bounds and exposes internal dependencies", () => {
    const nodes = [
      task("run", null, "run"),
      task("A", "run"),
      task("a1", "A", "plan", true),
      task("a2", "A", "plan", true),
      task("B", "run"),
    ];
    const compact = layoutObserverGroupedGraph(nodes, [{ from: "a1", to: "a2" }]);
    const compactGroup = compact.groups.find((group) => group.id === "A")!;
    expect(compactGroup).toMatchObject({
      width: 216,
      height: 106,
      expanded: false,
      childIds: ["a1", "a2"],
    });
    expect(compact.positions.some((position) => position.node.id === "a1")).toBe(false);

    const expanded = layoutObserverGroupedGraph(nodes, [{ from: "a1", to: "a2" }], new Set(["A"]));
    const group = expanded.groups.find((entry) => entry.id === "A")!;
    const byId = new Map(expanded.positions.map((position) => [position.node.id, position]));
    for (const id of group.childIds) {
      const child = byId.get(id)!;
      expect(child.x).toBeGreaterThanOrEqual(group.x);
      expect(child.y).toBeGreaterThanOrEqual(group.y);
      expect(child.x + child.width).toBeLessThanOrEqual(group.x + group.width);
      expect(child.y + child.height).toBeLessThanOrEqual(group.y + group.height);
    }
    expect(expanded.edges).toContainEqual({ from: "a1", to: "a2" });
    expect(expanded.edges).not.toContainEqual({ from: "A", to: "a1" });
  });

  it("preserves unplanned native delegates as visible cards without overlapping group bounds", () => {
    const nodes = [
      task("run", null, "run"),
      task("A", "run"),
      task("a1", "A", "plan", true),
      task("native", "run", "delegation"),
    ];
    const layout = layoutObserverGroupedGraph(nodes, [], new Set(["A"]));
    const native = layout.positions.find((position) => position.node.id === "native");
    const group = layout.groups.find((entry) => entry.id === "A")!;
    expect(native).toBeDefined();
    expect(native?.width).toBe(216);
    expect(native?.x === group.x && native?.y === group.y).toBe(false);
    const nested = layoutObserverGroupedGraph([
      task("run", null, "run"),
      task("A", "run"),
      task("a1", "A", "plan", true),
      task("native", "a1", "delegation"),
      task("deep", "a1", "plan", true),
    ]);
    expect(nested.edges).toContainEqual({ from: "A", to: "native" });
    expect(nested.positions.some((position) => position.node.id === "deep")).toBe(false);
  });

  it("keeps dependency-ranked group bounds from overlapping", () => {
    const nodes = [
      task("run", null, "run"),
      task("A", "run"),
      task("a1", "A", "plan", true),
      task("B", "run"),
      task("C", "run"),
    ];
    const layout = layoutObserverGroupedGraph(nodes, [{ from: "A", to: "C" }], new Set(["A"]));
    const groups = new Map(layout.groups.map((group) => [group.id, group]));
    expect(groups.get("C")!.x).toBeGreaterThan(groups.get("A")!.x);
    for (const left of layout.groups)
      for (const right of layout.groups) {
        if (left.id === right.id) continue;
        const overlaps =
          left.x < right.x + right.width &&
          left.x + left.width > right.x &&
          left.y < right.y + right.height &&
          left.y + left.height > right.y;
        expect(overlaps).toBe(false);
      }
  });
});
