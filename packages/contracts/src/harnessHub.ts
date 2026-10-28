import * as Schema from "effect/Schema";

export const HarnessHubResource = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["skill", "rule", "agent", "hook", "mcp", "command", "config", "unknown"]),
  name: Schema.String,
  scope: Schema.Literals(["project", "global", "ancestor"]),
  projectId: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  source: Schema.String,
  ownership: Schema.Literals(["managed", "user", "unknown"]),
  description: Schema.optional(Schema.String),
  status: Schema.Literals(["installed", "unknown"]),
  operations: Schema.Array(Schema.String),
  // Federated metadata is safe to expose; no instruction bodies or MCP secrets are sent.
  fingerprint: Schema.optional(Schema.String),
  resolution: Schema.optional(Schema.Literals(["unique", "identical-copy", "collision-unresolved"])),
  relatedIds: Schema.optional(Schema.Array(Schema.String)),
  compatibility: Schema.optional(Schema.Literals(["native", "shared-convention", "unknown"])),
  consumers: Schema.optional(Schema.Array(Schema.String)),
  diagnostics: Schema.optional(Schema.Array(Schema.String)),
  version: Schema.optional(Schema.String),
});
export const HarnessHubListInput = Schema.Struct({ projectId: Schema.optional(Schema.String) });
export const HarnessHubListResult = Schema.Struct({ resources: Schema.Array(HarnessHubResource) });
export type HarnessHubListInput = typeof HarnessHubListInput.Type;
export type HarnessHubListResult = typeof HarnessHubListResult.Type;
