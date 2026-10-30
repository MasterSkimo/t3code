import { OrchestrationV2DomainEvent, PlotlineDagError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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

const makeStoredSubagent = (status: "cancelled" | "interrupted" | "failed" | "completed") => ({
  sequence: 1,
  commandId: null,
  event: decodeEvent({
    id: `subagent-event-${status}`,
    type: "subagent.updated",
    threadId: "thread_parent",
    occurredAt: at,
    payload: {
      id: "node:correction-child",
      threadId: "thread_parent",
      runId: "run:correction-child",
      parentNodeId: "node:parent",
      origin: "app_owned",
      createdBy: "agent",
      driver: "opencode",
      providerInstanceId: "opencode",
      providerThreadId: null,
      childThreadId: "thread_correction_child",
      nativeTaskRef: null,
      prompt: "Apply the correction",
      title: "Correction",
      model: null,
      status,
      result: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
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
      getInstance: () => Effect.void,
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
    const [reconciliations] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM harness_opencode_reconciliation
    `;
    assert.strictEqual(
      dedupe?.count,
      1,
      "replaying the same completion must not duplicate its signal",
    );
    assert.strictEqual(
      reconciliations?.count,
      1,
      "replaying duplicate stored run events must not duplicate reconciliation delivery",
    );
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect(
  "settles linked app-owned correction children from persisted terminal events and replays idempotently",
  () => {
    const terminal = makeStoredSubagent("cancelled");
    const duplicate = { ...terminal, sequence: 2 };
    const interrupted = {
      ...makeStoredSubagent("interrupted"),
      sequence: 3,
      event: {
        ...makeStoredSubagent("interrupted").event,
        id: "subagent-event-interrupted",
        payload: {
          ...makeStoredSubagent("interrupted").event.payload,
          id: "node:correction-child-2",
          childThreadId: "thread_correction_child_2",
          runId: "run:correction-child-2",
        },
      },
    };
    const orchestrator = Orchestrator.OrchestratorV2.of({
      streamStoredEventsFrom: ({ afterSequence = 0 }: { readonly afterSequence?: number } = {}) =>
        Stream.fromIterable(
          [terminal, duplicate, interrupted].filter((event) => event.sequence > afterSequence),
        ),
    } as unknown as Orchestrator.OrchestratorV2["Service"]);
    const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
      getInstance: () => Effect.void,
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
      const dag = yield* plotline.createForProject(
        "project:correction-terminal",
        "thread_parent",
        null,
        {
          title: "Correction settlement",
          description: "",
        },
      );
      yield* plotline.addTasks("project:correction-terminal", {
        dagId: dag.id,
        tasks: [{ id: "task", title: "Task", description: "", effort: 1, dependsOn: [] }],
      });
      yield* plotline.updateTask("project:correction-terminal", {
        dagId: dag.id,
        taskId: "task",
        acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
      });
      yield* plotline.recordVerificationAttempt("project:correction-terminal", {
        dagId: dag.id,
        taskId: "task",
        attemptId: "failed-verification",
        expectedCriteriaVersion: 2,
        expectedRunId: null,
        verdict: "fail",
        summary: "The test failed.",
        criterionResults: [
          { criterionId: "works", verdict: "fail", evidence: "Assertion failed." },
        ],
      });
      const reserved = yield* plotline.beginCorrection("project:correction-terminal", {
        dagId: dag.id,
        taskId: "task",
        verificationAttemptId: "failed-verification",
        expectedCriteriaVersion: 2,
        expectedRunId: null,
      });
      if (!reserved.correction) throw new Error("Expected a reserved correction.");
      yield* plotline.linkCorrection("project:correction-terminal", {
        dagId: dag.id,
        taskId: "task",
        correctionId: reserved.correction.id,
        childTaskId: "child-task",
        childThreadId: "thread_correction_child" as never,
        childRunId: "run:correction-child",
      });
      yield* plotline.addTasks("project:correction-terminal", {
        dagId: dag.id,
        tasks: [{ id: "task-2", title: "Task 2", description: "", effort: 1, dependsOn: [] }],
      });
      yield* plotline.updateTask("project:correction-terminal", {
        dagId: dag.id,
        taskId: "task-2",
        acceptanceCriteria: [{ id: "works-2", description: "Behavior works" }],
      });
      yield* plotline.recordVerificationAttempt("project:correction-terminal", {
        dagId: dag.id,
        taskId: "task-2",
        attemptId: "failed-verification-2",
        expectedCriteriaVersion: 2,
        expectedRunId: null,
        verdict: "fail",
        summary: "The test failed.",
        criterionResults: [
          { criterionId: "works-2", verdict: "fail", evidence: "Assertion failed." },
        ],
      });
      const reserved2 = yield* plotline.beginCorrection("project:correction-terminal", {
        dagId: dag.id,
        taskId: "task-2",
        verificationAttemptId: "failed-verification-2",
        expectedCriteriaVersion: 2,
        expectedRunId: null,
      });
      if (!reserved2.correction) throw new Error("Expected a second reserved correction.");
      yield* plotline.linkCorrection("project:correction-terminal", {
        dagId: dag.id,
        taskId: "task-2",
        correctionId: reserved2.correction.id,
        childTaskId: "child-task-2",
        childThreadId: "thread_correction_child_2" as never,
        childRunId: "run:correction-child-2",
      });

      yield* sql`INSERT INTO harness_opencode_reconciliation
      (event_id, sequence, thread_id, run_id, run_status, event_kind, status, next_attempt_at, created_at, updated_at)
      VALUES ('blocked-opencode-run', 0, 'thread_correction_child', 'run:correction-child',
        'completed', 'opencode_run', 'failed', '2999-01-01T00:00:00.000Z',
        ${DateTime.formatIso(at)}, ${DateTime.formatIso(at)})`;
      const delivery = yield* Events.makeStore.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(delivery);
      const [reconciliation] = yield* sql<{
        readonly status: string;
        readonly failure_detail: string | null;
        readonly delivery_attempts: number;
      }>`
      SELECT status, failure_detail, delivery_attempts FROM harness_opencode_reconciliation WHERE event_id = 'subagent-event-cancelled'
    `;
      const task = (yield* plotline.getForProject("project:correction-terminal", dag.id)).tasks[0]!;
      assert.deepStrictEqual(reconciliation, {
        status: "complete",
        failure_detail: null,
        delivery_attempts: 1,
      });
      assert.strictEqual(task.correctionAttempts?.[0]?.state, "cancelled");
      assert.strictEqual(task.executionLifecycle, "failed_escalated");
      assert.strictEqual(
        task.verificationAttempts?.length,
        1,
        "terminal child status is not a verifier call",
      );
      const second = (yield* plotline.getForProject(
        "project:correction-terminal",
        dag.id,
      )).tasks.find((candidate) => candidate.id === "task-2")!;
      assert.strictEqual(second.correctionAttempts?.[0]?.state, "interrupted");
      assert.strictEqual(second.executionLifecycle, "failed_escalated");
      assert.strictEqual(
        second.verificationAttempts?.length,
        1,
        "interruption is not a verifier call",
      );
      const [interruptedOutbox] = yield* sql<{
        readonly event_kind: string;
        readonly run_status: string;
      }>`
      SELECT event_kind, run_status FROM harness_opencode_reconciliation
      WHERE event_id = 'subagent-event-interrupted'
    `;
      assert.deepStrictEqual(interruptedOutbox, {
        event_kind: "correction_child",
        run_status: "interrupted",
      });

      const [outbox] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM harness_opencode_reconciliation
      WHERE event_id = 'subagent-event-cancelled'
    `;
      assert.strictEqual(
        outbox?.count,
        1,
        "duplicate persisted event delivery must not duplicate the outbox item",
      );
      yield* Events.makeStore;
      yield* TestClock.adjust("1 second");
      const [afterRestart] = yield* sql<{ readonly delivery_attempts: number }>`
      SELECT delivery_attempts FROM harness_opencode_reconciliation
      WHERE event_id = 'subagent-event-cancelled'
    `;
      assert.strictEqual(
        afterRestart?.delivery_attempts,
        1,
        "completed settlement must not replay after restart",
      );
      assert.strictEqual(
        (yield* plotline.getForProject("project:correction-terminal", dag.id)).tasks[0]!
          .correctionAttempts?.[0]?.state,
        "cancelled",
      );
    }).pipe(Effect.provide(layer), Effect.scoped);
  },
);

it.effect("reconciles an acknowledged terminal correction child after it is linked", () => {
  const terminal = makeStoredSubagent("cancelled");
  const unrelated = {
    ...makeStoredSubagent("completed"),
    sequence: 2,
    event: {
      ...makeStoredSubagent("completed").event,
      id: "subagent-event-unrelated",
      payload: {
        ...makeStoredSubagent("completed").event.payload,
        id: "node:unrelated-child",
        childThreadId: "thread_unrelated_child",
        runId: "run:unrelated-child",
      },
    },
  };
  const orchestrator = Orchestrator.OrchestratorV2.of({
    streamStoredEventsFrom: ({ afterSequence = 0 }: { readonly afterSequence?: number } = {}) =>
      Stream.fromIterable([terminal, unrelated].filter((event) => event.sequence > afterSequence)),
  } as unknown as Orchestrator.OrchestratorV2["Service"]);
  const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
    getInstance: () => Effect.void,
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
    const dag = yield* plotline.createForProject("project:correction-race", "thread_parent", null, {
      title: "Correction race",
      description: "",
    });
    yield* plotline.addTasks("project:correction-race", {
      dagId: dag.id,
      tasks: [{ id: "task", title: "Task", description: "", effort: 1, dependsOn: [] }],
    });
    yield* plotline.updateTask("project:correction-race", {
      dagId: dag.id,
      taskId: "task",
      acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
    });
    yield* plotline.recordVerificationAttempt("project:correction-race", {
      dagId: dag.id,
      taskId: "task",
      attemptId: "failed-verification",
      expectedCriteriaVersion: 2,
      expectedRunId: null,
      verdict: "fail",
      summary: "The test failed.",
      criterionResults: [{ criterionId: "works", verdict: "fail", evidence: "Assertion failed." }],
    });
    const reserved = yield* plotline.beginCorrection("project:correction-race", {
      dagId: dag.id,
      taskId: "task",
      verificationAttemptId: "failed-verification",
      expectedCriteriaVersion: 2,
      expectedRunId: null,
    });
    if (!reserved.correction) throw new Error("Expected a reserved correction.");
    yield* sql`INSERT INTO orchestration_events
      (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
       actor_kind, payload_json, metadata_json)
      VALUES (${terminal.sequence}, ${terminal.event.id}, 'thread', 'thread_parent', 1,
        'subagent.updated', ${DateTime.formatIso(at)}, 'agent',
        ${JSON.stringify(terminal.event.payload)}, '{}')`;
    yield* sql`INSERT INTO orchestration_events
      (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
       actor_kind, payload_json, metadata_json)
      VALUES (${unrelated.sequence}, ${unrelated.event.id}, 'thread', 'thread_parent', 2,
        'subagent.updated', ${DateTime.formatIso(at)}, 'agent',
        ${JSON.stringify(unrelated.event.payload)}, '{}')`;
    yield* sql`INSERT INTO harness_opencode_reconciliation
      (event_id, sequence, thread_id, run_id, run_status, event_kind, status, delivery_attempts, created_at, updated_at)
      VALUES ('subagent-event-cancelled', 1, 'thread_correction_child', 'run:correction-child',
        'cancelled', 'correction_child', 'awaiting_link', 1, ${DateTime.formatIso(at)}, ${DateTime.formatIso(at)})`;

    const store = yield* Events.makeStore;
    yield* TestClock.adjust("1 second");
    const [acknowledged] = yield* sql<{ readonly status: string }>`
      SELECT status FROM harness_opencode_reconciliation WHERE event_id = 'subagent-event-cancelled'
    `;
    assert.deepStrictEqual(acknowledged, { status: "awaiting_link" });
    const [unlinked] = yield* sql<{
      readonly status: string;
      readonly delivery_attempts: number;
    }>`SELECT status, delivery_attempts FROM harness_opencode_reconciliation
      WHERE event_id = 'subagent-event-unrelated'`;
    assert.deepStrictEqual(unlinked, { status: "awaiting_link", delivery_attempts: 1 });

    yield* sql`INSERT INTO harness_opencode_reconciliation
      (event_id, sequence, thread_id, run_id, run_status, event_kind, status, delivery_attempts, created_at, updated_at)
      VALUES ('subagent-event-delivering', 3, 'thread_correction_child', 'run:correction-child',
        'cancelled', 'correction_child', 'delivering', 1, ${DateTime.formatIso(at)}, ${DateTime.formatIso(at)})`;
    yield* plotline.linkCorrection("project:correction-race", {
      dagId: dag.id,
      taskId: "task",
      correctionId: reserved.correction.id,
      childTaskId: "child-task",
      childThreadId: "thread_correction_child" as never,
      childRunId: "run:correction-child",
    });
    const requeued = yield* sql<{ readonly status: string }>`
      SELECT status FROM harness_opencode_reconciliation
      WHERE event_id IN ('subagent-event-cancelled', 'subagent-event-delivering')
      ORDER BY event_id`;
    assert.deepStrictEqual(requeued, [{ status: "pending" }, { status: "pending" }]);
    // Simulate a crash after linkCorrection commits but before the handler can run
    // its follow-up reconciliation operation. A fresh store must replay the outbox.
    yield* Events.makeStore;
    yield* TestClock.adjust("1 second");

    const [outbox] = yield* sql<{ readonly status: string; readonly delivery_attempts: number }>`
      SELECT status, delivery_attempts FROM harness_opencode_reconciliation
      WHERE event_id = 'subagent-event-cancelled'
    `;
    const task = (yield* plotline.getForProject("project:correction-race", dag.id)).tasks[0]!;
    assert.deepStrictEqual(outbox, { status: "complete", delivery_attempts: 2 });
    assert.strictEqual(task.correctionAttempts?.[0]?.state, "cancelled");
    assert.strictEqual(task.executionLifecycle, "failed_escalated");

    yield* store.reconcileCorrectionChild({
      childThreadId: "thread_correction_child",
      childRunId: "run:correction-child",
    });
    yield* TestClock.adjust("1 second");
    const [replayed] = yield* sql<{ readonly delivery_attempts: number }>`
      SELECT delivery_attempts FROM harness_opencode_reconciliation
      WHERE event_id = 'subagent-event-cancelled'
    `;
    assert.strictEqual(replayed?.delivery_attempts, 2, "link replay must remain idempotent");
    const [stillUnlinked] = yield* sql<{ readonly delivery_attempts: number }>`
      SELECT delivery_attempts FROM harness_opencode_reconciliation
      WHERE event_id = 'subagent-event-unrelated'
    `;
    assert.strictEqual(stillUnlinked?.delivery_attempts, 1);
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("isolates OpenCode reconciliation failures and persists bounded retry visibility", () => {
  let attempts = 0;
  const orchestrator = Orchestrator.OrchestratorV2.of({
    streamStoredEventsFrom: () => Stream.empty,
  } as unknown as Orchestrator.OrchestratorV2["Service"]);
  const plotline = PlotlineDagService.PlotlineDagService.of({
    subscribe: () => Stream.empty,
    reconcileRun: () =>
      Effect.gen(function* () {
        attempts += 1;
        return yield* new PlotlineDagError({ message: "Plotline unavailable" });
      }),
  } as unknown as PlotlineDagService.PlotlineDagService["Service"]);
  const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
    getInstance: () => Effect.succeed({ driverKind: "opencode" }),
  } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);
  const layer = Layer.mergeAll(
    SqlitePersistence.layerMemory,
    Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
    Layer.succeed(PlotlineDagService.PlotlineDagService, plotline),
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, providers),
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO harness_opencode_reconciliation
      (event_id, sequence, thread_id, run_id, run_status, created_at, updated_at)
      VALUES ('run-event-failed', 1, 'thread_persisted', 'run:1', 'completed', ${DateTime.formatIso(at)}, ${DateTime.formatIso(at)})`;
    const queued = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM harness_opencode_reconciliation WHERE status = 'pending'
    `;
    assert.strictEqual(queued[0]?.count, 1);
    const delivery = yield* Events.makeStore.pipe(Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust("10 seconds");
    yield* Fiber.join(delivery);
    const rows = yield* sql<{
      readonly status: string;
      readonly delivery_attempts: number;
      readonly failure_detail: string | null;
    }>`SELECT status, delivery_attempts, failure_detail FROM harness_opencode_reconciliation WHERE event_id = 'run-event-failed'`;
    assert.isAtLeast(attempts, 3, "the initial attempt and bounded retries should run");
    assert.deepStrictEqual(rows, [
      {
        status: "failed",
        delivery_attempts: attempts,
        failure_detail: "Plotline unavailable",
      },
    ]);
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("replays a pending reconciliation after restart and recovers transient failure", () => {
  let attempts = 0;
  const orchestrator = Orchestrator.OrchestratorV2.of({
    streamStoredEventsFrom: () => Stream.empty,
  } as unknown as Orchestrator.OrchestratorV2["Service"]);
  const plotline = PlotlineDagService.PlotlineDagService.of({
    subscribe: () => Stream.empty,
    reconcileRun: () =>
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(new PlotlineDagError({ message: "temporary outage" }))
          : Effect.void;
      }),
  } as unknown as PlotlineDagService.PlotlineDagService["Service"]);
  const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
    getInstance: () => Effect.succeed({ driverKind: "opencode" }),
  } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);
  const layer = Layer.mergeAll(
    SqlitePersistence.layerMemory,
    Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
    Layer.succeed(PlotlineDagService.PlotlineDagService, plotline),
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, providers),
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO harness_opencode_reconciliation
      (event_id, sequence, thread_id, run_id, run_status, status, created_at, updated_at)
      VALUES ('run-event-restarted', 1, 'thread_persisted', 'run:1', 'completed', 'pending', ${DateTime.formatIso(at)}, ${DateTime.formatIso(at)})`;
    const delivery = yield* Events.makeStore.pipe(Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust("3 seconds");
    yield* Fiber.join(delivery);
    const rows = yield* sql<{
      readonly status: string;
      readonly delivery_attempts: number;
      readonly failure_detail: string | null;
    }>`SELECT status, delivery_attempts, failure_detail FROM harness_opencode_reconciliation WHERE event_id = 'run-event-restarted'`;
    assert.strictEqual(attempts, 2, "restart replay should retry a transient failure");
    assert.deepStrictEqual(rows, [
      { status: "complete", delivery_attempts: 2, failure_detail: null },
    ]);
    yield* Events.makeStore;
    assert.strictEqual(attempts, 2, "completed outbox entries must not be delivered twice");
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("keeps retrying an exhausted delivery and clears its failure after recovery", () => {
  let attempts = 0;
  return Effect.gen(function* () {
    const recovered = yield* Deferred.make<void>();
    const orchestrator = Orchestrator.OrchestratorV2.of({
      streamStoredEventsFrom: () => Stream.empty,
    } as unknown as Orchestrator.OrchestratorV2["Service"]);
    const plotline = PlotlineDagService.PlotlineDagService.of({
      subscribe: () => Stream.empty,
      reconcileRun: () =>
        Effect.suspend(() => {
          attempts += 1;
          if (attempts <= 3)
            return Effect.fail(new PlotlineDagError({ message: "Plotline unavailable" }));
          return Deferred.succeed(recovered, undefined);
        }),
    } as unknown as PlotlineDagService.PlotlineDagService["Service"]);
    const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
      getInstance: () => Effect.succeed({ driverKind: "opencode" }),
    } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);
    const layer = Layer.mergeAll(
      SqlitePersistence.layerMemory,
      Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
      Layer.succeed(PlotlineDagService.PlotlineDagService, plotline),
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, providers),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO harness_opencode_reconciliation
      (event_id, sequence, thread_id, run_id, run_status, created_at, updated_at)
      VALUES ('run-event-recover', 1, 'thread_persisted', 'run:recover', 'completed', ${DateTime.formatIso(at)}, ${DateTime.formatIso(at)})`;
      yield* Events.makeStore;
      yield* TestClock.adjust("3 seconds");
      const [failed] = yield* sql<{
        readonly status: string;
        readonly delivery_attempts: number;
        readonly failure_detail: string | null;
      }>`SELECT status, delivery_attempts, failure_detail FROM harness_opencode_reconciliation WHERE event_id = 'run-event-recover'`;
      assert.deepStrictEqual(failed, {
        status: "failed",
        delivery_attempts: 3,
        failure_detail: "Plotline unavailable",
      });

      yield* TestClock.adjust("4 seconds");
      yield* Deferred.await(recovered);
      const [complete] = yield* sql<{
        readonly status: string;
        readonly delivery_attempts: number;
        readonly failure_detail: string | null;
      }>`SELECT status, delivery_attempts, failure_detail FROM harness_opencode_reconciliation WHERE event_id = 'run-event-recover'`;
      assert.deepStrictEqual(complete, {
        status: "complete",
        delivery_attempts: 4,
        failure_detail: null,
      });
      yield* Events.makeStore;
      assert.strictEqual(attempts, 4, "completed deliveries must remain idempotent across replay");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);
});

it.effect("does not block startup or unrelated ingestion on a slow reconciliation", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const secondCompleted = yield* Deferred.make<void>();
    const stored = [1, 2].map((index) => {
      const run = makeStoredRun(index);
      return {
        ...run,
        event: {
          ...run.event,
          payload: {
            ...run.event.payload,
            providerInstanceId: "opencode",
            modelSelection: { instanceId: "opencode", model: "test" },
          },
        },
      };
    });
    const orchestrator = Orchestrator.OrchestratorV2.of({
      streamStoredEventsFrom: ({ afterSequence = 0 }: { readonly afterSequence?: number } = {}) =>
        Stream.fromIterable(stored.filter((event) => event.sequence > afterSequence)),
    } as unknown as Orchestrator.OrchestratorV2["Service"]);
    const plotline = PlotlineDagService.PlotlineDagService.of({
      subscribe: () => Stream.empty,
      reconcileRun: (_threadId: string, runId: string) =>
        runId === "run:1"
          ? Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
            )
          : Deferred.succeed(secondCompleted, undefined),
    } as unknown as PlotlineDagService.PlotlineDagService["Service"]);
    const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
      getInstance: () => Effect.succeed({ driverKind: "opencode" }),
    } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);
    const dependencies = Layer.mergeAll(
      SqlitePersistence.layerMemory,
      Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
      Layer.succeed(PlotlineDagService.PlotlineDagService, plotline),
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, providers),
    );
    const layer = Events.layer.pipe(Layer.provideMerge(dependencies));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Events.HarnessSignificantEventStore;
      yield* Deferred.await(firstStarted);
      yield* Deferred.await(secondCompleted);
      const [cursor] = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM harness_event_cursor WHERE consumer_id = 'significant-events'
      `;
      assert.strictEqual(
        cursor?.sequence,
        2,
        "startup and ingestion proceed while delivery is blocked",
      );
      const rows = yield* sql<{ readonly event_id: string; readonly status: string }>`
        SELECT event_id, status FROM harness_opencode_reconciliation ORDER BY sequence
      `;
      assert.deepStrictEqual(rows, [
        { event_id: "run-event-1", status: "delivering" },
        { event_id: "run-event-2", status: "delivering" },
      ]);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Stream.take(store.stream, 2).pipe(
        Stream.runForEach((event) => store.acknowledge(event.id)),
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

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
    getInstance: () => Effect.void,
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
