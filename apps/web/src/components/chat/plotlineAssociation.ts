import type { PlotlineDag } from "@t3tools/contracts";

/** A DAG is visible in its originating conversation and in threads assigned to its tasks. */
export function plotlineDagsForThread(
  dags: readonly PlotlineDag[],
  threadId: string,
): ReadonlyArray<PlotlineDag> {
  return dags.filter(
    (dag) =>
      dag.originatingThreadId === threadId || dag.tasks.some((task) => task.threadId === threadId),
  );
}
