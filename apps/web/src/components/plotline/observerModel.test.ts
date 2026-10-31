import { describe, expect, it } from "vite-plus/test";
import type { PlotlinePlan } from "@t3tools/contracts";

import {
  layoutExecutionGraph,
  projectExecutionGraph,
  projectDynamicPlan,
  type ObservedTask,
} from "./observerModel";

type Projection = NonNullable<Parameters<typeof projectExecutionGraph>[0]>;

/** The observer reads only these three fields; other T3 projection fields are irrelevant. */
function fixture(): Projection {
  return {
    thread: { title: "My conversation" },
    runs: [
      { id: "run-old", ordinal: 1, status: "completed", providerInstanceId: "codex" },
      { id: "run-current", ordinal: 2, status: "running", providerInstanceId: "codex" },
    ],
    subagents: [
      {
        id: "sub-old",
        runId: "run-old",
        parentNodeId: "root-old",
        title: "Previous work",
        prompt: "Previous work",
        status: "completed",
        model: "old",
        providerInstanceId: "codex",
        result: null,
      },
      {
        id: "sub-current",
        runId: "run-current",
        parentNodeId: "root-current",
        title: "Inspect task",
        prompt: "Inspect a file",
        status: "running",
        model: "gpt",
        providerInstanceId: "codex",
        result: null,
      },
    ],
  } as unknown as Projection;
}

describe("Plotline read-only projection", () => {
  it("shows the latest native run and only its delegated tasks", () => {
    const nodes = projectExecutionGraph(fixture());
    expect(nodes.map((node) => node.id)).toEqual(["run-current", "sub-current"]);
    expect(nodes[0]?.status).toBe("running");
    expect(nodes[1]?.title).toBe("Inspect task");
    expect(nodes[1]?.parentId).toBe("run-current");
  });

  it("renders empty graph when no run exists", () => {
    expect(projectExecutionGraph(null)).toEqual([]);
    const snapshot = fixture();
    expect(projectExecutionGraph({ ...snapshot, runs: [] })).toEqual([]);
  });

  it("keeps recorded parent-child delegation links, not invented sibling dependencies", () => {
    const graph: ObservedTask[] = [
      { id: "root", parentId: null, title: "Root", kind: "run", status: "running", provider: null, detail: "", result: null },
      { id: "a", parentId: "root", title: "A", kind: "delegation", status: "completed", provider: null, detail: "", result: null },
      { id: "b", parentId: "root", title: "B", kind: "delegation", status: "running", provider: null, detail: "", result: null },
      { id: "c", parentId: "a", title: "C", kind: "delegation", status: "pending", provider: null, detail: "", result: null },
    ];
    const result = layoutExecutionGraph(graph);
    expect(result.edges).toEqual([
      { from: "root", to: "a" },
      { from: "root", to: "b" },
      { from: "a", to: "c" },
    ]);
    const positions = new Map(result.positions.map((entry) => [entry.node.id, entry]));
    expect(positions.get("a")?.y).toBe(positions.get("b")?.y);
    expect((positions.get("c")?.y ?? 0) > (positions.get("a")?.y ?? 0)).toBe(true);
  });
});

describe("dynamic Plotline DAG view", () => {
  it("places dependent tasks after their prerequisites before any worker starts", () => {
    const plan: PlotlinePlan = {
      rootThreadId: "root", title: "Audit", revision: 1, updatedAt: "2026-10-31T00:00:00Z",
      tasks: [
        { id: "A", title: "DB", detail: "", parentTaskId: null, dependsOn: [], planState: "planned", reason: null, createdByThreadId: "root", boundTaskId: null, boundThreadId: null },
        { id: "B", title: "API", detail: "", parentTaskId: null, dependsOn: [], planState: "planned", reason: null, createdByThreadId: "root", boundTaskId: null, boundThreadId: null },
        { id: "D", title: "Review", detail: "", parentTaskId: null, dependsOn: ["A", "B"], planState: "planned", reason: null, createdByThreadId: "root", boundTaskId: null, boundThreadId: null },
      ],
    };
    const view = projectDynamicPlan(plan, null);
    expect(view.nodes.map((node) => node.status)).toEqual(["planned", "planned", "planned", "planned"]);
    expect(view.dependencies).toEqual([{ from: "plan:A", to: "plan:D" }, { from: "plan:B", to: "plan:D" }]);
    const layout = layoutExecutionGraph(view.nodes, view.dependencies);
    const byId = new Map(layout.positions.map((item) => [item.node.id, item.y]));
    expect((byId.get("plan:D") ?? 0) > (byId.get("plan:A") ?? 0)).toBe(true);
    expect(byId.get("plan:A")).toBe(byId.get("plan:B"));
  });

  it("keeps previous native attempts inside the same planned task after retry", () => {
    const plan: PlotlinePlan = {
      rootThreadId: "root", title: "Retry", revision: 3, updatedAt: "2026-10-31T00:00:00Z",
      tasks: [{
        id: "A", title: "A", detail: "", parentTaskId: null, dependsOn: [],
        planState: "planned", reason: null, createdByThreadId: "root",
        boundTaskId: "sub-current", boundThreadId: "child-new",
        bindingHistory: [{ delegatedTaskId: "sub-old", childThreadId: "child-old" }],
      }],
    };
    const view = projectDynamicPlan(plan, fixture());
    expect(view.nodes.filter((node) => node.id === "plan:A")).toHaveLength(1);
    expect(view.nodes.some((node) => node.id === "sub-old")).toBe(false);
    expect(view.nodes.some((node) => node.id === "sub-current")).toBe(false);
    expect(view.nodes.find((node) => node.id === "plan:A")?.status).toBe("running");
    expect(view.nodes.find((node) => node.id === "plan:A")?.detail).toContain("Previous native attempts: 1");
  });

  it("reconciles a bound task across turns without inferring unbound execution", () => {
    const plan: PlotlinePlan = {
      rootThreadId: "root", title: "Audit", revision: 2, updatedAt: "2026-10-31T00:00:00Z",
      tasks: [
        { id: "A", title: "DB", detail: "", parentTaskId: null, dependsOn: [], planState: "planned", reason: null, createdByThreadId: "root", boundTaskId: "sub-old", boundThreadId: "child-A" },
        { id: "B", title: "API", detail: "", parentTaskId: null, dependsOn: [], planState: "skipped", reason: "Not needed", createdByThreadId: "root", boundTaskId: null, boundThreadId: null },
      ],
    };
    const view = projectDynamicPlan(plan, fixture());
    expect(view.nodes.find((node) => node.id === "plan:A")?.status).toBe("completed");
    expect(view.nodes.find((node) => node.id === "plan:B")?.status).toBe("skipped");
    expect(view.nodes.find((node) => node.id === "sub-old")).toBeUndefined();
    expect(view.nodes.find((node) => node.id === "sub-current")?.status).toBe("running");
  });
});
