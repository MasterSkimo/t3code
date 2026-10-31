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
    assert.throws(() => evolvePlan(plan, create, now), /already initialized/);
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
