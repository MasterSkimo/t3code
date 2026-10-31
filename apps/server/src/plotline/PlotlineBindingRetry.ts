import { PlotlineStorageError } from "@t3tools/contracts";
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
