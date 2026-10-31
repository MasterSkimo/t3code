import * as Schema from "effect/Schema";

/** Extension-owned representation; never part of T3's execution lifecycle. */
export const PlotlineObserverNode = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  title: Schema.String,
  kind: Schema.Literals(["run", "delegation"]),
  status: Schema.String,
  provider: Schema.NullOr(Schema.String),
  detail: Schema.String,
  result: Schema.NullOr(Schema.String),
});
export type PlotlineObserverNode = typeof PlotlineObserverNode.Type;

export const PlotlineObserverEdge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
});
export type PlotlineObserverEdge = typeof PlotlineObserverEdge.Type;

export const PlotlineSaveInput = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.String,
  title: Schema.String,
  nodes: Schema.Array(PlotlineObserverNode),
  edges: Schema.Array(PlotlineObserverEdge),
});
export type PlotlineSaveInput = typeof PlotlineSaveInput.Type;

export const PlotlineDagSnapshot = Schema.Struct({
  ...PlotlineSaveInput.fields,
  updatedAt: Schema.String,
});
export type PlotlineDagSnapshot = typeof PlotlineDagSnapshot.Type;

export const PlotlineListInput = Schema.Struct({ threadId: Schema.String });
export const PlotlineListResult = Schema.Struct({ dags: Schema.Array(PlotlineDagSnapshot) });

export class PlotlineStorageError extends Schema.TaggedError<PlotlineStorageError>()(
  "PlotlineStorageError",
  { message: Schema.String },
) {}

export const PLOTLINE_WS_METHODS = {
  list: "plotline.observer.list",
  save: "plotline.observer.save",
} as const;
