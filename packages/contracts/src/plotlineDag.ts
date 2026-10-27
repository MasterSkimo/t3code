import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const PlotlineTaskState = Schema.Literals([
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
]);
export type PlotlineTaskState = typeof PlotlineTaskState.Type;

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

export const PlotlineDagTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  state: PlotlineTaskState,
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
});
export type PlotlineDagTask = typeof PlotlineDagTask.Type;

export const PlotlineDag = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
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

export const PlotlineDagDeleteInput = Schema.Struct({ id: Schema.String, confirm: Schema.Boolean });
export type PlotlineDagDeleteInput = typeof PlotlineDagDeleteInput.Type;

export class PlotlineDagError extends Schema.TaggedError<PlotlineDagError>()("PlotlineDagError", {
  message: Schema.String,
  dagId: Schema.optional(Schema.String),
}) {}
