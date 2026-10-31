import * as Schema from "effect/Schema";

/** A completed unbound task is agent-reported plan progress, never a native T3 execution result. */
export const PlotlinePlanState = Schema.Literals(["planned", "completed", "skipped", "cancelled"]);
export type PlotlinePlanState = typeof PlotlinePlanState.Type;

export const PlotlinePlanTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  detail: Schema.String,
  parentTaskId: Schema.NullOr(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  planState: PlotlinePlanState,
  reason: Schema.NullOr(Schema.String),
  createdByThreadId: Schema.String,
  /** Native T3 child and delegated-task IDs, verified when bound. */
  boundThreadId: Schema.NullOr(Schema.String),
  boundTaskId: Schema.NullOr(Schema.String),
  /** Earlier native attempts, retained after a completed/failed delegation is retried. */
  bindingHistory: Schema.optional(Schema.Array(Schema.Struct({
    delegatedTaskId: Schema.String,
    childThreadId: Schema.NullOr(Schema.String),
  }))),
});
export type PlotlinePlanTask = typeof PlotlinePlanTask.Type;

export const PlotlinePlan = Schema.Struct({
  rootThreadId: Schema.String,
  title: Schema.String,
  revision: Schema.Number,
  tasks: Schema.Array(PlotlinePlanTask),
  updatedAt: Schema.String,
});
export type PlotlinePlan = typeof PlotlinePlan.Type;

export const PlotlinePlanGet = Schema.Struct({ rootThreadId: Schema.String });
export const PlotlinePlanGetResult = Schema.Struct({
  plan: Schema.NullOr(PlotlinePlan),
});

export const PlotlineTaskDefinition = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  detail: Schema.optional(Schema.String),
  parentTaskId: Schema.optional(Schema.NullOr(Schema.String)),
  dependsOn: Schema.optional(Schema.Array(Schema.String)),
});
export const PlotlinePlanCreate = Schema.Struct({
  // Optional for model callers. The server derives a stable request ID when omitted.
  requestId: Schema.optional(Schema.String),
  title: Schema.String,
  tasks: Schema.Array(PlotlineTaskDefinition),
});
export const PlotlineTaskAdd = Schema.Struct({
  requestId: Schema.String,
  task: PlotlineTaskDefinition,
});
export const PlotlineTaskUpdate = Schema.Struct({
  requestId: Schema.String,
  taskId: Schema.String,
  title: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  dependsOn: Schema.optional(Schema.Array(Schema.String)),
  planState: Schema.optional(PlotlinePlanState),
  reason: Schema.optional(Schema.String),
});
export const PlotlineTaskBind = Schema.Struct({
  requestId: Schema.String,
  taskId: Schema.String,
  delegatedTaskId: Schema.String,
});
export const PlotlinePlanMutationResult = Schema.Struct({
  rootThreadId: Schema.String,
  revision: Schema.Number,
  updated: Schema.Boolean,
});
export const PLOTLINE_PLAN_METHODS = {
  get: "plotline.plan.get",
} as const;

export type PlotlinePlanCreate = typeof PlotlinePlanCreate.Type;
export type PlotlineTaskAdd = typeof PlotlineTaskAdd.Type;
export type PlotlineTaskUpdate = typeof PlotlineTaskUpdate.Type;
export type PlotlineTaskBind = typeof PlotlineTaskBind.Type;
export type PlotlinePlanMutationResult = typeof PlotlinePlanMutationResult.Type;