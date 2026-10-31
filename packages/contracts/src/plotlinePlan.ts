import * as Schema from "effect/Schema";

/** Plan states are advisory. Only T3 can supply an execution status. */
export const PlotlinePlanState = Schema.Literals(["planned", "skipped", "cancelled"]);
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
  requestId: Schema.String,
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