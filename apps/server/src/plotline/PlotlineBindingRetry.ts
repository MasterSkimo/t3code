import { PlotlineStorageError, type PlotlinePlanTask } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/**
 * Native T3 may start a child before its parent receives the delegated-task ID
 * and calls plotline_task_bind. Do not grant the child access to an unbound
 * branch: retry only the temporary missing-assignment errors, without holding
 * the Plotline SQLite transaction/lock between attempts.
 */
export const retryPendingTaskBinding = <A, R>(
  mutation: Effect.Effect<A, PlotlineStorageError, R>,
  isWorker: boolean,
  maxRetries = 48,
): Effect.Effect<A, PlotlineStorageError, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; ; attempt++) {
      const result = yield* Effect.either(mutation);
      if (result._tag === "Right") return result.right;
      const error = result.left;
      const awaitingBinding =
        error.message === "A worker may add subtasks only under its assigned task." ||
        error.message === "A worker may update only its own or assigned tasks.";
      if (!isWorker || !awaitingBinding) return yield* Effect.fail(error);
      if (attempt >= maxRetries)
        return yield* Effect.fail(
          new PlotlineStorageError({
            message:
              "The worker's task was not linked to its native delegation. " +
              "The parent must call plotline_task_bind, then the worker may retry with the same requestId.",
          }),
        );
      yield* Effect.sleep("250 millis");
    }
  });

/**
 * Recover a worker's native child identity only when exactly one planned task
 * is already bound to that native delegation and awaits its child-thread ID.
 * The caller must first verify the real native parent/child thread lineage.
 */
export const findPendingNativeAssignment = (
  tasks: ReadonlyArray<Pick<PlotlinePlanTask, "id" | "boundTaskId" | "boundThreadId">>,
  nativeTasks: ReadonlyArray<{ readonly id: string; readonly childThreadId: string | null }>,
  actorThreadId: string,
): { readonly taskId: string; readonly delegatedTaskId: string; readonly childThreadId: string } | null => {
  const native = nativeTasks.find((item) => item.childThreadId === actorThreadId);
  if (!native) return null;
  const candidates = tasks.filter(
    (task) => task.boundTaskId === native.id && task.boundThreadId === null,
  );
  if (candidates.length !== 1) return null;
  return {
    taskId: candidates[0]!.id,
    delegatedTaskId: native.id,
    childThreadId: actorThreadId,
  };
};
