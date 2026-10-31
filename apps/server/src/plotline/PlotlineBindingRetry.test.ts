import { assert, describe, it } from "@effect/vitest";
import { PlotlineStorageError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { retryPendingTaskBinding } from "./PlotlineBindingRetry.ts";

const unbound = () => new PlotlineStorageError({
  message: "A worker may add subtasks only under its assigned task.",
});

describe("Plotline worker binding race", () => {
  it.effect("retries an idempotent worker mutation until the parent binds its delegation", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const mutation = Effect.suspend(() => {
        attempts++;
        return attempts < 3 ? Effect.fail(unbound()) : Effect.succeed("A1 added");
      });
      const result = yield* retryPendingTaskBinding(mutation, true, 3);
      assert.equal(result, "A1 added");
      assert.equal(attempts, 3);
    }),
  );

  it.effect("does not retry authorization errors outside the caller's branch", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const result = yield* Effect.either(retryPendingTaskBinding(
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(new PlotlineStorageError({ message: "Task ID already exists." }));
        }),
        true,
        3,
      ));
      assert.equal(result._tag, "Left");
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
      const root = yield* Effect.either(retryPendingTaskBinding(mutation, false));
      assert.equal(root._tag, "Left");
      assert.equal(calls, 1);
      const worker = yield* Effect.either(retryPendingTaskBinding(mutation, true, 0));
      assert.equal(worker._tag, "Left");
      if (worker._tag === "Left")
        assert.match(worker.left.message, /parent must call plotline_task_bind/);
      assert.equal(calls, 2);
    }),
  );
});
