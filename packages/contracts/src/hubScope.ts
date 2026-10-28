import * as Schema from "effect/Schema";

export const HarnessHubScope = Schema.Literals(["project", "global"]);
export const HarnessHubScopePreviewInput = Schema.Struct({
  projectId: Schema.String,
  resourceId: Schema.String,
  destinationScope: HarnessHubScope,
  destinationName: Schema.optional(Schema.String),
});
export const HarnessHubScopeConflict = Schema.Struct({
  name: Schema.String,
  ownership: Schema.Literals(["managed", "user"]),
});
export const HarnessHubScopePreviewResult = Schema.Struct({
  previewId: Schema.String,
  confirmationToken: Schema.String,
  sourceName: Schema.String,
  sourceScope: HarnessHubScope,
  destinationScope: HarnessHubScope,
  destinationName: Schema.String,
  before: Schema.NullOr(Schema.String),
  after: Schema.String,
  conflicts: Schema.Array(HarnessHubScopeConflict),
});
export const HarnessHubScopeApplyInput = Schema.Struct({
  previewId: Schema.String,
  confirmationToken: Schema.String,
  confirmed: Schema.Boolean,
  resolution: Schema.optional(Schema.Literal("replace-managed")),
});
export const HarnessHubScopeHistoryInput = Schema.Struct({
  scope: HarnessHubScope,
  projectId: Schema.String,
});
export const HarnessHubScopeHistoryEntry = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  sourceName: Schema.String,
  sourceScope: HarnessHubScope,
  destinationName: Schema.String,
  destinationScope: HarnessHubScope,
});
export const HarnessHubScopeHistoryResult = Schema.Struct({
  entries: Schema.Array(HarnessHubScopeHistoryEntry),
});
export const HarnessHubScopeRollbackInput = Schema.Struct({
  scope: HarnessHubScope,
  projectId: Schema.String,
  entryId: Schema.String,
});
export type HarnessHubScopePreviewInput = typeof HarnessHubScopePreviewInput.Type;
export type HarnessHubScopePreviewResult = typeof HarnessHubScopePreviewResult.Type;
export type HarnessHubScopeApplyInput = typeof HarnessHubScopeApplyInput.Type;
export type HarnessHubScopeHistoryInput = typeof HarnessHubScopeHistoryInput.Type;
export type HarnessHubScopeHistoryEntry = typeof HarnessHubScopeHistoryEntry.Type;
export type HarnessHubScopeRollbackInput = typeof HarnessHubScopeRollbackInput.Type;
