import type { PlotlineDag } from "@t3tools/contracts";

export interface PlotlineTaskRunMatch {
  readonly dagId: string;
  readonly taskId: string;
  readonly title: string;
}

/** A Plotline task is associated with a run only when both persisted IDs match exactly. */
export function findPlotlineTaskRunMatches(
  dags: ReadonlyArray<PlotlineDag>,
  threadId: string,
  runId: string,
): ReadonlyArray<PlotlineTaskRunMatch> {
  const matches: Array<PlotlineTaskRunMatch> = [];
  for (const dag of dags) {
    for (const task of dag.tasks) {
      if (task.threadId !== threadId || task.runId !== runId) continue;
      matches.push({ dagId: dag.id, taskId: task.id, title: task.title });
    }
  }
  return matches;
}
