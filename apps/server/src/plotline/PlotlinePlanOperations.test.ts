import { assert, describe, it } from "@effect/vitest";
import type { PlotlinePlan } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { evolvePlan } from "./PlotlinePlanOperations.ts";
import * as Store from "./PlotlineStore.ts";

const now = "2026-10-31T00:00:00Z";
const root = "thread-root";
const creator = "thread-root";
const create = {
  kind: "create" as const,
  rootThreadId: root,
  actorThreadId: creator,
  input: {
    requestId: "init",
    title: "Architecture audit",
    tasks: [
      { id: "A", title: "Database" },
      { id: "B", title: "Backend" },
      { id: "D", title: "Persistence review", dependsOn: ["A", "B"] },
    ],
  },
};

describe("dynamic Plotline planning", () => {
  it("initializes a DAG, rejects dependency cycles and never starts any run", () => {
    const plan = evolvePlan(null, create, now);
    assert.equal(plan.revision, 1);
    assert.deepStrictEqual(plan.tasks[2]?.dependsOn, ["A", "B"]);
    assert.throws(() => evolvePlan(plan, {
      kind: "update", rootThreadId: root, actorThreadId: creator,
      input: { requestId: "cycle", taskId: "A", dependsOn: ["D"] },
    }, now), /cycle/);
    // A repeated create is a no-op, even when the original tool response was lost.
    assert.strictEqual(evolvePlan(plan, create, now), plan);
    assert.throws(() => evolvePlan(plan, {
      ...create, input: { ...create.input, title: "Conflicting plan" },
    }, now), /different tasks/);
  });

  it("lets assigned workers discover tasks but prevents cross-worker edits", () => {
    const initial = evolvePlan(null, create, now);
    const assigned = evolvePlan(initial, {
      kind: "bind", rootThreadId: root, actorThreadId: root,
      input: { requestId: "bind", taskId: "A", delegatedTaskId: "node-native-A", childThreadId: "child-A" },
    }, now);
    const updated = evolvePlan(assigned, {
      kind: "add", rootThreadId: root, actorThreadId: "child-A",
      input: {
        requestId: "discovery",
        task: { id: "A1", title: "Investigate migration", parentTaskId: "A", dependsOn: ["A"] },
      },
    }, now);
    assert.equal(updated.tasks[3]?.createdByThreadId, "child-A");
    const nestedBound = evolvePlan(updated, {
      kind: "bind", rootThreadId: root, actorThreadId: "child-A",
      input: { requestId: "bind-A1", taskId: "A1", delegatedTaskId: "node-native-A1", childThreadId: "child-A1" },
    }, now);
    assert.equal(nestedBound.tasks[3]?.boundTaskId, "node-native-A1");
    // Retries reuse the planned task once the previous native attempt settled.
    assert.throws(() => evolvePlan(assigned, {
      kind: "bind", rootThreadId: root, actorThreadId: root,
      input: { requestId: "retry-running", taskId: "A", delegatedTaskId: "node-native-A2", childThreadId: "child-A2" },
    }, now), /must be terminal/);
    const retried = evolvePlan(assigned, {
      kind: "bind", rootThreadId: root, actorThreadId: root,
      previousDelegationTerminal: true,
      input: { requestId: "retry-finished", taskId: "A", delegatedTaskId: "node-native-A2", childThreadId: "child-A2" },
    }, now);
    assert.equal(retried.tasks.length, assigned.tasks.length);
    assert.equal(retried.tasks[0]?.boundThreadId, "child-A2");
    assert.deepStrictEqual(retried.tasks[0]?.bindingHistory, [
      { delegatedTaskId: "node-native-A", childThreadId: "child-A" },
    ]);
    const sameAttempt = evolvePlan(retried, {
      kind: "bind", rootThreadId: root, actorThreadId: root,
      input: { requestId: "retry-replay", taskId: "A", delegatedTaskId: "node-native-A2", childThreadId: "child-A2" },
    }, now);
    assert.deepStrictEqual(sameAttempt.tasks[0]?.bindingHistory, retried.tasks[0]?.bindingHistory);
    assert.throws(() => evolvePlan(updated, {
      kind: "bind", rootThreadId: root, actorThreadId: "child-B",
      input: { requestId: "bad-bind", taskId: "A1", delegatedTaskId: "foreign-node", childThreadId: "other" },
    }, now), /only subtasks they created/);
    assert.throws(() => evolvePlan(updated, {
      kind: "update", rootThreadId: root, actorThreadId: "child-B",
      input: { requestId: "foreign", taskId: "A1", title: "Unauthorized" },
    }, now), /assigned tasks/);
    assert.throws(() => evolvePlan(updated, {
      kind: "add", rootThreadId: root, actorThreadId: "child-B",
      input: { requestId: "foreign-add", task: { id: "B1", title: "Unauthorized", parentTaskId: "A" } },
    }, now), /assigned task/);
  });

  it("completes an unbound worker discovery but never overrides native execution", () => {
    const initial = evolvePlan(null, create, now);
    const delegated = evolvePlan(initial, {
      kind: "bind", rootThreadId: root, actorThreadId: root,
      input: { requestId: "bind-A", taskId: "A", delegatedTaskId: "node-A", childThreadId: "child-A" },
    }, now);
    const discovered = evolvePlan(delegated, {
      kind: "add", rootThreadId: root, actorThreadId: "child-A",
      input: { requestId: "add-A1", task: { id: "A1", title: "Finish A1", parentTaskId: "A" } },
    }, now);
    const completed = evolvePlan(discovered, {
      kind: "update", rootThreadId: root, actorThreadId: "child-A",
      input: { requestId: "finish-A1", taskId: "A1", planState: "completed" },
    }, now);
    assert.equal(completed.tasks.find((task) => task.id === "A1")?.planState, "completed");
    assert.equal(completed.tasks.find((task) => task.id === "A")?.planState, "planned");
    assert.throws(() => evolvePlan(completed, {
      kind: "update", rootThreadId: root, actorThreadId: "child-A",
      input: { requestId: "fake-native-completion", taskId: "A", planState: "completed" },
    }, now), /native execution status/);
    assert.throws(() => evolvePlan(completed, {
      kind: "update", rootThreadId: root, actorThreadId: "child-B",
      input: { requestId: "foreign-completion", taskId: "A1", planState: "completed" },
    }, now), /assigned tasks/);
    assert.throws(() => evolvePlan(completed, {
      kind: "bind", rootThreadId: root, actorThreadId: root,
      input: { requestId: "bind-settled", taskId: "A1", delegatedTaskId: "native-A1", childThreadId: "child-A1" },
    }, now), /Reset a settled plan task/);
    const reopened = evolvePlan(completed, {
      kind: "update", rootThreadId: root, actorThreadId: root,
      input: { requestId: "reopen-A1", taskId: "A1", planState: "planned" },
    }, now);
    assert.equal(reopened.tasks.find((task) => task.id === "A1")?.planState, "planned");
    assert.equal(evolvePlan(reopened, {
      kind: "bind", rootThreadId: root, actorThreadId: root,
      input: { requestId: "bind-reopened", taskId: "A1", delegatedTaskId: "native-A1", childThreadId: "child-A1" },
    }, now).tasks.find((task) => task.id === "A1")?.boundTaskId, "native-A1");
  });

  it("persists manual completion and deduplicates a retry without a second revision", () =>
    Effect.gen(function* () {
      const store = yield* Store.PlotlineStore;
      yield* store.mutatePlan(create);
      const completion = {
        kind: "update" as const, rootThreadId: root, actorThreadId: root,
        input: { requestId: "complete-D", taskId: "D", planState: "completed" as const },
      };
      const first = yield* store.mutatePlan(completion);
      const replay = yield* store.mutatePlan(completion);
      assert.equal(first.revision, 2);
      assert.equal(replay.revision, 2);
      assert.equal(replay.updated, false);
      const persisted = yield* store.getPlan(root);
      assert.equal(persisted?.tasks.find((task) => task.id === "D")?.planState, "completed");
    }).pipe(Effect.provide(Store.layerMemory)),
  );

  it("persists plan revisions and deduplicates a retried mutation", () =>
    Effect.gen(function* () {
      const store = yield* Store.PlotlineStore;
      const first = yield* store.mutatePlan(create);
      assert.equal(first.revision, 1);
      assert.equal(first.updated, true);
      const repeated = yield* store.mutatePlan(create);
      assert.equal(repeated.revision, 1);
      assert.equal(repeated.updated, false);
      const update = yield* store.mutatePlan({
        kind: "update", rootThreadId: root, actorThreadId: root,
        input: { requestId: "skip-D", taskId: "D", planState: "skipped", reason: "Analysis unnecessary" },
      });
      assert.equal(update.revision, 2);
      const plan = yield* store.getPlan(root);
      assert.equal(plan?.tasks.find((task) => task.id === "D")?.planState, "skipped");
      assert.equal(plan?.tasks.find((task) => task.id === "D")?.reason, "Analysis unnecessary");
    }).pipe(Effect.provide(Store.layerMemory)),
  );

  it("persists successive native attempts and replays the same request without duplicates", () =>
    Effect.gen(function* () {
      const store = yield* Store.PlotlineStore;
      yield* store.mutatePlan(create);
      const first = {
        kind: "bind" as const, rootThreadId: root, actorThreadId: root,
        input: { requestId: "native-A", taskId: "A", delegatedTaskId: "node-A", childThreadId: "child-A" },
      };
      const retry = {
        kind: "bind" as const, rootThreadId: root, actorThreadId: root,
        previousDelegationTerminal: true,
        input: { requestId: "retry-native-A", taskId: "A", delegatedTaskId: "node-A2", childThreadId: "child-A2" },
      };
      yield* store.mutatePlan(first);
      const second = yield* store.mutatePlan(retry);
      assert.equal(second.revision, 3);
      const replay = yield* store.mutatePlan({ ...retry, previousDelegationTerminal: false });
      assert.equal(replay.updated, false);
      const stored = yield* store.getPlan(root);
      assert.equal(stored?.tasks[0]?.boundTaskId, "node-A2");
      assert.deepStrictEqual(stored?.tasks[0]?.bindingHistory, [
        { delegatedTaskId: "node-A", childThreadId: "child-A" },
      ]);
      assert.throws(() => evolvePlan(stored!, {
        kind: "bind", rootThreadId: root, actorThreadId: root, previousDelegationTerminal: true,
        input: { requestId: "reuse-old", taskId: "B", delegatedTaskId: "node-A", childThreadId: "child-A" },
      }, now), /another plan task/);
    }).pipe(Effect.provide(Store.layerMemory)),
  );

  it("accepts a create without requestId and avoids duplicate revisions on retransmission", () =>
    Effect.gen(function* () {
      const store = yield* Store.PlotlineStore;
      const generated = {
        ...create,
        input: { title: create.input.title, tasks: create.input.tasks },
      };
      const first = yield* store.mutatePlan(generated);
      assert.equal(first.updated, true);
      const replay = yield* store.mutatePlan(generated);
      assert.equal(replay.updated, false);
      assert.equal(replay.revision, 1);
      const alternateId = yield* store.mutatePlan({
        ...create, input: { ...create.input, requestId: "different-request-id" },
      });
      assert.equal(alternateId.updated, false);
      assert.equal(alternateId.revision, 1);
      const plan = yield* store.getPlan(root);
      assert.equal(plan?.tasks.length, 3);
      const events = yield* store.mutatePlan({
        kind: "update", rootThreadId: root, actorThreadId: root,
        input: { requestId: "done", taskId: "D", planState: "cancelled", reason: "Not needed" },
      });
      assert.equal(events.revision, 2);
    }).pipe(Effect.provide(Store.layerMemory)),
  );

  it("records simultaneous discoveries without overwriting either task", () =>
    Effect.gen(function* () {
      const store = yield* Store.PlotlineStore;
      yield* store.mutatePlan(create);
      yield* Effect.all([
        store.mutatePlan({
          kind: "add", rootThreadId: root, actorThreadId: root,
          input: { requestId: "add-E", task: { id: "E", title: "Visual audit", dependsOn: ["B"] } },
        }),
        store.mutatePlan({
          kind: "add", rootThreadId: root, actorThreadId: root,
          input: { requestId: "add-F", task: { id: "F", title: "Final review", dependsOn: ["D"] } },
        }),
      ], { concurrency: 2 });
      const plan = yield* store.getPlan(root);
      assert.deepStrictEqual(plan?.tasks.map((task) => task.id).sort(), ["A", "B", "D", "E", "F"]);
      assert.equal(plan?.revision, 3);
    }).pipe(Effect.provide(Store.layerMemory)),
  );
});
