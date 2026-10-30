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
  description: "Create and link a DAG to this thread. Returns its ID.",
  parameters: PlotlineDagCreateInput,
  success: PlotlineDag,
})
  .annotate(Tool.Title, "Create a Plotline DAG")
  .annotate(Tool.Destructive, false);
const ListTool = Tool.make("plotline_dag_list", {
  ...common,
  description: "List project DAGs.",
  parameters: Tool.EmptyParams,
  success: PlotlineDagListResult,
})
  .annotate(Tool.Title, "List Plotline DAGs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
const GetTool = Tool.make("plotline_dag_get", {
  ...common,
  description: "Get one DAG by `dagId`.",
  parameters: Schema.Struct({ dagId: Schema.String }),
  success: PlotlineDag,
})
  .annotate(Tool.Title, "Get a Plotline DAG")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
const AddTasksTool = Tool.make("plotline_dag_add_tasks", {
  ...common,
  description:
    "Add tasks to a DAG. IDs must be unique; dependencies may target existing or added tasks.",
  parameters: PlotlineDagAddTasksInput,
  success: PlotlineDag,
})
  .annotate(Tool.Title, "Add Plotline tasks")
  .annotate(Tool.Destructive, false);
const UpdateTaskTool = Tool.make("plotline_dag_update_task", {
  ...common,
  description:
    "Update task metadata, state, execution link, or criteria. Define criteria before verification; transitions/dependencies are validated.",
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
    "Submit a verifier-reported verdict for explicit `expectedCriteriaVersion` and `expectedRunId` (`null` if unlinked), unique `attemptId`, summary, and per-criterion results/evidence. Evidence is verifier-reported; Plotline does not rerun tests or prove reproducibility. Stale criteria/runs reject; same-content replays are idempotent. Keep attempts. Failure starts one T3 correction; follow `correctionAttempts[].childTaskId` with `task_status`, never delegate again. Independently verify the linked run with a new attempt ID. Max 3 correction cycles by default, then escalate/stop. Cancellation/interruption ends corrections. Recording is not completion; only current passing verification meets the gate.",
  parameters: PlotlineDagRecordVerificationInput,
  success: PlotlineDag,
})
  .annotate(Tool.Title, "Record task verification")
  .annotate(Tool.Destructive, false);
const AddEventTool = Tool.make("plotline_dag_add_event", {
  ...common,
  description: "Append an event to a DAG.",
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
