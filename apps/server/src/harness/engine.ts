import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { HarnessProposalOperation } from "@t3tools/contracts";
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
    | "recovered_workflow";
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
  `Analyze the supplied redacted project activity and existing skills. Suggest only durable, reusable skill changes supported by evidence. Compare existing skills first: prefer updates when appropriate, identify conflicts and duplicates, and avoid speculative proposals. Never infer secrets or include paths, credentials, personal data, or raw source excerpts. Return at most ${MAX_PROPOSALS} proposals. Confidence must be from 0 to 1. For create, contentDiff.before must be null and after must contain the full proposed skill content. For update or merge, before must be the current relevant content and after the complete replacement content. For archive, before must contain the current skill content and after must be null. Use sourceRefs exactly as provided by the input; evidence should be concise grounded observations. If nothing is sufficiently supported, return an empty proposals array.\n\nContext:\n${bounded(input.context, MAX_CONTEXT)}\n\nEvents:\n${JSON.stringify(
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
        proposals: generated.proposals.slice(0, MAX_PROPOSALS).map((proposal) => ({
          ...proposal,
          confidence: Math.max(0, Math.min(1, proposal.confidence)),
          targetSkillIds: [...new Set(proposal.targetSkillIds)],
          evidence: [...new Set(proposal.evidence)],
          sourceRefs: [...new Set(proposal.sourceRefs)].filter((ref) =>
            input.events.some((event) => event.sourceRefs.includes(ref)),
          ),
        })),
      } satisfies HarnessAnalysisResult;
    },
  );
  return HarnessEngine.of({ engineId: "native-v1", engineVersion: "1", analyze });
});

export const layer = Layer.effect(HarnessEngine, makeHarnessEngine);
