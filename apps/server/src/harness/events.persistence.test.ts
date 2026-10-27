import { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PlotlineDagService from "../plotline/PlotlineDagService.ts";
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
    const orchestrator = Orchestrator.OrchestratorV2.of({
      streamStoredEventsFrom: (input: { readonly afterSequence?: number } | undefined) => {
        const afterSequence = input?.afterSequence ?? 0;
        requestedCursors.push(afterSequence);
        return Stream.fromIterable(stored.filter((event) => event.sequence > afterSequence));
      },
    } as unknown as Orchestrator.OrchestratorV2["Service"]);
    const plotline = PlotlineDagService.PlotlineDagService.of({
      subscribe: () => Stream.empty,
    } as unknown as PlotlineDagService.PlotlineDagService["Service"]);
    const layer = Layer.mergeAll(
      SqlitePersistence.layerMemory,
      Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
      Layer.succeed(PlotlineDagService.PlotlineDagService, plotline),
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
