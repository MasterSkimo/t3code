import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  HarnessProposalOperation,
  HarnessProposalScope,
  HarnessProposalResourceType,
  HarnessProposalTarget,
} from "@t3tools/contracts";
import type { ModelSelection } from "@t3tools/contracts";

import * as TextGeneration from "../textGeneration/TextGeneration.ts";

export interface HarnessAnalysisEvent {
  readonly id: string;
  readonly threadId?: string;
  readonly projectId?: string;
  readonly at: string;
  readonly type:
    | "user_feedback"
    | "repeated_workflow"
    | "successful_output"
    | "validated_success"
    | "failure"
    | "recovered_workflow"
    | "loop_guard";
  readonly summary: string;
  readonly evidence: ReadonlyArray<string>;
  readonly sourceRefs: ReadonlyArray<string>;
}

export interface HarnessAnalysisSkill {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly content: string;
}

export interface HarnessAnalysisInput {
  readonly cwd: string;
  readonly scope: HarnessProposalScope;
  readonly modelSelection: ModelSelection;
  readonly context: string;
  readonly events: ReadonlyArray<HarnessAnalysisEvent>;
  readonly skills: ReadonlyArray<HarnessAnalysisSkill>;
}

export interface HarnessAnalysisProposal {
  readonly skillName: string;
  readonly operation: HarnessProposalOperation;
  readonly targetSkillIds: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<string>;
  readonly sourceRefs: ReadonlyArray<string>;
  readonly contentDiff: { readonly before: string | null; readonly after: string | null };
  readonly confidence: number;
  readonly rationale: string;
  readonly target: HarnessProposalTarget;
}

export interface HarnessAnalysisResult {
  readonly engineId: string;
  readonly engineVersion: string;
  readonly proposals: ReadonlyArray<HarnessAnalysisProposal>;
}

export class HarnessEngineError extends Schema.TaggedError<HarnessEngineError>()(
  "HarnessEngineError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const ProposalSchema = Schema.Struct({
  skillName: Schema.String,
  operation: Schema.Literals(["create", "update", "merge", "archive"]),
  targetSkillIds: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
  sourceRefs: Schema.Array(Schema.String),
  contentDiff: Schema.Struct({
    before: Schema.NullOr(Schema.String),
    after: Schema.NullOr(Schema.String),
  }),
  confidence: Schema.Number,
  rationale: Schema.String,
  target: Schema.optional(
    Schema.Struct({
      resourceType: Schema.optional(
        Schema.Literals([
          "skill",
          "instructions",
          "rules",
          "hooks",
          "mcp_recommendation",
          "orchestration_practice",
        ]),
      ),
      resourceId: Schema.optional(Schema.String),
      expectedModification: Schema.optional(Schema.String),
      validationCriteria: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});

const NativeAnalysisSchema = Schema.Struct({ proposals: Schema.Array(ProposalSchema) });

const MAX_EVENTS = 40;
const MAX_SKILLS = 100;
const MAX_EVENT_TEXT = 1_200;
const MAX_SKILL_CONTENT = 8_000;
const MAX_CONTEXT = 8_000;
const MAX_PROPOSALS = 12;

const bounded = (value: string, length: number) => value.slice(0, length);

const analysisPrompt = (input: HarnessAnalysisInput) =>
  `Analyze the supplied redacted project activity and available context. Suggest durable, reusable improvements supported by evidence. A target may be a skill, instructions, rules, hooks, an MCP recommendation, or an orchestration practice. Do not claim a resource was discovered unless it appears in supplied skills; proposals for other resource types may be recommendations and must not invent resource IDs. Compare supplied skills first: prefer updates when appropriate, identify conflicts and duplicates, and avoid speculative proposals. Never infer secrets or include paths, credentials, personal data, or raw source excerpts. Return at most ${MAX_PROPOSALS} proposals. Confidence must be from 0 to 1. Include a target with resourceType, expectedModification, and concrete validationCriteria; target scope is ${JSON.stringify(input.scope)} and operation should match operation. For skill proposals, create requires null before and complete after content; update or merge requires the current relevant before content and complete after content; archive requires current content before and null after. For non-skill recommendations, contentDiff may be null and expectedModification describes the recommendation. Use sourceRefs only from supplied events; evidence should be concise grounded observations. If nothing is sufficiently supported, return an empty proposals array.\n\nContext:\n${bounded(input.context, MAX_CONTEXT)}\n\nEvents:\n${JSON.stringify(
    input.events.slice(-MAX_EVENTS).map((event) => ({
      id: event.id,
      at: event.at,
      ...(event.threadId ? { threadId: event.threadId } : {}),
      ...(event.projectId ? { projectId: event.projectId } : {}),
      type: event.type,
      summary: bounded(event.summary, MAX_EVENT_TEXT),
      evidence: event.evidence.map((item) => bounded(item, MAX_EVENT_TEXT)).slice(0, 8),
      sourceRefs: event.sourceRefs.slice(0, 8),
    })),
  )}\n\nExisting skills:\n${JSON.stringify(
    input.skills.slice(0, MAX_SKILLS).map((skill) => ({
      id: skill.id,
      title: bounded(skill.title, 200),
      description: bounded(skill.description, 1_000),
      content: bounded(skill.content, MAX_SKILL_CONTENT),
    })),
  )}`;

export interface HarnessEngineService {
  readonly engineId: string;
  readonly engineVersion: string;
  readonly analyze: (
    input: HarnessAnalysisInput,
  ) => Effect.Effect<HarnessAnalysisResult, HarnessEngineError>;
}

export class HarnessEngine extends Context.Service<HarnessEngine, HarnessEngineService>()(
  "t3/harness/engine/HarnessEngine",
) {}

export const makeHarnessEngine = Effect.gen(function* () {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const analyze: HarnessEngineService["analyze"] = Effect.fn("HarnessEngine.analyze")(
    function* (input) {
      const generated = yield* textGeneration
        .generateStructuredOutput({
          cwd: input.cwd,
          modelSelection: input.modelSelection,
          prompt: analysisPrompt(input),
          outputSchema: NativeAnalysisSchema,
        })
        .pipe(
          Effect.mapError(
            () => new HarnessEngineError({ message: "Harness analysis inference failed." }),
          ),
        );
      return {
        engineId: "native-v1",
        engineVersion: "1",
        proposals: generated.proposals.slice(0, MAX_PROPOSALS).map((proposal) => {
          const resourceType: HarnessProposalResourceType =
            proposal.target?.resourceType ?? "skill";
          const expectedModification =
            proposal.target?.expectedModification ??
            (proposal.operation === "archive"
              ? `Archive ${proposal.skillName}.`
              : (proposal.contentDiff.after ??
                `Propose ${proposal.operation} for ${proposal.skillName}.`));
          const validationCriteria = proposal.target?.validationCriteria
            ?.map((criterion) => criterion.trim())
            .filter(Boolean)
            .slice(0, 8);
          const target: HarnessProposalTarget = {
            resourceType,
            scope: input.scope,
            operation: proposal.operation,
            ...(proposal.target?.resourceId
              ? { resourceId: proposal.target.resourceId }
              : proposal.operation !== "create" && proposal.targetSkillIds[0]
                ? { resourceId: proposal.targetSkillIds[0] }
                : {}),
            expectedModification,
            validationCriteria:
              validationCriteria && validationCriteria.length > 0
                ? validationCriteria
                : [
                    resourceType === "skill"
                      ? "Review the proposed skill content against the cited evidence."
                      : "Review the recommendation against the cited evidence before adopting it.",
                  ],
          };
          const availableSkillIds = new Set(input.skills.map((skill) => skill.id));
          return {
            ...proposal,
            target,
            confidence: Math.max(0, Math.min(1, proposal.confidence)),
            targetSkillIds:
              proposal.operation === "create"
                ? []
                : [...new Set(proposal.targetSkillIds)].filter((id) => availableSkillIds.has(id)),
            evidence: [...new Set(proposal.evidence)],
            sourceRefs: [...new Set(proposal.sourceRefs)].filter((ref) =>
              input.events.some((event) => event.sourceRefs.includes(ref)),
            ),
          };
        }),
      } satisfies HarnessAnalysisResult;
    },
  );
  return HarnessEngine.of({ engineId: "native-v1", engineVersion: "1", analyze });
});

export const layer = Layer.effect(HarnessEngine, makeHarnessEngine);
