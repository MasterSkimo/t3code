import { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import * as PlotlineDagService from "../plotline/PlotlineDagService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Events from "./events.ts";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const at = DateTime.makeUnsafe("2026-10-27T12:00:00.000Z");

const makeStoredRun = (index: number) => ({
  sequence: index,
  commandId: null,
  event: decodeEvent({
    id: `run-event-${index}`,
    type: "run.updated",
    threadId: "thread_persisted",
    runId: `run:${index}`,
    occurredAt: at,
    payload: {
      id: `run:${index}`,
      threadId: "thread_persisted",
      ordinal: index,
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "test" },
      providerThreadId: null,
      userMessageId: "message_user",
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  }),
});

it.effect(
  "durably resumes the cursor and drains more than one outbox page without duplicates",
  () => {
    const stored = Array.from({ length: 510 }, (_, index) => makeStoredRun(index + 1));
    const requestedCursors: Array<number> = [];
    let reconcileCalls = 0;
    const orchestrator = Orchestrator.OrchestratorV2.of({
      streamStoredEventsFrom: (input: { readonly afterSequence?: number } | undefined) => {
        const afterSequence = input?.afterSequence ?? 0;
        requestedCursors.push(afterSequence);
        return Stream.fromIterable(stored.filter((event) => event.sequence > afterSequence));
      },
    } as unknown as Orchestrator.OrchestratorV2["Service"]);
    const plotline = PlotlineDagService.PlotlineDagService.of({
      subscribe: () => Stream.empty,
      reconcileRun: () =>
        Effect.sync(() => {
          reconcileCalls += 1;
        }),
    } as unknown as PlotlineDagService.PlotlineDagService["Service"]);
    const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
      getInstance: () => Effect.sync(() => undefined),
    } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);
    const layer = Layer.mergeAll(
      SqlitePersistence.layerMemory,
      Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
      Layer.succeed(PlotlineDagService.PlotlineDagService, plotline),
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, providers),
    );

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const firstStore = yield* Events.makeStore;
      let sequence = 0;
      for (let attempt = 0; attempt < 20 && sequence < 510; attempt += 1) {
        const rows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM harness_event_cursor WHERE consumer_id = 'significant-events'
      `;
        sequence = rows[0]?.sequence ?? 0;
        if (sequence < 510) yield* TestClock.adjust("1 second");
      }
      const [dedupe] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM harness_significant_event_dedupe
    `;
      assert.strictEqual(sequence, 510);
      assert.strictEqual(dedupe?.count, 510);
      assert.strictEqual(reconcileCalls, 0, "Codex events must not reconcile Plotline tasks");

      const restartedStore = yield* Events.makeStore;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const rows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM harness_event_cursor WHERE consumer_id = 'significant-events'
      `;
        if ((rows[0]?.sequence ?? 0) >= 510) break;
        yield* TestClock.adjust("1 second");
      }
      assert.strictEqual(restartedStore.snapshot().length, 100);
      yield* TestClock.adjust("1 second");
      const [afterRestart] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM harness_significant_event_dedupe
    `;
      assert.strictEqual(afterRestart?.count, 510);
      assert.strictEqual(requestedCursors.at(-1), 10);

      let delivered = 0;
      yield* Stream.take(firstStore.stream, 510).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            delivered += 1;
            yield* firstStore.acknowledge(event.id);
          }),
        ),
      );
      assert.strictEqual(delivered, 510);
      const [pending] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM harness_significant_events WHERE delivery_status = 'pending'
    `;
      assert.strictEqual(pending?.count, 0);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("reconciles persisted OpenCode run events without verifying Plotline criteria", () => {
  const completedRun = makeStoredRun(1);
  const opencodeRun = {
    ...completedRun.event,
    payload: {
      ...completedRun.event.payload,
      providerInstanceId: "opencode",
      modelSelection: { instanceId: "opencode", model: "test" },
    },
  };
  const staleRun = { ...opencodeRun, payload: { ...opencodeRun.payload, id: "run:stale" } };
  const stored = [
    { ...completedRun, event: opencodeRun },
    { ...completedRun, sequence: 2, event: staleRun },
    { ...completedRun, sequence: 1, event: opencodeRun },
  ];
  const orchestrator = Orchestrator.OrchestratorV2.of({
    streamStoredEventsFrom: ({ afterSequence = 0 }: { readonly afterSequence?: number } = {}) =>
      Stream.fromIterable(stored.filter((event) => event.sequence > afterSequence)),
  } as unknown as Orchestrator.OrchestratorV2["Service"]);
  const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
    getInstance: () => Effect.succeed({ driverKind: "opencode" }),
  } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);
  const persistence = Layer.mergeAll(SqlitePersistence.layerMemory, NodeCrypto.layer);
  const layer = Layer.mergeAll(
    PlotlineDagService.layer.pipe(Layer.provideMerge(persistence)),
    Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, providers),
  );

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const dag = yield* plotline.createForProject("project:stored-run", "thread_persisted", null, {
      title: "Stored run reconciliation",
      description: "",
    });
    yield* plotline.addTasks("project:stored-run", {
      dagId: dag.id,
      tasks: [{ id: "task", title: "Task", description: "", effort: 1, dependsOn: [] }],
    });
    yield* plotline.updateTask("project:stored-run", {
      dagId: dag.id,
      taskId: "task",
      state: "running",
      threadId: completedRun.event.threadId,
      runId: "run:1",
      acceptanceCriteria: [{ id: "verified", description: "Explicit verification" }],
    });

    yield* Events.makeStore;
    yield* TestClock.adjust("1 second");
    const rows = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM harness_event_cursor WHERE consumer_id = 'significant-events'
    `;
    const cursor = rows[0]?.sequence ?? 0;

    // A fresh consumer replays the stored window; reconciliation and signal persistence stay idempotent.
    yield* Events.makeStore;
    yield* TestClock.adjust("1 second");

    const reconciled = yield* plotline.getForProject("project:stored-run", dag.id);
    const task = reconciled.tasks[0]!;
    assert.isAtLeast(cursor, 2);
    assert.strictEqual(task.state, "running", "a successful run is not explicit verification");
    assert.strictEqual(task.acceptanceCriteria?.length, 1);
    assert.strictEqual(task.verificationAttempts?.length ?? 0, 0);
    assert.strictEqual(task.runId, "run:1", "stale run IDs must not replace the indexed run");
    const [dedupe] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM harness_significant_event_dedupe
    `;
    assert.strictEqual(
      dedupe?.count,
      1,
      "replaying the same completion must not duplicate its signal",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("keeps deferred root candidates durable outside the bounded signal snapshot", () => {
  const event = {
    id: "success:root-run-event",
    at: "2026-10-27T12:00:00.000Z",
    threadId: "thread_root",
    projectId: "project_root",
    type: "successful_output" as const,
    summary: "The root run completed.",
    evidence: [],
    sourceRefs: ["run-event", "run:root"],
  };
  const orchestrator = Orchestrator.OrchestratorV2.of({
    streamStoredEventsFrom: () => Stream.empty,
  } as unknown as Orchestrator.OrchestratorV2["Service"]);
  const plotline = PlotlineDagService.PlotlineDagService.of({
    subscribe: () => Stream.empty,
    reconcileRun: () => Effect.void,
  } as unknown as PlotlineDagService.PlotlineDagService["Service"]);
  const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
    getInstance: () => Effect.sync(() => undefined),
  } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);
  const layer = Layer.mergeAll(
    SqlitePersistence.layerMemory,
    Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
    Layer.succeed(PlotlineDagService.PlotlineDagService, plotline),
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, providers),
  );

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const firstStore = yield* Events.makeStore;
    yield* firstStore.enqueueRootCandidate({
      eventId: event.id,
      projectId: event.projectId,
      rootThreadId: event.threadId,
      runId: "run:root",
      event,
      at: event.at,
    });
    for (let sequence = 1; sequence <= 101; sequence += 1) {
      const signal = { ...event, id: `signal:${sequence}` };
      yield* sql`INSERT INTO harness_significant_events (event_id, sequence, payload_json, created_at)
        VALUES (${signal.id}, ${sequence}, ${JSON.stringify(signal)}, ${signal.at})`;
    }

    const restartedStore = yield* Events.makeStore;
    assert.strictEqual(restartedStore.snapshot().length, 100);
    assert.isFalse(restartedStore.snapshot().some((signal) => signal.id === event.id));
    const pending = yield* restartedStore.pendingRootCandidates();
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0]?.eventId, event.id);

    yield* restartedStore.failRootCandidate(event.id, "projection unavailable");
    assert.strictEqual((yield* restartedStore.pendingRootCandidates())[0]?.deliveryAttempts, 1);
    yield* restartedStore.failRootCandidate(event.id, "projection unavailable");
    assert.strictEqual((yield* restartedStore.pendingRootCandidates())[0]?.deliveryAttempts, 2);
    yield* restartedStore.failRootCandidate(event.id, "projection unavailable");
    const exhausted = yield* restartedStore.pendingRootCandidates();
    assert.strictEqual(exhausted.length, 0);
    const rows = yield* sql<{ readonly status: string; readonly delivery_attempts: number }>`
      SELECT status, delivery_attempts FROM harness_root_candidates WHERE event_id = ${event.id}
    `;
    assert.deepStrictEqual(rows, [{ status: "failed", delivery_attempts: 3 }]);
  }).pipe(Effect.provide(layer));
});
