import { ThreadId, type PlotlineDag } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { plotlineDagsForThread } from "./plotlineAssociation";

const dag = (id: string, originatingThreadId?: string, taskThreadId?: string): PlotlineDag => ({
  id,
  projectId: "project-1",
  ...(originatingThreadId ? { originatingThreadId: ThreadId.make(originatingThreadId) } : {}),
  title: id,
  description: "",
  workspace: null,
  state: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  tasks: taskThreadId
    ? [
        {
          id: "task-1",
          title: "Task",
          description: "",
          state: "running",
          effort: 2,
          dependsOn: [],
          threadId: ThreadId.make(taskThreadId),
          runId: null,
          legacySessionIds: [],
          agent: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
        },
      ]
    : [],
  events: [],
});

describe("plotlineDagsForThread", () => {
  it("returns every DAG owned by the conversation or one of its delegated tasks", () => {
    const dags = [
      dag("origin-a", "thread-1"),
      dag("origin-b", "thread-1"),
      dag("worker-dag", "other-thread", "thread-1"),
      dag("same-project-unrelated", "other-thread"),
    ];

    expect(plotlineDagsForThread(dags, "thread-1").map(({ id }) => id)).toEqual([
      "origin-a",
      "origin-b",
      "worker-dag",
    ]);
  });

  it("does not attach legacy DAGs without an exact thread association", () => {
    expect(
      plotlineDagsForThread([dag("legacy"), dag("unrelated", "thread-2")], "thread-1"),
    ).toEqual([]);
  });
});
