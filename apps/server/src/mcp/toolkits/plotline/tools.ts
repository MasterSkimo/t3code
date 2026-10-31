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
  description: "Add a task discovered during work. Workers must set parentTaskId to their assigned task or a task they created. A plan task never starts a T3 run. Reuse the same requestId for retries.",
  parameters: PlotlineTaskAdd, success: PlotlinePlanMutationResult, failure,
  failureMode: "return", dependencies,
}).annotate(Tool.Title, "Add Plotline task")
  .annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true);

const Update = Tool.make("plotline_task_update", {
  description: "Revise a plan task, its prerequisites or mark it skipped/cancelled with a reason. Changes only advisory plan metadata, not native T3 execution or task status. Reuse requestId on retry.",
  parameters: PlotlineTaskUpdate, success: PlotlinePlanMutationResult, failure,
  failureMode: "return", dependencies,
}).annotate(Tool.Title, "Update Plotline task plan")
  .annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true);

const Bind = Tool.make("plotline_task_bind", {
  description: "Root orchestrator only: bind a planned task to an actual native T3 delegated-task ID returned by delegate_task. Binding lets Plotline display real T3 status/model, never drives execution.",
  parameters: PlotlineTaskBind, success: PlotlinePlanMutationResult, failure,
  failureMode: "return", dependencies,
}).annotate(Tool.Title, "Bind native T3 delegation to plan")
  .annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true);

export const PlotlineToolkit = Toolkit.make(Create, Add, Update, Bind);
