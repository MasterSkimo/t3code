import * as Schema from "effect/Schema";
import { PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const PlotlineTaskState = Schema.Literals([
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
]);
export type PlotlineTaskState = typeof PlotlineTaskState.Type;

export const PlotlineExecutionLifecycle = Schema.Literals([
  "executing",
  "awaiting_verification",
  "verification_passed",
  "verification_failed",
  "correction_in_progress",
  "failed_escalated",
]);
export type PlotlineExecutionLifecycle = typeof PlotlineExecutionLifecycle.Type;

export const PlotlineDagState = Schema.Literals(["waiting", "running", "done", "failed"]);
export type PlotlineDagState = typeof PlotlineDagState.Type;

export const PlotlineDagEvent = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  level: Schema.Literals(["info", "live", "ok", "error"]),
  message: Schema.String,
  taskId: Schema.NullOr(Schema.String),
});
export type PlotlineDagEvent = typeof PlotlineDagEvent.Type;

export const PlotlineVerificationVerdict = Schema.Literals(["pass", "fail", "inconclusive"]);
export type PlotlineVerificationVerdict = typeof PlotlineVerificationVerdict.Type;

const VerificationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const VerificationText = Schema.String.check(Schema.isMaxLength(8_192));
const VerificationSummary = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));
const VerificationCriteria = Schema.Array(
  Schema.Struct({
    id: VerificationId,
    description: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  }),
).check(Schema.isMaxLength(100));
const VerificationCriterionResults = Schema.Array(
  Schema.Struct({
    criterionId: VerificationId,
    verdict: PlotlineVerificationVerdict,
    evidence: VerificationText,
  }),
).check(Schema.isMaxLength(100));

export const PlotlineAcceptanceCriterion = Schema.Struct({
  id: VerificationId,
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
});
export type PlotlineAcceptanceCriterion = typeof PlotlineAcceptanceCriterion.Type;

export const PlotlineCriterionResult = Schema.Struct({
  criterionId: VerificationId,
  verdict: PlotlineVerificationVerdict,
  evidence: VerificationText,
});
export type PlotlineCriterionResult = typeof PlotlineCriterionResult.Type;

export const PlotlineVerificationAttempt = Schema.Struct({
  id: VerificationId,
  attemptId: VerificationId,
  verdict: PlotlineVerificationVerdict,
  summary: VerificationSummary,
  criterionResults: VerificationCriterionResults,
  criteriaVersion: Schema.optional(PositiveInt),
  runId: Schema.optional(Schema.String),
  createdAt: Schema.String,
});
export type PlotlineVerificationAttempt = typeof PlotlineVerificationAttempt.Type;

export const PlotlineVerifierRequestState = Schema.Literals([
  "requested",
  "dispatched",
  "completed",
  "failed",
]);
export type PlotlineVerifierRequestState = typeof PlotlineVerifierRequestState.Type;

export const PlotlineVerifierRequest = Schema.Struct({
  commandId: Schema.String,
  parentThreadId: ThreadId,
  parentRunId: Schema.String,
  parentNodeId: Schema.String,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  completionWake: Schema.Literal("always"),
  criteriaVersion: PositiveInt,
  expectedRunId: Schema.String,
  correctionId: VerificationId,
  state: PlotlineVerifierRequestState,
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
  promptVersion: Schema.optional(Schema.Number),
  childTaskId: Schema.optional(Schema.String),
  childThreadId: Schema.optional(ThreadId),
  childRunId: Schema.optional(Schema.String),
  retryCount: Schema.optional(Schema.Number),
  persistenceFailures: Schema.optional(Schema.Number),
  nextRetryAt: Schema.optional(Schema.String),
  diagnostic: Schema.optional(Schema.String),
});
export type PlotlineVerifierRequest = typeof PlotlineVerifierRequest.Type;

export const PlotlineDagUpdateVerifierRequestInput = Schema.Struct({
  dagId: Schema.String,
  taskId: Schema.String,
  correctionId: VerificationId,
  state: PlotlineVerifierRequestState,
  diagnostic: Schema.optional(Schema.String),
  persistenceFailure: Schema.optional(Schema.Boolean),
  replaceCommandId: Schema.optional(Schema.Boolean),
  refreshContext: Schema.optional(Schema.Boolean),
  expectedPersistenceFailures: Schema.optional(Schema.Number),
  expectedRetryCount: Schema.optional(Schema.Number),
  expectedCommandId: Schema.optional(Schema.String),
  expectedChildTaskId: Schema.optional(Schema.String),
  childTaskId: Schema.optional(Schema.String),
  childThreadId: Schema.optional(ThreadId),
  childRunId: Schema.optional(Schema.String),
});
export type PlotlineDagUpdateVerifierRequestInput =
  typeof PlotlineDagUpdateVerifierRequestInput.Type;

export const PlotlineCorrectionAttempt = Schema.Struct({
  id: VerificationId,
  verificationAttemptId: VerificationId,
  attempt: PositiveInt,
  state: Schema.Literals([
    "requested",
    "running",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  childTaskId: Schema.optional(Schema.String),
  childThreadId: Schema.optional(ThreadId),
  childRunId: Schema.optional(Schema.String),
  // The exact delegation input is persisted with the reservation so a retry can
  // replay the same command after a crash without relying on the MCP caller.
  dispatchInput: Schema.optional(Schema.Unknown),
  // Created in the same Plotline transaction that settles a successful correction.
  verifierRequest: Schema.optional(PlotlineVerifierRequest),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PlotlineCorrectionAttempt = typeof PlotlineCorrectionAttempt.Type;

export const PlotlineDagBeginCorrectionInput = Schema.Struct({
  dagId: Schema.String,
  taskId: Schema.String,
  verificationAttemptId: VerificationId,
  expectedCriteriaVersion: PositiveInt,
  expectedRunId: Schema.NullOr(Schema.String),
  dispatchInput: Schema.optional(Schema.Unknown),
});
export type PlotlineDagBeginCorrectionInput = typeof PlotlineDagBeginCorrectionInput.Type;
export const PlotlineDagLinkCorrectionInput = Schema.Struct({
  dagId: Schema.String,
  taskId: Schema.String,
  correctionId: VerificationId,
  childTaskId: Schema.String,
  childThreadId: ThreadId,
  childRunId: Schema.String,
});
export type PlotlineDagLinkCorrectionInput = typeof PlotlineDagLinkCorrectionInput.Type;
export const PlotlineDagSettleCorrectionInput = Schema.Struct({
  dagId: Schema.String,
  taskId: Schema.String,
  correctionId: VerificationId,
  state: Schema.Literals(["completed", "failed", "cancelled", "interrupted"]),
});
export type PlotlineDagSettleCorrectionInput = typeof PlotlineDagSettleCorrectionInput.Type;

export const PlotlineDagTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  state: PlotlineTaskState,
  executionLifecycle: Schema.optional(PlotlineExecutionLifecycle),
  effort: Schema.Number,
  dependsOn: Schema.Array(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(Schema.String),
  legacySessionIds: Schema.Array(Schema.String),
  agent: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  acceptanceCriteria: Schema.optional(VerificationCriteria),
  verificationAttempts: Schema.optional(
    Schema.Array(PlotlineVerificationAttempt).check(Schema.isMaxLength(100)),
  ),
  correctionAttempts: Schema.optional(
    Schema.Array(PlotlineCorrectionAttempt).check(Schema.isMaxLength(100)),
  ),
  criteriaVersion: Schema.optional(PositiveInt),
});
export type PlotlineDagTask = typeof PlotlineDagTask.Type;

export const PlotlineDag = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  originatingThreadId: Schema.optional(ThreadId),
  title: Schema.String,
  description: Schema.String,
  workspace: Schema.NullOr(Schema.String),
  state: PlotlineDagState,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  tasks: Schema.Array(PlotlineDagTask),
  events: Schema.Array(PlotlineDagEvent),
});
export type PlotlineDag = typeof PlotlineDag.Type;

export const PlotlineDagListInput = Schema.Struct({ projectId: Schema.optional(Schema.String) });
export type PlotlineDagListInput = typeof PlotlineDagListInput.Type;

export const PlotlineDagListResult = Schema.Struct({ dags: Schema.Array(PlotlineDag) });
export type PlotlineDagListResult = typeof PlotlineDagListResult.Type;

export const PlotlineDagSaveInput = Schema.Struct({ dag: PlotlineDag });
export type PlotlineDagSaveInput = typeof PlotlineDagSaveInput.Type;

export const PlotlineDagCreateInput = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
});
export type PlotlineDagCreateInput = typeof PlotlineDagCreateInput.Type;
export const PlotlineDagAddTasksInput = Schema.Struct({
  dagId: Schema.String,
  tasks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      description: Schema.String,
      effort: Schema.Number,
      dependsOn: Schema.Array(Schema.String),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type PlotlineDagAddTasksInput = typeof PlotlineDagAddTasksInput.Type;
export const PlotlineDagUpdateTaskInput = Schema.Struct({
  dagId: Schema.String,
  taskId: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.Number),
  dependsOn: Schema.optional(Schema.Array(Schema.String)),
  state: Schema.optional(PlotlineTaskState),
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  runId: Schema.optional(Schema.NullOr(Schema.String)),
  agent: Schema.optional(Schema.NullOr(Schema.String)),
  acceptanceCriteria: Schema.optional(VerificationCriteria),
});
export type PlotlineDagUpdateTaskInput = typeof PlotlineDagUpdateTaskInput.Type;
export const PlotlineDagRecordVerificationInput = Schema.Struct({
  dagId: Schema.String,
  taskId: Schema.String,
  attemptId: VerificationId,
  expectedCriteriaVersion: PositiveInt,
  expectedRunId: Schema.NullOr(Schema.String),
  verdict: PlotlineVerificationVerdict,
  summary: VerificationSummary,
  criterionResults: VerificationCriterionResults,
});
export type PlotlineDagRecordVerificationInput = typeof PlotlineDagRecordVerificationInput.Type;
export const PlotlineDagAddEventInput = Schema.Struct({
  dagId: Schema.String,
  taskId: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.String,
  level: Schema.optional(Schema.Literals(["info", "live", "ok", "error"])),
});
export type PlotlineDagAddEventInput = typeof PlotlineDagAddEventInput.Type;

export const PlotlineDagDeleteInput = Schema.Struct({ id: Schema.String, confirm: Schema.Boolean });
export type PlotlineDagDeleteInput = typeof PlotlineDagDeleteInput.Type;

export class PlotlineDagError extends Schema.TaggedError<PlotlineDagError>()("PlotlineDagError", {
  message: Schema.String,
  dagId: Schema.optional(Schema.String),
}) {}
