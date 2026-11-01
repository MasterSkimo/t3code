import { assert, describe, it } from "@effect/vitest";
import { PlotlineStorageError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { findPendingNativeAssignment, retryPendingTaskBinding } from "./PlotlineBindingRetry.ts";

const unbound = () =>
  new PlotlineStorageError({
    message: "A worker may add subtasks only under its assigned task.",
  });

describe("Plotline worker binding race", () => {
  it("recovers only a verified native child awaiting its thread ID", () => {
    const tasks = [
      { id: "A", boundTaskId: "native-A", boundThreadId: null },
      { id: "B", boundTaskId: "native-B", boundThreadId: null },
    ];
    const delegations = [
      { id: "native-A", childThreadId: "child-A" },
      { id: "native-B", childThreadId: "child-B" },
    ];
    assert.deepStrictEqual(findPendingNativeAssignment(tasks, delegations, "child-A"), {
      taskId: "A",
      delegatedTaskId: "native-A",
      childThreadId: "child-A",
    });
    assert.equal(findPendingNativeAssignment(tasks, delegations, "unknown-child"), null);
    assert.equal(
      findPendingNativeAssignment(
        [{ ...tasks[0]!, boundThreadId: "child-A" }],
        delegations,
        "child-A",
      ),
      null,
    );
    assert.equal(
      findPendingNativeAssignment(
        [{ id: "B", boundTaskId: "native-B", boundThreadId: null }],
        delegations,
        "child-A",
      ),
      null,
    );
  });

  it.effect("allows a root plan create through the same wrapper without a binding", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* retryPendingTaskBinding(
        Effect.sync(() => {
          calls++;
          return { rootThreadId: "root", revision: 1, updated: true };
        }),
        false,
      );
      assert.deepStrictEqual(result, { rootThreadId: "root", revision: 1, updated: true });
      assert.equal(calls, 1);
    }),
  );

  it.effect("retries an idempotent worker mutation until the parent binds its delegation", () =>
    Effect.gen(function* () {
      const observedAttempts = yield* Queue.unbounded<number>();
      let attempts = 0;
      const mutation = Effect.suspend(() =>
        Effect.gen(function* () {
          attempts++;
          yield* Queue.offer(observedAttempts, attempts);
          if (attempts < 3) return yield* unbound();
          return "A1 added";
        }),
      );
      const retry = yield* Effect.forkChild(retryPendingTaskBinding(mutation, true, 3), {
        startImmediately: true,
      });
      assert.equal(yield* Queue.take(observedAttempts), 1);
      yield* TestClock.adjust("250 millis");
      assert.equal(yield* Queue.take(observedAttempts), 2);
      yield* TestClock.adjust("250 millis");
      assert.equal(yield* Queue.take(observedAttempts), 3);
      const result = yield* Fiber.join(retry);
      assert.equal(result, "A1 added");
      assert.equal(attempts, 3);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("does not retry authorization errors outside the caller's branch", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const result = yield* retryPendingTaskBinding(
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(new PlotlineStorageError({ message: "Task ID already exists." }));
        }),
        true,
        3,
      ).pipe(Effect.catch((error) => Effect.succeed(error)));
      assert.match(result.message, /Task ID already exists/);
      assert.equal(attempts, 1);
    }),
  );

  it.effect("never retries root mutations and gives a bounded error to unlinked workers", () =>
    Effect.gen(function* () {
      let calls = 0;
      const mutation = Effect.suspend(() => {
        calls++;
        return Effect.fail(unbound());
      });
      const root = yield* retryPendingTaskBinding(mutation, false).pipe(
        Effect.catch((error) => Effect.succeed(error)),
      );
      assert.match(root.message, /only under its assigned task/);
      assert.equal(calls, 1);
      const worker = yield* retryPendingTaskBinding(mutation, true, 0).pipe(
        Effect.catch((error) => Effect.succeed(error)),
      );
      assert.match(worker.message, /parent must call plotline_task_bind/);
      assert.equal(calls, 2);
    }),
  );
});
