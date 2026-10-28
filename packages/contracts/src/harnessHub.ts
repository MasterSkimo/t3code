import * as Schema from "effect/Schema";

export const HarnessHubResource = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["skill", "rule", "agent", "hook", "mcp", "unknown"]),
  name: Schema.String,
  scope: Schema.Literals(["project", "global"]),
  projectId: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  source: Schema.String,
  ownership: Schema.Literals(["managed", "user", "unknown"]),
  description: Schema.optional(Schema.String),
  status: Schema.Literals(["installed", "unknown"]),
  operations: Schema.Array(Schema.String),
});
export const HarnessHubListInput = Schema.Struct({ projectId: Schema.optional(Schema.String) });
export const HarnessHubListResult = Schema.Struct({ resources: Schema.Array(HarnessHubResource) });
export type HarnessHubListInput = typeof HarnessHubListInput.Type;
export type HarnessHubListResult = typeof HarnessHubListResult.Type;
