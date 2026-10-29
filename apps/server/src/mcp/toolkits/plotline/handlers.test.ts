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
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
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
          { id: "upgrade", title: "Upgrade", description: "", effort: 2, dependsOn: ["prepare"] },
        ],
      });
      expect(addedResult.at(-1)?.result).toMatchObject({
        tasks: [{ id: "prepare" }, { id: "upgrade", dependsOn: ["prepare"] }],
      });
      const fetched = yield* call("plotline_dag_get", { dagId });
      expect(fetched.at(-1)?.result).toMatchObject({
        id: dagId,
        tasks: [{ id: "prepare" }, { id: "upgrade" }],
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
              }),
              PlotlineDagService.layer.pipe(
                Layer.provideMerge(
                  Layer.mergeAll(
                    NodeSqliteClient.layer({ filename: ":memory:" }),
                    NodeCrypto.layer,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
);
