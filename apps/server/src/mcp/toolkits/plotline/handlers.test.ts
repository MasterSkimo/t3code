import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentId, PlotlineDagError, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PlotlineDagService from "../../../plotline/PlotlineDagService.ts";
import * as HarnessEvents from "../../../harness/events.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { PlotlineToolkit } from "./tools.ts";
import * as PlotlineHandlers from "./handlers.ts";

const threadId = ThreadId.make("thread:plotline-plan");

it.effect("blocks every Plotline mutation in Plan mode while keeping tools project scoped", () =>
  Effect.gen(function* () {
    const writes = yield* Effect.sync(() => [] as string[]);
    const service = {
      createForProject: () =>
        Effect.sync(() => {
          writes.push("create");
          throw new Error("unexpected");
        }),
      list: () => Effect.succeed({ dags: [] }),
      getForProject: () => Effect.fail(new PlotlineDagError({ message: "not found" })),
      addTasks: () =>
        Effect.sync(() => {
          writes.push("add");
          throw new Error("unexpected");
        }),
      updateTask: () =>
        Effect.sync(() => {
          writes.push("update");
          throw new Error("unexpected");
        }),
      recordVerificationAttempt: () =>
        Effect.sync(() => {
          writes.push("verification");
          throw new Error("unexpected");
        }),
      addEvent: () =>
        Effect.sync(() => {
          writes.push("event");
          throw new Error("unexpected");
        }),
      save: () => Effect.fail(new PlotlineDagError({ message: "unused" })),
      subscribe: () => Stream.empty,
      delete: () => Effect.void,
    } as unknown as PlotlineDagService.PlotlineDagService["Service"];
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:test"),
        requestNamespace: "provider:test",
        thread: {
          threadId,
          providerSessionId: "provider:test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed(liveThreadShell(threadId, { interactionMode: "plan" })),
      }),
      Layer.succeed(PlotlineDagService.PlotlineDagService, service),
      Layer.succeed(HarnessEvents.HarnessSignificantEventStore, {
        reconcileCorrectionChild: () => Effect.void,
      } as unknown as HarnessEvents.HarnessSignificantEventStore["Service"]),
    );
    const calls = Effect.gen(function* () {
      const toolkit = yield* PlotlineToolkit;
      const cases = [
        ["plotline_dag_create", { title: "X", description: "" }],
        [
          "plotline_dag_add_tasks",
          {
            dagId: "dag",
            tasks: [{ id: "a", title: "A", description: "", effort: 1, dependsOn: [] }],
          },
        ],
        ["plotline_dag_update_task", { dagId: "dag", taskId: "a", state: "done" }],
        [
          "plotline_dag_record_verification",
          {
            dagId: "dag",
            taskId: "a",
            attemptId: "attempt-1",
            expectedCriteriaVersion: 1,
            expectedRunId: null,
            verdict: "pass",
            summary: "Passed",
            criterionResults: [],
          },
        ],
        ["plotline_dag_add_event", { dagId: "dag", message: "started" }],
      ] as const;
      for (const [name, input] of cases) {
        const result = yield* toolkit.handle(name, input).pipe(Stream.unwrap, Stream.runCollect);
        expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      }
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(PlotlineHandlers.layer).pipe(
          Layer.provideMerge(dependencies),
        ),
      ),
    );
    yield* calls;
    expect(writes).toEqual([]);
  }),
);

it.effect(
  "creates, reads, incrementally updates, and publishes a native DAG through the MCP tools",
  () => {
    const correctionCommandIds: string[] = [];
    const correctionTasks: string[] = [];
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
      yield* sql`CREATE TABLE plotline_task_run_index (project_id TEXT NOT NULL, dag_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id, dag_id, task_id))`;
      yield* sql`CREATE TABLE harness_opencode_reconciliation (event_kind TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL, next_attempt_at TEXT, updated_at TEXT NOT NULL)`;
      const service = yield* PlotlineDagService.PlotlineDagService;
      const initial = yield* Deferred.make<
        { dags: ReadonlyArray<import("@t3tools/contracts").PlotlineDag> },
        never
      >();
      const updates = yield* service.subscribe({ projectId: "project:mcp-test" }).pipe(
        Stream.take(2),
        Stream.tap((snapshot) => Deferred.succeed(initial, snapshot)),
        Stream.runCollect,
        Effect.forkChild,
      );
      expect((yield* Deferred.await(initial)).dags).toEqual([]);
      yield* Effect.yieldNow;

      const toolkit = yield* PlotlineToolkit;
      const verificationDescription =
        toolkit.tools.plotline_dag_record_verification.description ?? "";
      expect(verificationDescription).toContain(
        "explicit `expectedCriteriaVersion` and `expectedRunId`",
      );
      expect(verificationDescription).toContain("same-content replays are idempotent");
      expect(verificationDescription).toContain("Evidence is verifier-reported");
      expect(verificationDescription).toContain("Max 3 correction cycles by default");
      expect(verificationDescription).toContain("Cancellation/interruption ends corrections");
      const call = <Name extends keyof typeof toolkit.tools & string>(
        name: Name,
        input: Parameters<typeof toolkit.handle<Name>>[1],
      ) => toolkit.handle(name, input).pipe(Stream.unwrap, Stream.runCollect);
      const createdResult = yield* call("plotline_dag_create", {
        title: "Native DAG",
        description: "",
      });
      const created = createdResult.at(-1)?.result;
      expect(created).toMatchObject({
        projectId: "project:mcp-test",
        originatingThreadId: threadId,
      });
      if (!created || typeof created !== "object" || !("id" in created))
        throw new Error("DAG creation returned no DAG");
      const dagId = created.id as string;
      const addedResult = yield* call("plotline_dag_add_tasks", {
        dagId,
        tasks: [
          { id: "prepare", title: "Prepare", description: "", effort: 1, dependsOn: [] },
          {
            id: "upgrade",
            title: "Upgrade",
            description: "Fix dependency behavior",
            effort: 2,
            dependsOn: ["prepare"],
          },
        ],
      });
      expect(addedResult.at(-1)?.result).toMatchObject({
        tasks: [{ id: "prepare" }, { id: "upgrade", dependsOn: ["prepare"] }],
      });
      const criteria = yield* call("plotline_dag_update_task", {
        dagId,
        taskId: "upgrade",
        acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
      });
      expect(criteria.at(-1)?.result).toMatchObject({
        tasks: [{ id: "prepare" }, { id: "upgrade", acceptanceCriteria: [{ id: "works" }] }],
      });
      const verification = yield* call("plotline_dag_record_verification", {
        dagId,
        taskId: "upgrade",
        attemptId: "upgrade-check-1",
        expectedCriteriaVersion: 2,
        expectedRunId: null,
        verdict: "pass",
        summary: "The behavior works as expected.",
        criterionResults: [
          { criterionId: "works", verdict: "pass", evidence: "Focused test passed." },
        ],
      });
      expect(verification.at(-1)?.result).toMatchObject({
        tasks: [
          { id: "prepare", state: "pending" },
          {
            id: "upgrade",
            state: "pending",
            acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
            verificationAttempts: [
              {
                attemptId: "upgrade-check-1",
                verdict: "pass",
                summary: "The behavior works as expected.",
                criterionResults: [
                  { criterionId: "works", verdict: "pass", evidence: "Focused test passed." },
                ],
              },
            ],
          },
        ],
      });
      const fetched = yield* call("plotline_dag_get", { dagId });
      expect(fetched.at(-1)?.result).toMatchObject({
        id: dagId,
        tasks: [
          { id: "prepare" },
          {
            id: "upgrade",
            acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
            verificationAttempts: [{ attemptId: "upgrade-check-1", verdict: "pass" }],
          },
        ],
      });
      const edited = yield* call("plotline_dag_update_task", {
        dagId,
        taskId: "upgrade",
        title: "Upgrade dependencies",
      });
      expect(edited.at(-1)?.result).toMatchObject({
        tasks: [{ id: "prepare" }, { id: "upgrade", threadId: null, runId: null, agent: null }],
      });
      const updated = yield* call("plotline_dag_update_task", {
        dagId,
        taskId: "prepare",
        state: "running",
      });
      expect(updated.at(-1)?.result).toMatchObject({
        tasks: [
          { id: "prepare", state: "running", threadId, runId: "run:mcp-test", agent: "codex" },
          { id: "upgrade", state: "pending" },
        ],
      });
      const completed = yield* call("plotline_dag_update_task", {
        dagId,
        taskId: "prepare",
        state: "done",
      });
      expect(completed.at(-1)?.result).toMatchObject({
        tasks: [
          { id: "prepare", state: "done", threadId, runId: "run:mcp-test", agent: "codex" },
          { id: "upgrade", state: "pending" },
        ],
      });
      const failed = yield* call("plotline_dag_record_verification", {
        dagId,
        taskId: "upgrade",
        attemptId: "upgrade-check-fail",
        expectedCriteriaVersion: 2,
        expectedRunId: null,
        verdict: "fail",
        summary: "Focused test failed.",
        criterionResults: [
          { criterionId: "works", verdict: "fail", evidence: "Assertion failed." },
        ],
      });
      expect(failed.at(-1)?.result).toMatchObject({
        tasks: [
          { id: "prepare", state: "done" },
          {
            id: "upgrade",
            state: "running",
            threadId: "thread:correction",
            runId: "run:correction",
            correctionAttempts: [
              {
                verificationAttemptId: "upgrade-check-fail",
                childTaskId: "node:correction",
                childRunId: "run:correction",
                state: "running",
              },
            ],
          },
        ],
      });
      expect(correctionCommandIds).toHaveLength(1);
      expect(correctionCommandIds[0]).toMatch(/^plotline-correction-cor_/);
      expect(correctionTasks[0]).toContain("Fix dependency behavior");
      expect(correctionTasks[0]).toContain("Behavior works");
      expect(correctionTasks[0]).toContain("Assertion failed.");
      expect(correctionTasks[0]).toContain("Do not use Plotline MCP tools");
      expect(correctionTasks[0]).not.toContain(dagId);
      const stopped = yield* call("plotline_dag_record_verification", {
        dagId,
        taskId: "upgrade",
        attemptId: "upgrade-check-after-stop",
        expectedCriteriaVersion: 2,
        expectedRunId: "run:correction",
        verdict: "fail",
        summary: "The correction run stopped before acceptance.",
        criterionResults: [
          { criterionId: "works", verdict: "fail", evidence: "The run terminated." },
        ],
      });
      expect(stopped.at(-1)?.result).toMatchObject({
        tasks: [
          { id: "prepare" },
          {
            id: "upgrade",
            state: "failed",
            correctionAttempts: [{ state: "cancelled", childRunId: "run:correction" }],
          },
        ],
      });
      const stoppedDag = stopped.at(-1)!.result as {
        events: ReadonlyArray<{ message: string }>;
      };
      expect(stoppedDag.events[0]!.message).toContain(
        "Correction stopped after delegated run run:correction ended cancelled",
      );
      expect(correctionCommandIds).toHaveLength(1);
      expect((yield* Fiber.join(updates)).at(-1)?.dags[0]?.id).toBe(dagId);
      const outside = yield* Effect.exit(service.getForProject("project:other", dagId));
      expect(Exit.isFailure(outside)).toBe(true);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(PlotlineHandlers.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(McpInvocationContext.McpInvocationContext, {
                environmentId: EnvironmentId.make("environment:test"),
                requestNamespace: "provider:test",
                thread: {
                  threadId,
                  providerSessionId: "provider:test",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
                client: undefined,
                capabilities: new Set(["orchestration" as const]),
                issuedAt: 0,
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
                getThreadRecords: () =>
                  Effect.succeed({
                    runs: [{ id: "run:mcp-test", rootNodeId: "node:root", status: "running" }],
                    nodes: [],
                    subagents: [
                      {
                        id: "node:correction",
                        origin: "app_owned",
                        status: "cancelled",
                      },
                    ],
                  } as never),
                dispatch: (command) =>
                  Effect.sync(() => {
                    correctionCommandIds.push(command.commandId);
                    if (command.type === "delegated_task.request")
                      correctionTasks.push(command.task);
                    return {
                      storedEvents: [
                        {
                          event: {
                            type: "subagent.updated",
                            payload: {
                              id: "node:correction",
                              origin: "app_owned",
                              childThreadId: ThreadId.make("thread:correction"),
                            },
                          },
                        },
                        {
                          event: {
                            type: "run.created",
                            threadId: ThreadId.make("thread:correction"),
                            payload: { id: "run:correction" },
                          },
                        },
                      ],
                    } as never;
                  }),
              }),
              PlotlineDagService.layer.pipe(
                Layer.provideMerge(
                  Layer.mergeAll(
                    NodeSqliteClient.layer({ filename: ":memory:" }),
                    NodeCrypto.layer,
                  ),
                ),
              ),
              Layer.succeed(HarnessEvents.HarnessSignificantEventStore, {
                reconcileCorrectionChild: () => Effect.void,
              } as unknown as HarnessEvents.HarnessSignificantEventStore["Service"]),
            ),
          ),
        ),
      ),
    );
  },
);
