import * as Schema from "effect/Schema";
import { ModelSelection } from "./modelSelection.ts";

export const HarnessProposalOperation = Schema.Literals(["create", "update", "merge", "archive"]);
export type HarnessProposalOperation = typeof HarnessProposalOperation.Type;

export const HarnessProposalStatus = Schema.Literals([
  "pending",
  "approved",
  "rejected",
  "applying",
  "applied",
  "rolling_back",
]);
export type HarnessProposalStatus = typeof HarnessProposalStatus.Type;

export const HarnessProposalScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({ kind: Schema.Literal("project"), projectId: Schema.String }),
]);
export type HarnessProposalScope = typeof HarnessProposalScope.Type;

export const HarnessContentDiff = Schema.Struct({
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
});
export type HarnessContentDiff = typeof HarnessContentDiff.Type;

export const HarnessSkillChange = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("write"),
    id: Schema.String,
    name: Schema.String,
    content: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("archive"), id: Schema.String }),
]);
export type HarnessSkillChange = typeof HarnessSkillChange.Type;

export const HarnessSkillReceipt = Schema.Struct({
  target: Schema.String,
  previousContent: Schema.optional(Schema.String),
  previousPath: Schema.optional(Schema.String),
  appliedHash: Schema.optional(Schema.String),
  archivedTo: Schema.optional(Schema.String),
  transactionId: Schema.optional(Schema.String),
  archivedSources: Schema.optional(
    Schema.Array(
      Schema.Struct({
        target: Schema.String,
        archivedTo: Schema.String,
        contentHash: Schema.String,
      }),
    ),
  ),
  change: HarnessSkillChange,
});
export type HarnessSkillReceipt = typeof HarnessSkillReceipt.Type;

export const HarnessSkillSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  scope: Schema.Literals(["project", "user", "external", "harness"]),
  managed: Schema.Boolean,
});
export type HarnessSkillSummary = typeof HarnessSkillSummary.Type;

export const HarnessSkillInventory = Schema.Struct({ skills: Schema.Array(HarnessSkillSummary) });
export type HarnessSkillInventory = typeof HarnessSkillInventory.Type;
export const HarnessInventoryListInput = Schema.Struct({ scope: HarnessProposalScope });
export type HarnessInventoryListInput = typeof HarnessInventoryListInput.Type;
export const HarnessInventoryListResult = HarnessSkillInventory;
export type HarnessInventoryListResult = typeof HarnessInventoryListResult.Type;

export const HarnessAnalyzeInput = Schema.Struct({
  scope: HarnessProposalScope,
  context: Schema.optional(Schema.String.check(Schema.isMaxLength(12_000))),
});
export type HarnessAnalyzeInput = typeof HarnessAnalyzeInput.Type;

export const HarnessProposal = Schema.Struct({
  id: Schema.String,
  scope: HarnessProposalScope,
  operation: HarnessProposalOperation,
  skillName: Schema.String,
  targetSkillIds: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
  sourceRefs: Schema.Array(Schema.String),
  contentDiff: HarnessContentDiff,
  engineId: Schema.String,
  engineVersion: Schema.String,
  confidence: Schema.Number,
  rationale: Schema.String,
  status: HarnessProposalStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  decisionNote: Schema.NullOr(Schema.String),
  appliedAt: Schema.NullOr(Schema.String),
  appliedReceipt: Schema.NullOr(HarnessSkillReceipt),
});
export type HarnessProposal = typeof HarnessProposal.Type;

export const HarnessProposalCreateInput = Schema.Struct({
  scope: HarnessProposalScope,
  operation: HarnessProposalOperation,
  targetSkillIds: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
  sourceRefs: Schema.Array(Schema.String),
  contentDiff: HarnessContentDiff,
  engineId: Schema.String,
  engineVersion: Schema.String,
  confidence: Schema.Number,
  rationale: Schema.String,
  skillName: Schema.String,
});
export type HarnessProposalCreateInput = typeof HarnessProposalCreateInput.Type;

export const HarnessProposalListInput = Schema.Struct({
  scope: Schema.optional(HarnessProposalScope),
  status: Schema.optional(HarnessProposalStatus),
});
export type HarnessProposalListInput = typeof HarnessProposalListInput.Type;

export const HarnessProposalListResult = Schema.Struct({
  proposals: Schema.Array(HarnessProposal),
});
export type HarnessProposalListResult = typeof HarnessProposalListResult.Type;

export const HarnessDecisionInput = Schema.Struct({
  id: Schema.String,
  note: Schema.optional(Schema.String),
});
export type HarnessDecisionInput = typeof HarnessDecisionInput.Type;

export const HarnessDefaults = Schema.Struct({
  scope: HarnessProposalScope,
  enabled: Schema.Boolean,
  autoLearn: Schema.Boolean,
  engineId: Schema.String,
  modelSelection: Schema.NullOr(ModelSelection),
  dailyAnalysisBudget: Schema.Number,
  minimumConfidence: Schema.Number,
  updatedAt: Schema.String,
});
export type HarnessDefaults = typeof HarnessDefaults.Type;

export const HarnessDefaultsSetInput = Schema.Struct({
  scope: HarnessProposalScope,
  enabled: Schema.Boolean,
  autoLearn: Schema.Boolean,
  engineId: Schema.String,
  modelSelection: Schema.NullOr(ModelSelection),
  dailyAnalysisBudget: Schema.Number,
  minimumConfidence: Schema.Number,
});
export type HarnessDefaultsSetInput = typeof HarnessDefaultsSetInput.Type;

export const HarnessAnalysisBudget = Schema.Struct({
  scope: HarnessProposalScope,
  dayKey: Schema.String,
  dailyLimit: Schema.Number,
  used: Schema.Number,
  remaining: Schema.Number,
});
export type HarnessAnalysisBudget = typeof HarnessAnalysisBudget.Type;

export const HarnessAuditEntry = Schema.Struct({
  id: Schema.String,
  proposalId: Schema.String,
  action: Schema.Literals([
    "created",
    "approved",
    "rejected",
    "apply_started",
    "apply_recovered",
    "applied",
    "rollback_started",
    "rolled_back",
  ]),
  at: Schema.String,
  note: Schema.NullOr(Schema.String),
  proposalStatus: HarnessProposalStatus,
});
export type HarnessAuditEntry = typeof HarnessAuditEntry.Type;

export const HarnessAuditListInput = Schema.Struct({ proposalId: Schema.optional(Schema.String) });
export type HarnessAuditListInput = typeof HarnessAuditListInput.Type;

export const HarnessAuditListResult = Schema.Struct({ entries: Schema.Array(HarnessAuditEntry) });
export type HarnessAuditListResult = typeof HarnessAuditListResult.Type;

export const HarnessDefaultsGetInput = Schema.Struct({ scope: HarnessProposalScope });
export type HarnessDefaultsGetInput = typeof HarnessDefaultsGetInput.Type;

export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  message: Schema.String,
  proposalId: Schema.optional(Schema.String),
}) {}
