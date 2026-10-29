import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ProviderInstanceId } from "@t3tools/contracts";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProposalStore from "./HarnessProposalService.ts";
import * as SkillsService from "./HarnessSkillsService.ts";
import * as EventStore from "./events.ts";
import * as Engine from "./engine.ts";
import * as Analysis from "./HarnessAnalysisService.ts";

const baseEvent: Engine.HarnessAnalysisEvent = {
  id: "signal:1",
  threadId: "thread:1",
  at: "2026-10-27T00:00:00.000Z",
  type: "repeated_workflow",
  summary: "A review workflow repeated.",
  evidence: ["Review checklist repeated."],
  sourceRefs: ["event:1"],
};

const runAnalysis = (options: {
  readonly enabled?: boolean;
  readonly allowed?: boolean;
  readonly engineId?: string;
  readonly engineFailure?: boolean;
  readonly noEvents?: boolean;
  readonly resourceType?:
    | "skill"
    | "instructions"
    | "rules"
    | "hooks"
    | "mcp_recommendation"
    | "orchestration_practice";
}) =>
  Effect.gen(function* () {
    let engineCalls = 0;
    let budgetCalls = 0;
    let createCalls = 0;
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    const service = yield* Analysis.makeHarnessAnalysisService.pipe(
      Effect.provideService(Engine.HarnessEngine, {
        engineId: options.engineId ?? "test-engine",
        engineVersion: "test",
        analyze: () => {
          engineCalls += 1;
          return options.engineFailure
            ? Effect.fail(new Engine.HarnessEngineError({ message: "inference failed" }))
            : Effect.succeed({
                engineId: options.engineId ?? "test-engine",
                engineVersion: "test",
                proposals: [
                  {
                    operation: "create",
                    skillName: "Review Helper",
                    targetSkillIds: [],
                    evidence: ["Repeated checklist"],
                    sourceRefs: ["event:1"],
                    contentDiff: { before: null, after: "---\nname: review-helper\n---\nReview" },
                    confidence: 0.9,
                    rationale: "The same review workflow recurs.",
                    target: {
                      resourceType: options.resourceType ?? "skill",
                      scope: { kind: "global" },
                      operation: "create",
                      expectedModification: "Add a shared review checklist recommendation.",
                      validationCriteria: ["The checklist is provider independent."],
                    },
                  },
                ],
              });
        },
      }),
      Effect.provideService(EventStore.HarnessSignificantEventStore, {
        snapshot: () => (options.noEvents ? [] : [baseEvent]),
        stream: Stream.empty,
        acknowledge: () => Effect.void,
        recordFailure: () => Effect.succeed(false),
      }),
      Effect.provideService(ProposalStore.HarnessProposalService, {
        getDefaults: () =>
          Effect.succeed({
            scope: { kind: "global" as const },
            enabled: options.enabled ?? true,
            autoLearn: true,
            engineId: "test-engine",
            modelSelection: null,
            dailyAnalysisBudget: 5,
            minimumConfidence: 0.75,
            updatedAt: "",
          }),
        consumeAnalysisBudget: () => {
          budgetCalls += 1;
          return Effect.succeed({
            allowed: options.allowed ?? true,
            isNew: options.allowed ?? true,
            shouldRun: options.allowed ?? true,
          });
        },
        completeAnalysisAttempt: () => Effect.void,
        list: () => Effect.succeed({ proposals: [] }),
        create: (
          input: Parameters<ProposalStore.HarnessProposalService["Service"]["create"]>[0],
        ) => {
          createCalls += 1;
          return Effect.succeed({
            ...input,
            id: `proposal:${createCalls}`,
            status: "pending" as const,
            createdAt: "2026-10-27T00:00:00.000Z",
            updatedAt: "2026-10-27T00:00:00.000Z",
            decidedAt: null,
            decisionNote: null,
            appliedAt: null,
            appliedReceipt: null,
          });
        },
      } as unknown as ProposalStore.HarnessProposalService["Service"]),
      Effect.provideService(SkillsService.HarnessSkillsService, {
        discover: () => Effect.succeed([]),
      } as unknown as SkillsService.HarnessSkillsService["Service"]),
      Effect.provideService(
        ProjectService.ProjectService,
        {} as ProjectService.ProjectService["Service"],
      ),
      Effect.provideService(
        ThreadManagementService.ThreadManagementService,
        {} as ThreadManagementService.ThreadManagementService["Service"],
      ),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        getSettings: Effect.succeed({ textGenerationModelSelection: modelSelection }),
      } as unknown as ServerSettings.ServerSettingsService["Service"]),
      Effect.provideService(HostProcess.HomeDirectory, "/home/test"),
    );
    const result = yield* Effect.result(
      service.analyze({
        scope: { kind: "global" },
        ...(options.noEvents ? { context: "Create a skill for the release checklist." } : {}),
      }),
    );
    return { result, engineCalls, budgetCalls, createCalls };
  });

it.effect("uses a substituted engine and persists safe proposals", () =>
  runAnalysis({}).pipe(
    Effect.tap(({ result, engineCalls, budgetCalls, createCalls }) =>
      Effect.sync(() => {
        assert.isTrue(result._tag === "Success");
        if (result._tag === "Success") assert.strictEqual(result.success.proposals.length, 1);
        assert.strictEqual(engineCalls, 1);
        assert.strictEqual(budgetCalls, 1);
        assert.strictEqual(createCalls, 1);
      }),
    ),
  ),
);

it.effect("does not infer while disabled or when the analysis budget is exhausted", () =>
  Effect.gen(function* () {
    const disabled = yield* runAnalysis({ enabled: false });
    assert.strictEqual(disabled.engineCalls, 0);
    assert.strictEqual(disabled.budgetCalls, 0);
    const exhausted = yield* runAnalysis({ allowed: false });
    assert.strictEqual(exhausted.engineCalls, 0);
    assert.strictEqual(exhausted.createCalls, 0);
  }),
);

it.effect("maps unavailable model inference into a Harness error without creating proposals", () =>
  runAnalysis({ engineFailure: true }).pipe(
    Effect.tap(({ result, createCalls }) =>
      Effect.sync(() => {
        assert.isTrue(result._tag === "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "HarnessError");
        assert.strictEqual(createCalls, 0);
      }),
    ),
  ),
);

it.effect("allows manual analysis from user context when the event history is empty", () =>
  runAnalysis({ noEvents: true }).pipe(
    Effect.tap(({ result, engineCalls }) =>
      Effect.sync(() => {
        assert.strictEqual(result._tag, "Success");
        assert.strictEqual(engineCalls, 1);
      }),
    ),
  ),
);

it.effect(
  "persists provider-independent MCP recommendations without claiming discovered resources",
  () =>
    runAnalysis({ resourceType: "mcp_recommendation" }).pipe(
      Effect.tap(({ result, createCalls }) =>
        Effect.sync(() => {
          assert.strictEqual(result._tag, "Success");
          if (result._tag === "Success") {
            const proposal = result.success.proposals[0]!;
            assert.deepStrictEqual(proposal.target, {
              resourceType: "mcp_recommendation",
              scope: { kind: "global" },
              operation: "create",
              expectedModification: "Add a shared review checklist recommendation.",
              validationCriteria: ["The checklist is provider independent."],
            });
            assert.deepStrictEqual(proposal.contentDiff, { before: null, after: null });
          }
          assert.strictEqual(createCalls, 1);
        }),
      ),
    ),
);
