import { describe, expect, it } from "vite-plus/test";

import {
  layoutExecutionGraph,
  projectExecutionGraph,
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
