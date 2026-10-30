import {
  OrchestratorMcpFailure,
  PlotlineDag,
  PlotlineDagAddEventInput,
  PlotlineDagAddTasksInput,
  PlotlineDagCreateInput,
  PlotlineDagListResult,
  PlotlineDagRecordVerificationInput,
  PlotlineAcceptanceCriterion,
  PlotlineTaskState,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PlotlineDagService from "../../../plotline/PlotlineDagService.ts";
import * as HarnessEvents from "../../../harness/events.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PlotlineDagService.PlotlineDagService,
];
const common = { failure: OrchestratorMcpFailure, failureMode: "return" as const, dependencies };

const CreateTool = Tool.make("plotline_dag_create", {
  ...common,
  description:
    "Create a native Plotline DAG in this thread's project. The DAG is linked to this thread. Returns its native ID for follow-up operations.",
  parameters: PlotlineDagCreateInput,
  success: PlotlineDag,
})
  .annotate(Tool.Title, "Create a Plotline DAG")
  .annotate(Tool.Destructive, false);
const ListTool = Tool.make("plotline_dag_list", {
  ...common,
  description: "List native Plotline DAGs in this thread's project.",
  parameters: Tool.EmptyParams,
  success: PlotlineDagListResult,
})
  .annotate(Tool.Title, "List Plotline DAGs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
const GetTool = Tool.make("plotline_dag_get", {
  ...common,
  description: "Read one native Plotline DAG in this thread's project by dagId.",
  parameters: Schema.Struct({ dagId: Schema.String }),
  success: PlotlineDag,
})
  .annotate(Tool.Title, "Get a Plotline DAG")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
const AddTasksTool = Tool.make("plotline_dag_add_tasks", {
  ...common,
  description:
    "Add tasks incrementally to a DAG in this thread's project. Each task ID must be unique; dependencies can reference existing or newly added tasks.",
  parameters: PlotlineDagAddTasksInput,
  success: PlotlineDag,
})
  .annotate(Tool.Title, "Add Plotline tasks")
  .annotate(Tool.Destructive, false);
const UpdateTaskTool = Tool.make("plotline_dag_update_task", {
  ...common,
  description:
    "Update one task's metadata, state, execution link, or acceptance criteria in a DAG in this thread's project. Define criteria before recording verification. State transitions and dependencies are validated.",
  parameters: Schema.Struct({
    dagId: Schema.String,
    taskId: Schema.String,
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    effort: Schema.optional(Schema.Number),
    dependsOn: Schema.optional(Schema.Array(Schema.String)),
    state: Schema.optional(PlotlineTaskState),
    acceptanceCriteria: Schema.optional(Schema.Array(PlotlineAcceptanceCriterion)),
  }),
  success: PlotlineDag,
})
  .annotate(Tool.Title, "Update a Plotline task")
  .annotate(Tool.Destructive, false);
const RecordVerificationTool = Tool.make("plotline_dag_record_verification", {
  ...common,
  dependencies: [...dependencies, HarnessEvents.HarnessSignificantEventStore],
  description:
    "Record a verifier-reported verdict against an explicitly expected criteria version and run identity (use null when the task has no linked run). Include an attemptId, summary, and a result for each criterion you evaluated. The verdict and evidence are claims supplied by the verifier; Plotline does not independently rerun tests or prove that evidence is reproducible. Submissions whose expected criteria version or run no longer matches are rejected, including replays. Keep attempts in history. A failed verification automatically starts one T3-owned delegated correction using the existing delegation command/outbox, linked to this task and run; use its correctionAttempts[].childTaskId with task_status instead of launching a second delegate. After completion, independently verify against the linked runId with a new attemptId. T3 enforces at most 3 correction cycles by default, then records escalation and stops. Cancellation or interruption ends the lifecycle without further corrections. Recording verification never accepts/completes the task; only a current passing verification can satisfy its completion gate.",
  parameters: PlotlineDagRecordVerificationInput,
  success: PlotlineDag,
})
  .annotate(Tool.Title, "Record task verification")
  .annotate(Tool.Destructive, false);
const AddEventTool = Tool.make("plotline_dag_add_event", {
  ...common,
  description: "Append a meaningful execution event to a DAG in this thread's project.",
  parameters: PlotlineDagAddEventInput,
  success: PlotlineDag,
})
  .annotate(Tool.Title, "Record a Plotline event")
  .annotate(Tool.Destructive, false);

export const PlotlineToolkit = Toolkit.make(
  CreateTool,
  ListTool,
  GetTool,
  AddTasksTool,
  UpdateTaskTool,
  RecordVerificationTool,
  AddEventTool,
);
