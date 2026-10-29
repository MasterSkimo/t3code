import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PlotlineDagService from "../../../plotline/PlotlineDagService.ts";
import { readCaller, resolveProjectId, unavailable, type Caller } from "../../threadAccess.ts";
import { PlotlineToolkit } from "./tools.ts";

const assertWritablePlanMode = (context: Caller) =>
  context.limits.interactionMode === "plan"
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Plotline DAG changes are unavailable in read-only Plan mode.",
        }),
      )
    : Effect.void;

const layer = McpToolAccess.toLayer(PlotlineToolkit, {
  plotline_dag_create: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      yield* assertWritablePlanMode(context);
      if (!context.scope.thread)
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Run this tool from an active T3 thread.",
        });
      const projectId = yield* resolveProjectId(context, undefined);
      const service = yield* PlotlineDagService.PlotlineDagService;
      const runId = context.caller?.activeRunId ?? null;
      return yield* service
        .createForProject(projectId, context.scope.thread.threadId, runId, input)
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  plotline_dag_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, undefined);
      const service = yield* PlotlineDagService.PlotlineDagService;
      return yield* service.list({ projectId }).pipe(Effect.mapError(unavailable));
    }),
  ),
  plotline_dag_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, undefined);
      const service = yield* PlotlineDagService.PlotlineDagService;
      return yield* service
        .getForProject(projectId, input.dagId)
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  plotline_dag_add_tasks: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      yield* assertWritablePlanMode(context);
      const projectId = yield* resolveProjectId(context, undefined);
      const service = yield* PlotlineDagService.PlotlineDagService;
      return yield* service.addTasks(projectId, input).pipe(Effect.mapError(unavailable));
    }),
  ),
  plotline_dag_update_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      yield* assertWritablePlanMode(context);
      if (!context.scope.thread)
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Run this tool from an active T3 thread.",
        });
      const projectId = yield* resolveProjectId(context, undefined);
      const service = yield* PlotlineDagService.PlotlineDagService;
      return yield* service
        .updateTask(projectId, {
          ...input,
          ...(input.state === "running"
            ? {
                threadId: context.scope.thread.threadId,
                runId: context.caller?.activeRunId ?? null,
                agent: context.scope.thread.providerInstanceId,
              }
            : {}),
        })
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  plotline_dag_record_verification: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      yield* assertWritablePlanMode(context);
      const projectId = yield* resolveProjectId(context, undefined);
      const service = yield* PlotlineDagService.PlotlineDagService;
      return yield* service
        .recordVerificationAttempt(projectId, input)
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  plotline_dag_add_event: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      yield* assertWritablePlanMode(context);
      const projectId = yield* resolveProjectId(context, undefined);
      const service = yield* PlotlineDagService.PlotlineDagService;
      return yield* service.addEvent(projectId, input).pipe(Effect.mapError(unavailable));
    }),
  ),
});

export { layer };
