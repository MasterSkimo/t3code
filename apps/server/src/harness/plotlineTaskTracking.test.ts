import { PlotlineDag, type PlotlineDag as PlotlineDagModel } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { findPlotlineTaskRunMatches } from "./plotlineTaskTracking.ts";

const decodeDag = Schema.decodeUnknownSync(PlotlineDag);

const dag = (threadId: string | null, runId: string | null): PlotlineDagModel =>
  decodeDag({
    id: "dag_tracking",
    projectId: "project_tracking",
    title: "Tracking",
    description: "",
    workspace: null,
    state: "running",
    createdAt: "2026-10-27T12:00:00.000Z",
    updatedAt: "2026-10-27T12:00:00.000Z",
    startedAt: "2026-10-27T12:00:00.000Z",
    finishedAt: null,
    tasks: [
      {
        id: "task_tracking",
        title: "Build feature",
        description: "",
        state: "running",
        effort: 2,
        dependsOn: [],
        threadId,
        runId,
        legacySessionIds: [],
        agent: null,
        createdAt: "2026-10-27T12:00:00.000Z",
        updatedAt: "2026-10-27T12:00:00.000Z",
        startedAt: "2026-10-27T12:00:00.000Z",
        finishedAt: null,
      },
    ],
    events: [],
  });

describe("findPlotlineTaskRunMatches", () => {
  it("matches only an exact persisted thread and run pair", () => {
    const dags = [dag("thread_tracking", "run_tracking")];

    expect(findPlotlineTaskRunMatches(dags, "thread_tracking", "run_tracking")).toEqual([
      { dagId: "dag_tracking", taskId: "task_tracking", title: "Build feature" },
    ]);
    expect(findPlotlineTaskRunMatches(dags, "other_thread", "run_tracking")).toEqual([]);
    expect(findPlotlineTaskRunMatches(dags, "thread_tracking", "other_run")).toEqual([]);
    expect(
      findPlotlineTaskRunMatches([dag("thread_tracking", null)], "thread_tracking", "run_tracking"),
    ).toEqual([]);
    expect(
      findPlotlineTaskRunMatches([dag(null, "run_tracking")], "thread_tracking", "run_tracking"),
    ).toEqual([]);
  });
});
