import {
  PlotlinePlanCreate, PlotlineTaskAdd, PlotlineTaskUpdate, PlotlineTaskBind,
  PlotlinePlanMutationResult, PlotlineStorageError, OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PlotlineStore from "../../../plotline/PlotlineStore.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  PlotlineStore.PlotlineStore,
];
const failure = Schema.Union([PlotlineStorageError, OrchestratorMcpFailure]);

const Create = Tool.make("plotline_plan_create", {
  description: "Initialize a read-only, conversation-scoped Plotline DAG before delegating. Root orchestrator only. Pass stable unique task IDs, parentTaskId for hierarchy and dependsOn for logical prerequisites. This never dispatches work.",
  parameters: PlotlinePlanCreate, success: PlotlinePlanMutationResult, failure,
  failureMode: "return", dependencies,
}).annotate(Tool.Title, "Initialize Plotline task plan")
  .annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true);

const Add = Tool.make("plotline_task_add", {
  description: "Add a task discovered during work. Workers must set parentTaskId to their assigned task or a task they created. A plan task never starts a T3 run. Workers may wait briefly for the parent to bind their native delegation. Reuse the same requestId for retries.",
  parameters: PlotlineTaskAdd, success: PlotlinePlanMutationResult, failure,
  failureMode: "return", dependencies,
}).annotate(Tool.Title, "Add Plotline task")
  .annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true);

const Update = Tool.make("plotline_task_update", {
  description: "Update a plan task's title, prerequisites or planState. For unbound tasks created/discovered by workers, set planState=completed when finished (reason optional). To skip/cancel use planState=skipped/cancelled with a reason. Never mark a bound task completed: its status comes from native T3 delegation. The root orchestrator may settle unbound descendants after confirming their outcome. Then continue eligible dependent tasks using delegate_task; Plotline does not schedule work. Reuse requestId on retry.",
  parameters: PlotlineTaskUpdate, success: PlotlinePlanMutationResult, failure,
  failureMode: "return", dependencies,
}).annotate(Tool.Title, "Update Plotline task plan")
  .annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true);

const Bind = Tool.make("plotline_task_bind", {
  description: "Bind a PLANNED task to the native delegated-task ID returned by delegate_task, before waiting for the worker. Native T3 controls bound-task completion. Workers may bind only subtasks they created. A native retry reuses the SAME plan task, retaining earlier attempts. A manually completed/skipped/cancelled task must first be reset to planned. Binding never drives execution.",
  parameters: PlotlineTaskBind, success: PlotlinePlanMutationResult, failure,
  failureMode: "return", dependencies,
}).annotate(Tool.Title, "Bind native T3 delegation to plan")
  .annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true);

export const PlotlineToolkit = Toolkit.make(Create, Add, Update, Bind);
