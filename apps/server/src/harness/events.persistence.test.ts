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
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Events from "./events.ts";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const at = DateTime.makeUnsafe("2026-10-27T12:00:00.000Z");
const defaultRecoveryDependencies = Layer.mergeAll(
  Layer.succeed(
    EventSink.EventSinkV2,
    EventSink.EventSinkV2.of({
      readByCommandId: () => Stream.empty,
      stream: () => Stream.empty,
      readPersisted: () => Stream.empty,
    } as unknown as EventSink.EventSinkV2["Service"]),
  ),
  Layer.succeed(
    ThreadManagementService.ThreadManagementService,
    ThreadManagementService.ThreadManagementService.of({
      dispatch: () => Effect.die("Unexpected verifier dispatch"),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
  ),
);

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

const prepareDispatchedVerifier = (
  plotline: PlotlineDagService.PlotlineDagService["Service"],
  projectId: string,
) =>
  Effect.gen(function* () {
    const dag = yield* plotline.createForProject(projectId, "thread_parent", null, {
      title: "Automatic verification",
      description: "",
    });
    yield* plotline.addTasks(projectId, {
      dagId: dag.id,
      tasks: [{ id: "task", title: "Task", description: "", effort: 1, dependsOn: [] }],
    });
    yield* plotline.updateTask(projectId, {
      dagId: dag.id,
      taskId: "task",
      state: "running",
      threadId: "thread_parent" as never,
      runId: "run:initial",
      acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
    });
    yield* plotline.recordVerificationAttempt(projectId, {
      dagId: dag.id,
      taskId: "task",
      attemptId: "initial-failure",
      expectedCriteriaVersion: 2,
      expectedRunId: "run:initial",
      verdict: "fail",
      summary: "Initial attempt failed.",
      criterionResults: [{ criterionId: "works", verdict: "fail", evidence: "Test failed." }],
    });
    const reserved = yield* plotline.beginCorrection(projectId, {
      dagId: dag.id,
      taskId: "task",
      verificationAttemptId: "initial-failure",
      expectedCriteriaVersion: 2,
      expectedRunId: "run:initial",
      dispatchInput: {
        type: "delegated_task.request",
        parentThreadId: "thread_parent",
        parentRunId: "run:parent",
        parentNodeId: "node:parent",
        task: "Apply the correction",
        modelSelection: { instanceId: "codex", model: "test" },
      },
    });
    if (!reserved.correction) throw new Error("Expected a correction attempt.");
    yield* plotline.linkCorrection(projectId, {
      dagId: dag.id,
      taskId: "task",
      correctionId: reserved.correction.id,
      childTaskId: "correction-child",
      childThreadId: "thread_correction_child" as never,
      childRunId: "run:correction-child",
    });
    yield* plotline.settleCorrection(projectId, {
      dagId: dag.id,
      taskId: "task",
      correctionId: reserved.correction.id,
      state: "completed",
    });
    yield* plotline.updateVerifierRequest(projectId, {
      dagId: dag.id,
      taskId: "task",
      correctionId: reserved.correction.id,
      state: "dispatched",
      childTaskId: "verifier-child",
      childThreadId: "thread_verifier_child" as never,
      childRunId: "run:verifier",
    });
    return { dag, correctionId: reserved.correction.id };
  });

const prepareRequestedVerifier = (
  plotline: PlotlineDagService.PlotlineDagService["Service"],
  projectId: string,
) =>
  Effect.gen(function* () {
    const dag = yield* plotline.createForProject(projectId, "thread_parent", null, {
      title: "Requested verifier recovery",
      description: "",
    });
    yield* plotline.addTasks(projectId, {
      dagId: dag.id,
      tasks: [{ id: "task", title: "Task", description: "", effort: 1, dependsOn: [] }],
    });
    yield* plotline.updateTask(projectId, {
      dagId: dag.id,
      taskId: "task",
      state: "running",
      runId: "run:initial",
      acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
    });
    yield* plotline.recordVerificationAttempt(projectId, {
      dagId: dag.id,
      taskId: "task",
      attemptId: "initial-failure",
      expectedCriteriaVersion: 2,
      expectedRunId: "run:initial",
      verdict: "fail",
      summary: "Initial attempt failed.",
      criterionResults: [{ criterionId: "works", verdict: "fail", evidence: "Test failed." }],
    });
    const reserved = yield* plotline.beginCorrection(projectId, {
      dagId: dag.id,
      taskId: "task",
      verificationAttemptId: "initial-failure",
      expectedCriteriaVersion: 2,
      expectedRunId: "run:initial",
      dispatchInput: {
        type: "delegated_task.request",
        parentThreadId: "thread_parent",
        parentRunId: "run:parent",
        parentNodeId: "node:parent",
        task: "Apply the correction",
        modelSelection: { instanceId: "codex", model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    });
    if (!reserved.correction) throw new Error("Expected a correction attempt.");
    yield* plotline.linkCorrection(projectId, {
      dagId: dag.id,
      taskId: "task",
      correctionId: reserved.correction.id,
      childTaskId: "correction-child",
      childThreadId: "thread_correction_child" as never,
      childRunId: "run:correction-child",
    });
    yield* plotline.settleCorrection(projectId, {
      dagId: dag.id,
      taskId: "task",
      correctionId: reserved.correction.id,
      state: "completed",
    });
    return { dag, correctionId: reserved.correction.id };
  });

const makeStoredVerifierResult = (
  verdict: "pass" | "fail" | "inconclusive",
  sequence = 1,
  eventId = "subagent-event-verifier",
  resultText?: string,
) => {
  const stored = makeStoredSubagent("completed");
  return {
    ...stored,
    sequence,
    event: {
      ...stored.event,
      id: eventId,
      payload: {
        ...stored.event.payload,
        id: "verifier-child",
        childThreadId: "thread_verifier_child",
        runId: "run:verifier",
        result:
          resultText ??
          JSON.stringify({
            verdict,
            summary: "Automatic verification result.",
            criterionResults: [
              {
                criterionId: "works",
                verdict,
                evidence: "The acceptance check did not pass.",
              },
            ],
          }),
      },
    },
  };
};

const verifierDispatchResult = {
  storedEvents: [
    {
      sequence: 1,
      commandId: "",
      event: {
        type: "subagent.updated",
        threadId: "thread_parent",
        payload: {
          id: "verifier-child",
          origin: "app_owned",
          childThreadId: "thread_verifier_child",
        },
      },
    },
    {
      sequence: 2,
      commandId: "",
      event: {
        type: "run.created",
        threadId: "thread_verifier_child",
        payload: { id: "run:verifier" },
      },
    },
  ],
} as unknown as Orchestrator.OrchestratorV2DispatchResult;

it.effect("reconciles a persisted verifier result without waiting for the live stream", () =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const { dag } = yield* prepareDispatchedVerifier(plotline, "project:verifier-restart");
    const observingPlotline = PlotlineDagService.PlotlineDagService.of({
      ...plotline,
      updateVerifierRequest: (...args: Parameters<typeof plotline.updateVerifierRequest>) =>
        plotline
          .updateVerifierRequest(...args)
          .pipe(
            Effect.tap(() =>
              args[1].state === "completed" ? Deferred.succeed(completed, undefined) : Effect.void,
            ),
          ),
    });
    const sink = EventSink.EventSinkV2.of({
      readByCommandId: () => Stream.empty,
      stream: () => Stream.never,
      readPersisted: () => Stream.make(makeStoredVerifierResult("pass")),
    } as unknown as EventSink.EventSinkV2["Service"]);
    yield* Events.makeStore.pipe(
      Effect.provideService(PlotlineDagService.PlotlineDagService, observingPlotline),
      Effect.provideService(EventSink.EventSinkV2, sink),
    );
    yield* Deferred.await(completed);
    const task = (yield* plotline.getForProject("project:verifier-restart", dag.id)).tasks[0]!;
    assert.strictEqual(task.state, "done");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        defaultRecoveryDependencies,
        PlotlineDagService.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(SqlitePersistence.layerMemory, NodeCrypto.layer)),
        ),
        Layer.succeed(
          Orchestrator.OrchestratorV2,
          Orchestrator.OrchestratorV2.of({
            streamStoredEventsFrom: () => Stream.empty,
          } as unknown as Orchestrator.OrchestratorV2["Service"]),
        ),
        Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          ProviderInstanceRegistry.ProviderInstanceRegistry.of({
            getInstance: () => Effect.void,
          } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
        ),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("recovers a verifier despite a blocked correction and revisits its persisted retry", () =>
  Effect.gen(function* () {
    const correctionStarted = yield* Deferred.make<void>();
    const retryPersisted = yield* Deferred.make<void>();
    const dispatchedPersisted = yield* Deferred.make<void>();
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const { dag } = yield* prepareRequestedVerifier(plotline, "project:isolated-recovery");
    const observingPlotline = PlotlineDagService.PlotlineDagService.of({
      ...plotline,
      list: (...args: Parameters<typeof plotline.list>) =>
        plotline.list(...args).pipe(
          Effect.map((result) => ({
            ...result,
            dags: result.dags.map((item) =>
              item.id !== dag.id
                ? item
                : {
                    ...item,
                    tasks: item.tasks.map((task) => ({
                      ...task,
                      correctionAttempts: [
                        {
                          ...task.correctionAttempts![0]!,
                          id: "blocked-correction",
                          state: "requested" as const,
                          verifierRequest: undefined,
                        },
                        ...task.correctionAttempts!,
                      ],
                    })),
                  },
            ),
          })),
        ),
      updateVerifierRequest: (...args: Parameters<typeof plotline.updateVerifierRequest>) =>
        plotline
          .updateVerifierRequest(...args)
          .pipe(
            Effect.tap(() =>
              args[1].state === "dispatched"
                ? Deferred.succeed(dispatchedPersisted, undefined)
                : args[1].diagnostic?.includes("receipt lookup failed")
                  ? Deferred.succeed(retryPersisted, undefined)
                  : Effect.void,
            ),
          ),
    });
    let lookups = 0;
    const sink = EventSink.EventSinkV2.of({
      readByCommandId: () =>
        ++lookups === 1 ? Stream.fail(new Error("unavailable")) : Stream.empty,
      stream: () => Stream.empty,
      readPersisted: () => Stream.empty,
    } as unknown as EventSink.EventSinkV2["Service"]);
    const orchestrator = Orchestrator.OrchestratorV2.of({
      streamStoredEventsFrom: () => Stream.empty,
      dispatch: () =>
        Deferred.succeed(correctionStarted, undefined).pipe(Effect.andThen(Effect.never)),
    } as unknown as Orchestrator.OrchestratorV2["Service"]);
    const threads = ThreadManagementService.ThreadManagementService.of({
      dispatch: () => Effect.succeed(verifierDispatchResult),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]);
    yield* Events.makeStore.pipe(
      Effect.provideService(PlotlineDagService.PlotlineDagService, observingPlotline),
      Effect.provideService(EventSink.EventSinkV2, sink),
      Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    );
    yield* Deferred.await(correctionStarted);
    yield* Deferred.await(retryPersisted);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(dispatchedPersisted);
    const request = (yield* plotline.getForProject("project:isolated-recovery", dag.id)).tasks[0]!
      .correctionAttempts![0]!.verifierRequest;
    assert.strictEqual(request?.state, "dispatched");
    assert.strictEqual(request?.retryCount, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        defaultRecoveryDependencies,
        PlotlineDagService.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(SqlitePersistence.layerMemory, NodeCrypto.layer)),
        ),
        Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          ProviderInstanceRegistry.ProviderInstanceRegistry.of({
            getInstance: () => Effect.void,
          } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
        ),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("persists and retries a failed verifier child linkage with the same command", () =>
  Effect.gen(function* () {
    const retried = yield* Deferred.make<void>();
    const linked = yield* Deferred.make<void>();
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const { dag, correctionId } = yield* prepareRequestedVerifier(plotline, "project:link-retry");
    let first = true;
    const observing = PlotlineDagService.PlotlineDagService.of({
      ...plotline,
      updateVerifierRequest: (...args: Parameters<typeof plotline.updateVerifierRequest>) => {
        if (args[1].state === "dispatched" && first) {
          first = false;
          return Effect.fail(new PlotlineDagError({ message: "link unavailable" }));
        }
        return plotline
          .updateVerifierRequest(...args)
          .pipe(
            Effect.tap(() =>
              args[1].state === "dispatched"
                ? Deferred.succeed(linked, undefined)
                : args[1].diagnostic?.includes("child linkage failed")
                  ? Deferred.succeed(retried, undefined)
                  : Effect.void,
            ),
          );
      },
    });
    const commandIds: string[] = [];
    const threads = ThreadManagementService.ThreadManagementService.of({
      dispatch: (command: { readonly commandId: string }) =>
        Effect.sync(() => {
          commandIds.push(command.commandId);
          return verifierDispatchResult;
        }),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]);
    yield* Events.makeStore.pipe(
      Effect.provideService(PlotlineDagService.PlotlineDagService, observing),
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    );
    yield* Deferred.await(retried);
    const pending = (yield* plotline.getForProject("project:link-retry", dag.id)).tasks[0]!
      .correctionAttempts![0]!.verifierRequest;
    assert.strictEqual(pending?.state, "requested");
    assert.include(pending?.diagnostic ?? "", "child linkage failed");
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(linked);
    assert.deepStrictEqual(commandIds, [pending?.commandId, pending?.commandId]);
    yield* plotline.updateVerifierRequest("project:link-retry", {
      dagId: dag.id,
      taskId: "task",
      correctionId,
      state: "requested",
      expectedState: "requested",
      expectedCommandId: pending!.commandId,
      expectedRetryCount: pending!.retryCount ?? 0,
      diagnostic: "Late linkage timeout.",
    });
    const current = (yield* plotline.getForProject("project:link-retry", dag.id)).tasks[0]!
      .correctionAttempts![0]!.verifierRequest;
    assert.strictEqual(current?.state, "dispatched");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        defaultRecoveryDependencies,
        PlotlineDagService.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(SqlitePersistence.layerMemory, NodeCrypto.layer)),
        ),
        Layer.succeed(
          Orchestrator.OrchestratorV2,
          Orchestrator.OrchestratorV2.of({
            streamStoredEventsFrom: () => Stream.empty,
          } as unknown as Orchestrator.OrchestratorV2["Service"]),
        ),
        Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          ProviderInstanceRegistry.ProviderInstanceRegistry.of({
            getInstance: () => Effect.void,
          } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
        ),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("retries a failed verifier receipt lookup before dispatching the same command", () => {
  let lookupCount = 0;
  const commandIds: string[] = [];
  return Effect.gen(function* () {
    const retryPersisted = yield* Deferred.make<void>();
    const dispatchedPersisted = yield* Deferred.make<void>();
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const { dag } = yield* prepareRequestedVerifier(plotline, "project:receipt-retry");
    const observingPlotline = PlotlineDagService.PlotlineDagService.of({
      ...plotline,
      updateVerifierRequest: (...args: Parameters<typeof plotline.updateVerifierRequest>) =>
        plotline
          .updateVerifierRequest(...args)
          .pipe(
            Effect.tap(() =>
              args[1].state === "dispatched"
                ? Deferred.succeed(dispatchedPersisted, undefined)
                : args[1].diagnostic?.includes("receipt lookup failed")
                  ? Deferred.succeed(retryPersisted, undefined)
                  : Effect.void,
            ),
          ),
    });
    const sink = EventSink.EventSinkV2.of({
      readByCommandId: ({ commandId }: { readonly commandId: string }) => {
        commandIds.push(commandId);
        lookupCount += 1;
        return lookupCount === 1 ? Stream.fail(new Error("receipt unavailable")) : Stream.empty;
      },
      stream: () => Stream.empty,
      readPersisted: () => Stream.empty,
    } as unknown as EventSink.EventSinkV2["Service"]);
    let dispatches = 0;
    const threads = ThreadManagementService.ThreadManagementService.of({
      dispatch: (command: { readonly commandId: string }) => {
        dispatches += 1;
        commandIds.push(command.commandId);
        return Effect.succeed(verifierDispatchResult);
      },
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]);
    yield* Events.makeStore.pipe(
      Effect.provideService(PlotlineDagService.PlotlineDagService, observingPlotline),
      Effect.provideService(EventSink.EventSinkV2, sink),
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    );
    yield* Deferred.await(retryPersisted);
    const pending = (yield* plotline.getForProject("project:receipt-retry", dag.id)).tasks[0]!
      .correctionAttempts?.[0]?.verifierRequest;
    assert.strictEqual(pending?.state, "requested");
    assert.strictEqual(pending?.retryCount, 1);
    assert.include(pending?.diagnostic ?? "", "receipt lookup failed");
    assert.strictEqual(dispatches, 0);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(dispatchedPersisted);
    const request = (yield* plotline.getForProject("project:receipt-retry", dag.id)).tasks[0]!
      .correctionAttempts?.[0]?.verifierRequest;
    assert.strictEqual(request?.state, "dispatched");
    assert.strictEqual(request?.childTaskId, "verifier-child");
    assert.strictEqual(dispatches, 1);
    assert.isTrue(commandIds.every((id) => id === request?.commandId));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        PlotlineDagService.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(SqlitePersistence.layerMemory, NodeCrypto.layer)),
        ),
        Layer.succeed(
          Orchestrator.OrchestratorV2,
          Orchestrator.OrchestratorV2.of({
            streamStoredEventsFrom: () => Stream.empty,
          } as unknown as Orchestrator.OrchestratorV2["Service"]),
        ),
        Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          ProviderInstanceRegistry.ProviderInstanceRegistry.of({
            getInstance: () => Effect.void,
          } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
        ),
      ),
    ),
    Effect.scoped,
  );
});

it.effect(
  "keeps verifier requests replayable after transient dispatch failure without new events",
  () => {
    const commandIds: Array<string> = [];
    let firstFailure: Deferred.Deferred<void> | undefined;
    let secondDispatch: Deferred.Deferred<void> | undefined;
    let dispatchedRequestPersisted: Deferred.Deferred<void> | undefined;
    let calls = 0;
    const orchestrator = Orchestrator.OrchestratorV2.of({
      streamStoredEventsFrom: () => Stream.empty,
    } as unknown as Orchestrator.OrchestratorV2["Service"]);
    const threads = ThreadManagementService.ThreadManagementService.of({
      dispatch: (command: { readonly commandId: string }) =>
        Effect.suspend(() => {
          commandIds.push(command.commandId);
          calls += 1;
          if (calls === 1)
            return Deferred.succeed(firstFailure!, undefined).pipe(
              Effect.andThen(
                Effect.fail(
                  new PlotlineDagError({ message: "temporary provider/projection failure" }),
                ),
              ),
            );
          return Deferred.succeed(secondDispatch!, undefined).pipe(
            Effect.as(verifierDispatchResult),
          );
        }),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]);
    const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
      getInstance: () => Effect.void,
    } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);
    const persistence = Layer.mergeAll(SqlitePersistence.layerMemory, NodeCrypto.layer);
    const layer = Layer.mergeAll(
      PlotlineDagService.layer.pipe(Layer.provideMerge(persistence)),
      Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
      Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, providers),
    );
    return Effect.gen(function* () {
      firstFailure = yield* Deferred.make<void>();
      secondDispatch = yield* Deferred.make<void>();
      dispatchedRequestPersisted = yield* Deferred.make<void>();
      const plotline = yield* PlotlineDagService.PlotlineDagService;
      const { dag } = yield* prepareRequestedVerifier(plotline, "project:verifier-dispatch-retry");
      const observingPlotline = PlotlineDagService.PlotlineDagService.of({
        ...plotline,
        updateVerifierRequest: (...args: Parameters<typeof plotline.updateVerifierRequest>) =>
          plotline
            .updateVerifierRequest(...args)
            .pipe(
              Effect.tap(() =>
                args[1].state === "dispatched"
                  ? Deferred.succeed(dispatchedRequestPersisted!, undefined)
                  : Effect.void,
              ),
            ),
      });
      yield* Events.makeStore.pipe(
        Effect.provideService(PlotlineDagService.PlotlineDagService, observingPlotline),
      );
      yield* Deferred.await(firstFailure!);
      const requestAfterFailure = (yield* plotline.getForProject(
        "project:verifier-dispatch-retry",
        dag.id,
      )).tasks[0]!;
      assert.strictEqual(requestAfterFailure.state, "running");
      assert.strictEqual(
        requestAfterFailure.correctionAttempts?.[0]?.verifierRequest?.state,
        "requested",
      );

      yield* TestClock.adjust("1 second");
      yield* Deferred.await(secondDispatch!);
      yield* Deferred.await(dispatchedRequestPersisted!);
      const recovered = (yield* plotline.getForProject("project:verifier-dispatch-retry", dag.id))
        .tasks[0]!;
      const request = recovered.correctionAttempts?.[0]?.verifierRequest;
      assert.strictEqual(request?.state, "dispatched");
      assert.strictEqual(calls, 2, "recovery retries without waiting for an unrelated event");
      assert.deepStrictEqual(commandIds, [request?.commandId, request?.commandId]);
    }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
  },
);

it.effect("rotates a legacy rejected verifier command before retrying", () => {
  const commandIds: Array<string> = [];
  let firstFailure: Deferred.Deferred<void> | undefined;
  let secondDispatch: Deferred.Deferred<void> | undefined;
  let dispatchedRequestPersisted: Deferred.Deferred<void> | undefined;
  let calls = 0;
  const orchestrator = Orchestrator.OrchestratorV2.of({
    streamStoredEventsFrom: () => Stream.empty,
  } as unknown as Orchestrator.OrchestratorV2["Service"]);
  const threads = ThreadManagementService.ThreadManagementService.of({
    dispatch: (command: { readonly commandId: string }) =>
      Effect.suspend(() => {
        commandIds.push(command.commandId);
        calls += 1;
        if (calls === 1)
          return Deferred.succeed(firstFailure!, undefined).pipe(
            Effect.andThen(
              Effect.fail(
                Object.assign(new Error("legacy rejection"), {
                  _tag: "OrchestratorCommandPreviouslyRejectedError",
                }),
              ),
            ),
          );
        return Deferred.succeed(secondDispatch!, undefined).pipe(Effect.as(verifierDispatchResult));
      }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"]);
  const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
    getInstance: () => Effect.void,
  } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);
  const persistence = Layer.mergeAll(SqlitePersistence.layerMemory, NodeCrypto.layer);
  const layer = Layer.mergeAll(
    PlotlineDagService.layer.pipe(Layer.provideMerge(persistence)),
    Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
    Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, providers),
  );
  return Effect.gen(function* () {
    firstFailure = yield* Deferred.make<void>();
    secondDispatch = yield* Deferred.make<void>();
    dispatchedRequestPersisted = yield* Deferred.make<void>();
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const { dag } = yield* prepareRequestedVerifier(plotline, "project:verifier-dispatch-retry");
    const observingPlotline = PlotlineDagService.PlotlineDagService.of({
      ...plotline,
      updateVerifierRequest: (...args: Parameters<typeof plotline.updateVerifierRequest>) =>
        plotline
          .updateVerifierRequest(...args)
          .pipe(
            Effect.tap(() =>
              args[1].state === "dispatched"
                ? Deferred.succeed(dispatchedRequestPersisted!, undefined)
                : Effect.void,
            ),
          ),
    });
    yield* Events.makeStore.pipe(
      Effect.provideService(PlotlineDagService.PlotlineDagService, observingPlotline),
    );
    yield* Deferred.await(firstFailure!);
    const requestAfterFailure = (yield* plotline.getForProject(
      "project:verifier-dispatch-retry",
      dag.id,
    )).tasks[0]!;
    assert.strictEqual(requestAfterFailure.state, "running");
    assert.strictEqual(
      requestAfterFailure.correctionAttempts?.[0]?.verifierRequest?.state,
      "requested",
    );

    yield* TestClock.adjust("1 second");
    yield* Deferred.await(secondDispatch!);
    yield* Deferred.await(dispatchedRequestPersisted!);
    const recovered = (yield* plotline.getForProject("project:verifier-dispatch-retry", dag.id))
      .tasks[0]!;
    const request = recovered.correctionAttempts?.[0]?.verifierRequest;
    assert.strictEqual(request?.state, "dispatched");
    assert.strictEqual(calls, 2, "recovery retries without waiting for an unrelated event");
    assert.notStrictEqual(commandIds[0], commandIds[1]);
    assert.strictEqual(commandIds[1], request?.commandId);
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
});

it.effect("durably escalates a permanently rejected verifier dispatch", () => {
  let rejected: Deferred.Deferred<void> | undefined;
  let failedRequestPersisted: Deferred.Deferred<void> | undefined;
  const orchestrator = Orchestrator.OrchestratorV2.of({
    streamStoredEventsFrom: () => Stream.empty,
  } as unknown as Orchestrator.OrchestratorV2["Service"]);
  const threads = ThreadManagementService.ThreadManagementService.of({
    dispatch: () =>
      Deferred.succeed(rejected!, undefined).pipe(
        Effect.andThen(
          Effect.fail(
            Object.assign(new Error("command rejected"), {
              _tag: "OrchestratorCommandRejectedError",
            }),
          ),
        ),
      ),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"]);
  const providers = ProviderInstanceRegistry.ProviderInstanceRegistry.of({
    getInstance: () => Effect.void,
  } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]);
  const persistence = Layer.mergeAll(SqlitePersistence.layerMemory, NodeCrypto.layer);
  const layer = Layer.mergeAll(
    PlotlineDagService.layer.pipe(Layer.provideMerge(persistence)),
    Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
    Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, providers),
  );
  return Effect.gen(function* () {
    rejected = yield* Deferred.make<void>();
    failedRequestPersisted = yield* Deferred.make<void>();
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const { dag } = yield* prepareRequestedVerifier(plotline, "project:verifier-dispatch-rejected");
    const observingPlotline = PlotlineDagService.PlotlineDagService.of({
      ...plotline,
      updateVerifierRequest: (...args: Parameters<typeof plotline.updateVerifierRequest>) =>
        plotline
          .updateVerifierRequest(...args)
          .pipe(
            Effect.tap(() =>
              args[1].state === "failed"
                ? Deferred.succeed(failedRequestPersisted!, undefined)
                : Effect.void,
            ),
          ),
    });
    yield* Events.makeStore.pipe(
      Effect.provideService(PlotlineDagService.PlotlineDagService, observingPlotline),
    );
    yield* Deferred.await(rejected!);
    yield* Deferred.await(failedRequestPersisted!);
    const task = (yield* plotline.getForProject("project:verifier-dispatch-rejected", dag.id))
      .tasks[0]!;
    assert.strictEqual(task.state, "failed");
    assert.strictEqual(task.correctionAttempts?.[0]?.verifierRequest?.state, "failed");
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
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
    }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)));
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
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
});

it.effect("retries inconclusive verifier output without recording an acceptance failure", () => {
  const result = makeStoredVerifierResult("inconclusive");
  const orchestrator = Orchestrator.OrchestratorV2.of({
    streamStoredEventsFrom: ({ afterSequence = 0 }: { readonly afterSequence?: number } = {}) =>
      Stream.fromIterable([result].filter((event) => event.sequence > afterSequence)),
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
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const { dag } = yield* prepareDispatchedVerifier(plotline, "project:inconclusive-verifier");
    yield* Events.makeStore;
    yield* TestClock.adjust("1 second");
    const task = (yield* plotline.getForProject("project:inconclusive-verifier", dag.id)).tasks[0]!;
    assert.strictEqual(task.state, "running");
    assert.strictEqual(task.verificationAttempts?.length, 1);
    assert.strictEqual(task.correctionAttempts?.[0]?.verifierRequest?.state, "requested");
    assert.strictEqual(task.correctionAttempts?.[0]?.verifierRequest?.retryCount, 1);
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
});

it.effect("atomically escalates only the run associated with the failed verifier", () => {
  const persistence = Layer.mergeAll(SqlitePersistence.layerMemory, NodeCrypto.layer);
  const layer = PlotlineDagService.layer.pipe(Layer.provideMerge(persistence));
  return Effect.gen(function* () {
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const current = yield* prepareDispatchedVerifier(plotline, "project:current-verifier-failure");
    const escalated = yield* plotline.updateVerifierRequest("project:current-verifier-failure", {
      dagId: current.dag.id,
      taskId: "task",
      correctionId: current.correctionId,
      state: "failed",
      diagnostic: "Verifier interrupted",
    });
    assert.strictEqual(escalated.tasks[0]!.state, "failed");
    assert.strictEqual(escalated.tasks[0]!.executionLifecycle, "failed_escalated");
    assert.strictEqual(
      escalated.tasks[0]!.correctionAttempts?.[0]?.verifierRequest?.state,
      "failed",
    );
    const { dag, correctionId } = yield* prepareDispatchedVerifier(
      plotline,
      "project:atomic-verifier-failure",
    );
    yield* plotline.updateTask("project:atomic-verifier-failure", {
      dagId: dag.id,
      taskId: "task",
      runId: "run:newer",
    });
    const result = yield* plotline.updateVerifierRequest("project:atomic-verifier-failure", {
      dagId: dag.id,
      taskId: "task",
      correctionId,
      state: "failed",
      diagnostic: "Verifier interrupted",
    });
    assert.strictEqual(result.tasks[0]!.runId, "run:newer");
    assert.strictEqual(result.tasks[0]!.state, "running");
    assert.strictEqual(result.tasks[0]!.correctionAttempts?.[0]?.verifierRequest?.state, "failed");
    const replay = yield* plotline.updateVerifierRequest("project:atomic-verifier-failure", {
      dagId: dag.id,
      taskId: "task",
      correctionId,
      state: "failed",
      diagnostic: "Verifier interrupted",
    });
    assert.strictEqual(replay.tasks[0]!.state, "running");
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
});

it.effect("replays a passing verifier result across restart without duplicating settlement", () => {
  const result = makeStoredVerifierResult(
    "pass",
    1,
    "subagent-event-verifier",
    [
      "Verification completed.",
      "",
      "```json",
      '{"verdict":"pass","summary":"The acceptance check passed.","criterionResults":[{"criterionId":"works","verdict":"pass","evidence":"Ran the acceptance check; it passed."}]}',
      "```",
    ].join("\n"),
  );
  const duplicate = { ...makeStoredVerifierResult("pass", 2), event: result.event };
  const orchestrator = Orchestrator.OrchestratorV2.of({
    streamStoredEventsFrom: ({ afterSequence = 0 }: { readonly afterSequence?: number } = {}) =>
      Stream.fromIterable([result, duplicate].filter((event) => event.sequence > afterSequence)),
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
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const { dag, correctionId } = yield* prepareDispatchedVerifier(
      plotline,
      "project:passing-verifier-restart",
    );
    yield* Events.makeStore;
    yield* TestClock.adjust("1 second");
    const settled = (yield* plotline.getForProject("project:passing-verifier-restart", dag.id))
      .tasks[0]!;
    assert.strictEqual(settled.state, "done");
    assert.strictEqual(settled.verificationAttempts?.length, 2);
    assert.strictEqual(settled.verificationAttempts?.[1]?.criteriaVersion, settled.criteriaVersion);
    assert.strictEqual(settled.verificationAttempts?.[1]?.runId, "run:correction-child");
    assert.strictEqual(settled.correctionAttempts?.[0]?.verifierRequest?.state, "completed");

    yield* Events.makeStore;
    yield* TestClock.adjust("1 second");
    const replayed = (yield* plotline.getForProject("project:passing-verifier-restart", dag.id))
      .tasks[0]!;
    assert.strictEqual(replayed.state, "done");
    assert.strictEqual(replayed.verificationAttempts?.length, 2);
    assert.strictEqual(replayed.correctionAttempts?.[0]?.id, correctionId);
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
});

for (const [name, output, diagnostic] of [
  ["malformed JSON", "```json\n{invalid}\n```", "Verifier JSON parsing failed:"],
  [
    "the incident result using results instead of criterionResults",
    '{"verdict":"pass","summary":"4/4 tests passed","results":[{"criterionId":"works","verdict":"pass","evidence":"Ran the check."}]}',
    "Verifier evidence schema validation failed:",
  ],
  [
    "an unknown criterion ID",
    '{"verdict":"pass","summary":"Passed","criterionResults":[{"criterionId":"wrong","verdict":"pass","evidence":"Ran the check."}]}',
    "Verifier criterion ID validation failed:",
  ],
] as const) {
  it.effect(`rejects ${name} without recording a verification or retrying`, () => {
    const result = makeStoredVerifierResult("pass", 1, "subagent-event-verifier", output);
    const orchestrator = Orchestrator.OrchestratorV2.of({
      streamStoredEventsFrom: ({ afterSequence = 0 }: { readonly afterSequence?: number } = {}) =>
        Stream.fromIterable([result].filter((event) => event.sequence > afterSequence)),
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
      const plotline = yield* PlotlineDagService.PlotlineDagService;
      const { dag } = yield* prepareDispatchedVerifier(plotline, "project:invalid-verifier");
      yield* Events.makeStore;
      yield* TestClock.adjust("1 second");
      const task = (yield* plotline.getForProject("project:invalid-verifier", dag.id)).tasks[0]!;
      const request = task.correctionAttempts?.[0]?.verifierRequest;
      assert.strictEqual(task.verificationAttempts?.length, 1);
      assert.strictEqual(request?.state, "failed");
      assert.strictEqual(request?.retryCount ?? 0, 0);
      assert.strictEqual(request?.persistenceFailures ?? 0, 0);
      assert.include(request?.diagnostic ?? "", diagnostic);
    }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
  });
}

it.effect("replays the same verifier evidence after a durable persistence failure", () => {
  const result = makeStoredVerifierResult("pass");
  const orchestrator = Orchestrator.OrchestratorV2.of({
    streamStoredEventsFrom: ({ afterSequence = 0 }: { readonly afterSequence?: number } = {}) =>
      Stream.fromIterable([result].filter((event) => event.sequence > afterSequence)),
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
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const { dag } = yield* prepareDispatchedVerifier(plotline, "project:verifier-write-retry");
    const firstWriteFailed = yield* Deferred.make<void>();
    let failFirstAttemptWrite = true;
    const transientFailure = PlotlineDagService.PlotlineDagService.of({
      ...plotline,
      recordVerificationAttempt: (...args: Parameters<typeof plotline.recordVerificationAttempt>) =>
        Effect.suspend(() => {
          if (failFirstAttemptWrite) {
            failFirstAttemptWrite = false;
            return Deferred.succeed(firstWriteFailed, undefined).pipe(
              Effect.andThen(
                Effect.fail(new PlotlineDagError({ message: "temporary write failure" })),
              ),
            );
          }
          return plotline.recordVerificationAttempt(...args);
        }),
    });

    yield* Events.makeStore.pipe(
      Effect.provideService(PlotlineDagService.PlotlineDagService, transientFailure),
    );
    yield* Deferred.await(firstWriteFailed);
    yield* TestClock.adjust("1 second");
    const afterFailure = (yield* plotline.getForProject("project:verifier-write-retry", dag.id))
      .tasks[0]!;
    assert.strictEqual(afterFailure.state, "running");
    assert.strictEqual(afterFailure.correctionAttempts?.[0]?.verifierRequest?.state, "dispatched");
    assert.strictEqual(
      afterFailure.correctionAttempts?.[0]?.verifierRequest?.persistenceFailures,
      1,
    );
    assert.strictEqual(
      Date.parse(afterFailure.correctionAttempts![0]!.verifierRequest!.nextRetryAt!) -
        Date.parse(afterFailure.updatedAt),
      1000,
    );
    assert.strictEqual(afterFailure.verificationAttempts?.length, 1);

    const recovered = yield* Deferred.make<void>();
    const recovering = PlotlineDagService.PlotlineDagService.of({
      ...plotline,
      updateVerifierRequest: (...args: Parameters<typeof plotline.updateVerifierRequest>) =>
        plotline
          .updateVerifierRequest(...args)
          .pipe(
            Effect.tap(() =>
              args[1].state === "completed" ? Deferred.succeed(recovered, undefined) : Effect.void,
            ),
          ),
    });
    yield* Events.makeStore.pipe(
      Effect.provideService(PlotlineDagService.PlotlineDagService, recovering),
    );
    yield* Deferred.await(recovered);
    const afterRestart = (yield* plotline.getForProject("project:verifier-write-retry", dag.id))
      .tasks[0]!;
    assert.strictEqual(afterRestart.state, "done");
    assert.strictEqual(afterRestart.correctionAttempts?.[0]?.verifierRequest?.state, "completed");
    assert.strictEqual(afterRestart.verificationAttempts?.length, 2);
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
});

it.effect("retries a verifier task write failure from the durable event after restart", () => {
  const result = makeStoredVerifierResult("pass");
  const orchestrator = Orchestrator.OrchestratorV2.of({
    streamStoredEventsFrom: ({ afterSequence = 0 }: { readonly afterSequence?: number } = {}) =>
      Stream.fromIterable([result].filter((event) => event.sequence > afterSequence)),
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
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const { dag } = yield* prepareDispatchedVerifier(plotline, "project:verifier-write-retry");
    const firstWriteFailed = yield* Deferred.make<void>();
    let failFirstTaskWrite = true;
    const transientFailure = PlotlineDagService.PlotlineDagService.of({
      ...plotline,
      updateTask: (...args: Parameters<typeof plotline.updateTask>) =>
        Effect.suspend(() => {
          if (failFirstTaskWrite) {
            failFirstTaskWrite = false;
            return Deferred.succeed(firstWriteFailed, undefined).pipe(
              Effect.andThen(
                Effect.fail(new PlotlineDagError({ message: "temporary write failure" })),
              ),
            );
          }
          return plotline.updateTask(...args);
        }),
    });

    yield* Events.makeStore.pipe(
      Effect.provideService(PlotlineDagService.PlotlineDagService, transientFailure),
    );
    yield* Deferred.await(firstWriteFailed);
    const afterFailure = (yield* plotline.getForProject("project:verifier-write-retry", dag.id))
      .tasks[0]!;
    assert.strictEqual(afterFailure.state, "running");
    assert.strictEqual(afterFailure.correctionAttempts?.[0]?.verifierRequest?.state, "dispatched");

    const recovered = yield* Deferred.make<void>();
    const recovering = PlotlineDagService.PlotlineDagService.of({
      ...plotline,
      updateVerifierRequest: (...args: Parameters<typeof plotline.updateVerifierRequest>) =>
        plotline
          .updateVerifierRequest(...args)
          .pipe(
            Effect.tap(() =>
              args[1].state === "completed" ? Deferred.succeed(recovered, undefined) : Effect.void,
            ),
          ),
    });
    yield* Events.makeStore.pipe(
      Effect.provideService(PlotlineDagService.PlotlineDagService, recovering),
    );
    yield* Deferred.await(recovered);
    const afterRestart = (yield* plotline.getForProject("project:verifier-write-retry", dag.id))
      .tasks[0]!;
    assert.strictEqual(afterRestart.state, "done");
    assert.strictEqual(afterRestart.correctionAttempts?.[0]?.verifierRequest?.state, "completed");
    assert.strictEqual(afterRestart.verificationAttempts?.length, 2);
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
});

it.effect(
  "reserves and dispatches a bounded correction for a failed automatic verifier, including replay",
  () => {
    const result = makeStoredVerifierResult("fail");
    const duplicate = { ...makeStoredVerifierResult("fail", 2), event: result.event };
    const dispatches: Array<{ readonly commandId: string; readonly type: string }> = [];
    let dispatched: Deferred.Deferred<void>;
    const orchestrator = Orchestrator.OrchestratorV2.of({
      streamStoredEventsFrom: ({ afterSequence = 0 }: { readonly afterSequence?: number } = {}) =>
        Stream.fromIterable([result, duplicate].filter((event) => event.sequence > afterSequence)),
      dispatch: (command: { readonly commandId: string; readonly type: string }) =>
        Effect.sync(() => {
          dispatches.push(command);
        }).pipe(
          Effect.andThen(Deferred.succeed(dispatched, undefined)),
          Effect.as({ storedEvents: [] }),
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
      dispatched = yield* Deferred.make<void>();
      const plotline = yield* PlotlineDagService.PlotlineDagService;
      const { dag, correctionId: verifierCorrectionId } = yield* prepareDispatchedVerifier(
        plotline,
        "project:auto-correction",
      );
      yield* Events.makeStore;
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(dispatched);
      const first = yield* plotline.getForProject("project:auto-correction", dag.id);
      const task = first.tasks[0]!;
      assert.strictEqual(
        task.state,
        "running",
        "a failed verifier should not escalate before correction",
      );
      assert.strictEqual(task.correctionAttempts?.length, 2);
      const automatic = task.correctionAttempts?.[1];
      assert.strictEqual(automatic?.state, "requested");
      assert.strictEqual(automatic?.attempt, 2);
      assert.notStrictEqual(automatic?.id, verifierCorrectionId);
      assert.isAtLeast(
        dispatches.length,
        1,
        "the reserved correction uses the existing dispatch path",
      );
      assert.isTrue(
        dispatches.every((command) => command.type === "delegated_task.request"),
        "replayed correction dispatches retain the delegated-task command type",
      );
      assert.isTrue(
        dispatches.every((command) => command.commandId === `plotline-correction-${automatic?.id}`),
        "duplicate/replayed results reuse the reservation's stable command id",
      );

      yield* Events.makeStore;
      yield* TestClock.adjust("1 second");
      const replayed = yield* plotline.getForProject("project:auto-correction", dag.id);
      assert.strictEqual(replayed.tasks[0]!.correctionAttempts?.length, 2);
    }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
  },
);

it.effect(
  "fails only a stale verifier request when its result replays after a newer task run",
  () => {
    const result = makeStoredVerifierResult("fail");
    const duplicate = { ...makeStoredVerifierResult("fail", 2), event: result.event };
    const orchestrator = Orchestrator.OrchestratorV2.of({
      streamStoredEventsFrom: ({ afterSequence = 0 }: { readonly afterSequence?: number } = {}) =>
        Stream.fromIterable([result, duplicate].filter((event) => event.sequence > afterSequence)),
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
      const plotline = yield* PlotlineDagService.PlotlineDagService;
      const { dag } = yield* prepareDispatchedVerifier(plotline, "project:stale-verifier");
      yield* plotline.updateTask("project:stale-verifier", {
        dagId: dag.id,
        taskId: "task",
        runId: "run:newer",
      });
      yield* Events.makeStore;
      yield* TestClock.adjust("1 second");
      const current = yield* plotline.getForProject("project:stale-verifier", dag.id);
      const task = current.tasks[0]!;
      assert.strictEqual(task.runId, "run:newer");
      assert.strictEqual(task.state, "running", "a stale verifier cannot fail the newer task run");
      assert.strictEqual(task.correctionAttempts?.[0]?.verifierRequest?.state, "failed");
      assert.strictEqual(
        task.correctionAttempts?.length,
        1,
        "stale failure must not reserve a correction",
      );
      assert.strictEqual(task.verificationAttempts?.length, 1, "stale evidence is not recorded");

      yield* Events.makeStore;
      yield* TestClock.adjust("1 second");
      const replayed = yield* plotline.getForProject("project:stale-verifier", dag.id);
      assert.strictEqual(replayed.tasks[0]!.state, "running");
      assert.strictEqual(replayed.tasks[0]!.runId, "run:newer");
      assert.strictEqual(replayed.tasks[0]!.correctionAttempts?.length, 1);
    }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
  },
);

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
    }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
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
      dispatchInput: {
        type: "delegated_task.request",
        parentThreadId: "thread_parent",
        parentRunId: "run:parent",
        parentNodeId: "node:parent",
        task: "Apply the correction",
      },
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
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
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
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
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
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
});

it.effect("reuses the accepted correction receipt after restart before local linking", () => {
  const acceptedByCommandId = new Map<string, ReadonlyArray<unknown>>();
  const commandCalls: string[] = [];
  let crashAfterAcceptance: Deferred.Deferred<void> | undefined;
  const childEvents = [
    {
      sequence: 1,
      commandId: "plotline-correction-correction-1",
      event: {
        type: "subagent.updated",
        threadId: "thread_parent",
        payload: {
          id: "node:correction-child",
          origin: "app_owned",
          childThreadId: "thread_correction_child",
          runId: "run:correction-child",
        },
      },
    },
    {
      sequence: 2,
      commandId: "plotline-correction-correction-1",
      event: {
        type: "run.created",
        threadId: "thread_correction_child",
        payload: { id: "run:correction-child" },
      },
    },
  ];
  const orchestrator = Orchestrator.OrchestratorV2.of({
    streamStoredEventsFrom: () => Stream.empty,
    dispatch: (command: { readonly commandId: string }) =>
      Effect.gen(function* () {
        commandCalls.push(command.commandId);
        const sql = yield* SqlClient.SqlClient;
        const [prior] = yield* sql<{ readonly events_json: string }>`
          SELECT events_json FROM test_provider_receipts WHERE command_id = ${command.commandId}
        `;
        if (prior) return { storedEvents: JSON.parse(prior.events_json) as ReadonlyArray<unknown> };
        yield* sql`INSERT INTO test_provider_receipts (command_id, events_json)
          VALUES (${command.commandId}, ${JSON.stringify(childEvents)})`;
        acceptedByCommandId.set(command.commandId, childEvents);
        yield* Deferred.succeed(crashAfterAcceptance!, undefined);
        return yield* Effect.never;
      }),
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
    crashAfterAcceptance = yield* Deferred.make<void>();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE test_provider_receipts (
      command_id TEXT PRIMARY KEY,
      events_json TEXT NOT NULL
    )`;
    const plotline = yield* PlotlineDagService.PlotlineDagService;
    const dag = yield* plotline.createForProject("project:dispatch-crash", "thread_parent", null, {
      title: "Dispatch crash window",
      description: "",
    });
    yield* plotline.addTasks("project:dispatch-crash", {
      dagId: dag.id,
      tasks: [{ id: "task", title: "Task", description: "", effort: 1, dependsOn: [] }],
    });
    yield* plotline.updateTask("project:dispatch-crash", {
      dagId: dag.id,
      taskId: "task",
      state: "running",
      acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
    });
    yield* plotline.recordVerificationAttempt("project:dispatch-crash", {
      dagId: dag.id,
      taskId: "task",
      attemptId: "failed-verification",
      expectedCriteriaVersion: 2,
      expectedRunId: null,
      verdict: "fail",
      summary: "The initial check failed.",
      criterionResults: [{ criterionId: "works", verdict: "fail", evidence: "Assertion failed." }],
    });
    const reserved = yield* plotline.beginCorrection("project:dispatch-crash", {
      dagId: dag.id,
      taskId: "task",
      verificationAttemptId: "failed-verification",
      expectedCriteriaVersion: 2,
      expectedRunId: null,
      dispatchInput: {
        type: "delegated_task.request",
        parentThreadId: "thread_parent",
        parentRunId: "run:parent",
        parentNodeId: "node:parent",
        task: "Apply the correction",
      },
    });
    assert.isNotNull(reserved.correction);

    const firstStore = Effect.scoped(
      Effect.gen(function* () {
        yield* Events.makeStore;
        yield* Deferred.await(crashAfterAcceptance!);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)));
    const firstRun = yield* Effect.forkChild(firstStore);
    yield* Deferred.await(crashAfterAcceptance);
    yield* Fiber.interrupt(firstRun);

    const linked = yield* Deferred.make<void>();
    const originalLink = plotline.linkCorrection;
    const observingPlotline = PlotlineDagService.PlotlineDagService.of({
      ...plotline,
      linkCorrection: (...args: Parameters<typeof originalLink>) =>
        originalLink(...args).pipe(Effect.tap(() => Deferred.succeed(linked, undefined))),
    });
    yield* Events.makeStore.pipe(
      Effect.provideService(PlotlineDagService.PlotlineDagService, observingPlotline),
    );
    yield* Deferred.await(linked);

    const task = (yield* plotline.getForProject("project:dispatch-crash", dag.id)).tasks[0]!;
    assert.deepStrictEqual(commandCalls, [
      `plotline-correction-${reserved.correction!.id}`,
      `plotline-correction-${reserved.correction!.id}`,
    ]);
    assert.strictEqual(
      acceptedByCommandId.size,
      1,
      "the accepted provider command is not duplicated",
    );
    const receipts = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM test_provider_receipts
      WHERE command_id = ${`plotline-correction-${reserved.correction!.id}`}
    `;
    assert.strictEqual(receipts[0]?.count, 1, "one durable receipt serves both dispatch attempts");
    assert.strictEqual(task.correctionAttempts?.[0]?.state, "running");
    assert.strictEqual(task.correctionAttempts?.[0]?.childThreadId, "thread_correction_child");
    assert.strictEqual(task.correctionAttempts?.[0]?.childRunId, "run:correction-child");
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)), Effect.scoped);
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
    }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)));
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
      defaultRecoveryDependencies,
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
  }).pipe(Effect.provide(Layer.mergeAll(defaultRecoveryDependencies, layer)));
});
