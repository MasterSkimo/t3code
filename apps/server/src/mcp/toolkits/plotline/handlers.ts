import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PlotlineDagService from "../../../plotline/PlotlineDagService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HarnessEvents from "../../../harness/events.ts";
import { CommandId } from "@t3tools/contracts";
import {
  dispatchFailure,
  readCaller,
  resolveProjectId,
  unavailable,
  type Caller,
} from "../../threadAccess.ts";
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
      if (context.scope.thread) {
        const currentDag = yield* service
          .getForProject(projectId, input.dagId)
          .pipe(Effect.mapError(unavailable));
        const correction = currentDag.tasks
          .find((task) => task.id === input.taskId)
          ?.correctionAttempts?.at(-1);
        if (correction?.state === "running" && correction.childTaskId !== undefined) {
          const projection = yield* context.threads
            .getThreadRecords(context.scope.thread.threadId, ["subagents"])
            .pipe(Effect.mapError(unavailable));
          const child = projection.subagents.find(
            (subagent) => subagent.id === correction.childTaskId && subagent.origin === "app_owned",
          );
          if (child && ["completed", "failed", "cancelled", "interrupted"].includes(child.status))
            yield* service
              .settleCorrection(projectId, {
                dagId: input.dagId,
                taskId: input.taskId,
                correctionId: correction.id,
                state: child.status as "completed" | "failed" | "cancelled" | "interrupted",
              })
              .pipe(Effect.mapError(unavailable));
        }
      }
      const dag = yield* service
        .recordVerificationAttempt(projectId, input)
        .pipe(Effect.mapError(unavailable));
      if (input.verdict !== "fail") return dag;

      // Validate the dispatch owner before reserving a correction. Otherwise a missing or
      // inactive caller leaves a durable `requested` attempt with no invocation to resume.
      if (!context.scope.thread || !context.caller?.activeRunId)
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "Plotline corrections require the active T3 run that owns this DAG.",
        });
      const parent = yield* context.threads
        .getThreadRecords(context.scope.thread.threadId, ["runs", "nodes"])
        .pipe(Effect.mapError(unavailable));
      const parentRun = parent.runs.find(
        (run) => run.id === context.caller!.activeRunId && ThreadManagementService.isActiveRun(run),
      );
      if (parentRun?.rootNodeId === null || parentRun === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "Plotline corrections require the active T3 run that owns this DAG.",
        });

      const begun = yield* service
        .beginCorrection(projectId, {
          dagId: input.dagId,
          taskId: input.taskId,
          verificationAttemptId: input.attemptId,
          expectedCriteriaVersion: input.expectedCriteriaVersion,
          expectedRunId: input.expectedRunId,
        })
        .pipe(Effect.mapError(unavailable));
      if (!begun.shouldDispatch || !begun.correction) return begun.dag;

      const task = begun.dag.tasks.find((candidate) => candidate.id === input.taskId);
      const failedCriteria = input.criterionResults
        .filter((result) => result.verdict === "fail")
        .map((result) => {
          const criterion = task?.acceptanceCriteria?.find(
            (item) => item.id === result.criterionId,
          );
          return `- ${result.criterionId}: ${criterion?.description ?? "Acceptance criterion"}\n  Evidence: ${result.evidence}`;
        })
        .join("\n");
      const commandId = CommandId.make(`plotline-correction-${begun.correction.id}`);
      const delegated = yield* context.threads
        .dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId,
          parentThreadId: context.scope.thread.threadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          title: `Correct Plotline task ${input.taskId}`,
          task: [
            `Correct native Plotline task ${input.taskId} (DAG ${input.dagId}).`,
            `This is correction cycle ${begun.correction.attempt} of 3. Preserve the task's intent and make the narrowest appropriate correction.`,
            `Failed verifier summary: ${input.summary}`,
            `Failed criteria:\n${failedCriteria || "No criterion-specific failure evidence was supplied."}`,
            "Do not claim acceptance. The parent will independently verify the resulting run against the current acceptance criteria.",
          ].join("\n\n"),
          modelSelection: context.caller.modelSelection,
          runtimeMode: context.caller.runtimeMode,
          interactionMode: context.caller.interactionMode,
          completionWake: "always",
        })
        .pipe(Effect.mapError(dispatchFailure));
      const taskEvent = delegated.storedEvents.find(
        (stored) =>
          stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
      );
      if (taskEvent?.event.type !== "subagent.updated")
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message:
            "Correction command did not produce a delegated task; retry this verification call to resume the same correction.",
        });
      if (taskEvent.event.payload.childThreadId === null)
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message:
            "Correction child thread identity is not available; retry this verification call to resume the same correction.",
        });
      const childThreadId = taskEvent.event.payload.childThreadId;
      const childRunEvent = delegated.storedEvents.find(
        (stored) => stored.event.type === "run.created" && stored.event.threadId === childThreadId,
      );
      if (childRunEvent?.event.type !== "run.created")
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message:
            "Correction was accepted but its run identity is not available yet; retry this verification call to resume the same correction.",
        });
      const harnessEvents = yield* HarnessEvents.HarnessSignificantEventStore;
      const linked = yield* service
        .linkCorrection(projectId, {
          dagId: input.dagId,
          taskId: input.taskId,
          correctionId: begun.correction.id,
          childTaskId: taskEvent.event.payload.id,
          childThreadId,
          childRunId: childRunEvent.event.payload.id,
        })
        .pipe(Effect.mapError(unavailable));
      yield* harnessEvents
        .reconcileCorrectionChild({ childThreadId, childRunId: childRunEvent.event.payload.id })
        .pipe(Effect.mapError(unavailable));
      return linked;
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
