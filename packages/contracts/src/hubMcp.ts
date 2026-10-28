import * as Schema from "effect/Schema";

export const HarnessMcpProvider = Schema.Literals(["codex", "claude", "opencode"]);
export const HarnessMcpScope = Schema.Literals(["project", "global"]);

export const HarnessMcpDistributionPreviewInput = Schema.Struct({
  sourceResourceId: Schema.String,
  sourceScope: HarnessMcpScope,
  sourceProjectId: Schema.optional(Schema.String),
  targetProvider: HarnessMcpProvider,
  targetScope: HarnessMcpScope,
  targetProjectId: Schema.optional(Schema.String),
});

export const HarnessMcpDistributionPreviewResult = Schema.Struct({
  status: Schema.Literals(["ready", "unchanged", "unsupported", "conflict"]),
  previewId: Schema.optional(Schema.String),
  confirmationToken: Schema.optional(Schema.String),
  sourceName: Schema.optional(Schema.String),
  sourceProvider: Schema.optional(HarnessMcpProvider),
  targetProvider: HarnessMcpProvider,
  targetScope: HarnessMcpScope,
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
  connectionStatus: Schema.Literal("unknown"),
  reason: Schema.optional(Schema.String),
});

export const HarnessMcpDistributionApplyInput = Schema.Struct({
  previewId: Schema.String,
  confirmationToken: Schema.String,
  confirmed: Schema.Boolean,
});

export const HarnessMcpDistributionApplyResult = Schema.Struct({
  status: Schema.Literals(["distributed", "unchanged", "conflict", "unsupported"]),
  name: Schema.String,
  provider: HarnessMcpProvider,
  scope: HarnessMcpScope,
  configurationFingerprint: Schema.optional(Schema.String),
  connectionStatus: Schema.Literal("unknown"),
  reason: Schema.optional(Schema.String),
});

export type HarnessMcpDistributionPreviewInput = typeof HarnessMcpDistributionPreviewInput.Type;
export type HarnessMcpDistributionPreviewResult = typeof HarnessMcpDistributionPreviewResult.Type;
export type HarnessMcpDistributionApplyInput = typeof HarnessMcpDistributionApplyInput.Type;
export type HarnessMcpDistributionApplyResult = typeof HarnessMcpDistributionApplyResult.Type;

export const HarnessMcpDeployment = Schema.Struct({
  id: Schema.String,
  sourceResourceId: Schema.String,
  sourceScope: HarnessMcpScope,
  sourceProjectId: Schema.optional(Schema.String),
  targetProvider: Schema.Literals(["claude", "opencode"]),
  targetScope: HarnessMcpScope,
  targetProjectId: Schema.optional(Schema.String),
  serverName: Schema.String,
  configurationFingerprint: Schema.String,
  trackingOrigin: Schema.Literals(["adopted", "applied"]),
  trackedAt: Schema.String,
  updatedAt: Schema.String,
  drift: Schema.Literals(["synchronized", "drifted", "missing", "unknown"]),
});
export const HarnessMcpDeploymentList = Schema.Struct({
  deployments: Schema.Array(HarnessMcpDeployment),
});
export const HarnessMcpUntrackInput = Schema.Struct({ id: Schema.String });
