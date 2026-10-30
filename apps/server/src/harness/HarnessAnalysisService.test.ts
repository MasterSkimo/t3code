import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { OrchestrationV2ThreadShell, PlotlineDag } from "@t3tools/contracts";

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

const rootThread = {
  id: "thread:root",
  latestRunId: "run:1",
  activeRunId: null,
  activityRunStatus: null,
  lineage: { rootThreadId: "thread:root", parentThreadId: null, relationshipToParent: null },
  status: "idle",
  pendingRuntimeRequest: null,
};
const projected = (...threads: ReadonlyArray<unknown>) =>
  threads as ReadonlyArray<OrchestrationV2ThreadShell>;

it("permits automatic analysis only for a safe terminal root run", () => {
  const safe = Analysis.isSafeAutomaticRootAnalysis(
    { id: "success:run-event", sourceRefs: ["event", "run:1"] },
    rootThread as unknown as OrchestrationV2ThreadShell,
    projected(rootThread),
    [],
  );
  assert.isTrue(safe);
  assert.isFalse(
    Analysis.isSafeAutomaticRootAnalysis(
      { id: "feedback:message", sourceRefs: ["event", "run:1"] },
      rootThread as unknown as OrchestrationV2ThreadShell,
      projected({ ...rootThread, latestRunId: "run:2" }),
      [],
    ),
  );
  assert.isFalse(
    Analysis.isSafeAutomaticRootAnalysis(
      { id: "plotline:dag:task", sourceRefs: ["event", "run:1"] },
      rootThread as unknown as OrchestrationV2ThreadShell,
      projected({ ...rootThread, activeRunId: "run:2", activityRunStatus: "running" }),
      [],
    ),
  );
});

it("fails closed for child runs, active descendants, and associated active DAGs", () => {
  const child = {
    ...rootThread,
    id: "thread:child",
    lineage: {
      rootThreadId: "thread:root",
      parentThreadId: "thread:root",
      relationshipToParent: "subagent",
    },
    status: "running",
  };
  assert.isFalse(
    Analysis.isSafeAutomaticRootAnalysis(
      { id: "success:child-run", sourceRefs: ["event", "run:1"] },
      child as unknown as OrchestrationV2ThreadShell,
      projected(rootThread, child),
      [],
    ),
  );
  assert.isFalse(
    Analysis.isSafeAutomaticRootAnalysis(
      { id: "success:root-run", sourceRefs: ["event", "run:1"] },
      rootThread as unknown as OrchestrationV2ThreadShell,
      projected(rootThread, child),
      [],
    ),
  );
  assert.isFalse(
    Analysis.isSafeAutomaticRootAnalysis(
      { id: "failure:root-run", sourceRefs: ["event", "run:1"] },
      rootThread as unknown as OrchestrationV2ThreadShell,
      projected(rootThread),
      [
        {
          originatingThreadId: ThreadId.make("thread:root"),
          state: "waiting",
        } as unknown as PlotlineDag,
      ],
    ),
  );
});

it("keeps a root candidate unsafe until its child and associated DAG settle", () => {
  const child = {
    ...rootThread,
    id: "thread:child",
    lineage: {
      rootThreadId: "thread:root",
      parentThreadId: "thread:root",
      relationshipToParent: "subagent",
    },
    status: "running",
  };
  const terminalRootEvent = { id: "success:root-run", sourceRefs: ["event", "run:1"] };
  assert.isFalse(
    Analysis.isSafeAutomaticRootAnalysis(
      terminalRootEvent,
      rootThread as unknown as OrchestrationV2ThreadShell,
      projected(rootThread, child),
      [],
    ),
  );
  const settledChild = { ...child, status: "idle" };
  const waitingDag = {
    originatingThreadId: ThreadId.make("thread:root"),
    state: "waiting",
  } as unknown as PlotlineDag;
  assert.isFalse(
    Analysis.isSafeAutomaticRootAnalysis(
      terminalRootEvent,
      rootThread as unknown as OrchestrationV2ThreadShell,
      projected(rootThread, settledChild),
      [waitingDag],
    ),
  );
  assert.isTrue(
    Analysis.isSafeAutomaticRootAnalysis(
      terminalRootEvent,
      rootThread as unknown as OrchestrationV2ThreadShell,
      projected(rootThread, settledChild),
      [{ ...waitingDag, state: "done" }],
    ),
  );
});

it("ignores active descendants from unrelated roots", () => {
  const unrelated = {
    ...rootThread,
    id: "thread:other-child",
    status: "running",
    lineage: {
      rootThreadId: "thread:other-root",
      parentThreadId: "thread:other-root",
      relationshipToParent: "subagent",
    },
  };
  assert.isTrue(
    Analysis.isSafeAutomaticRootAnalysis(
      { id: "success:root-run", sourceRefs: ["event", "run:1"] },
      rootThread as unknown as OrchestrationV2ThreadShell,
      projected(rootThread, unrelated),
      [],
    ),
  );
});

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
        listPlotlineDags: () => Effect.succeed([]),
        enqueueRootCandidate: () => Effect.void,
        pendingRootCandidates: () => Effect.succeed([]),
        completeRootCandidate: () => Effect.void,
        failRootCandidate: () => Effect.void,
        reconcileCorrectionChild: () => Effect.void,
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

it.effect(
  "delivers terminal events automatically and waits for active children before analysis",
  () =>
    Effect.gen(function* () {
      const eventQueue = yield* Queue.unbounded<Engine.HarnessAnalysisEvent>();
      const rootAcknowledged = yield* Deferred.make<void>();
      const childAcknowledged = yield* Deferred.make<void>();
      const engineCalled = yield* Deferred.make<void>();
      let engineCalls = 0;
      let budgetCalls = 0;
      const enqueuedCandidateIds: Array<string> = [];
      const candidates = new Map<string, { event: Engine.HarnessAnalysisEvent; runId: string }>();
      let projection = projected(
        rootThread as unknown as OrchestrationV2ThreadShell,
        {
          ...rootThread,
          id: "thread:child",
          status: "running",
          lineage: {
            rootThreadId: "thread:root",
            parentThreadId: "thread:root",
            relationshipToParent: "subagent",
          },
        } as unknown as OrchestrationV2ThreadShell,
      );
      const rootEvent = {
        ...baseEvent,
        id: "success:root-run",
        threadId: "thread:root",
        projectId: "project:1",
        sourceRefs: ["event:root", "run:1"],
      };
      const childEvent = {
        ...baseEvent,
        id: "success:child-run",
        threadId: "thread:child",
        projectId: "project:1",
        sourceRefs: ["event:child", "run:child"],
      };
      yield* Analysis.makeHarnessAnalysisService.pipe(
        Effect.provideService(Engine.HarnessEngine, {
          engineId: "test-engine",
          engineVersion: "test",
          analyze: () => {
            engineCalls += 1;
            return Deferred.succeed(engineCalled, undefined).pipe(
              Effect.as({ engineId: "test-engine", engineVersion: "test", proposals: [] }),
            );
          },
        }),
        Effect.provideService(EventStore.HarnessSignificantEventStore, {
          snapshot: () => [rootEvent],
          stream: Stream.fromQueue(eventQueue),
          acknowledge: (id: string) =>
            id === rootEvent.id
              ? Deferred.succeed(rootAcknowledged, undefined)
              : Deferred.succeed(childAcknowledged, undefined),
          recordFailure: () => Effect.succeed(false),
          listPlotlineDags: () => Effect.succeed([]),
          enqueueRootCandidate: (input: {
            eventId: string;
            runId: string;
            event: Engine.HarnessAnalysisEvent;
          }) =>
            Effect.sync(() => {
              enqueuedCandidateIds.push(input.eventId);
              candidates.set(input.eventId, input);
            }),
          pendingRootCandidates: () =>
            Effect.sync(() =>
              [...candidates].map(([eventId, value]) => ({
                eventId,
                projectId: "project:1",
                rootThreadId: "thread:root",
                runId: value.runId,
                event: value.event,
                deliveryAttempts: 0,
              })),
            ),
          completeRootCandidate: (id: string) =>
            Effect.sync(() => {
              candidates.delete(id);
            }),
          failRootCandidate: (id: string) =>
            Effect.sync(() => {
              candidates.delete(id);
            }),
        } as unknown as EventStore.HarnessSignificantEventStore["Service"]),
        Effect.provideService(ProposalStore.HarnessProposalService, {
          getDefaults: () =>
            Effect.succeed({
              scope: { kind: "global" as const },
              enabled: true,
              autoLearn: true,
              engineId: "test-engine",
              modelSelection: null,
              dailyAnalysisBudget: 5,
              minimumConfidence: 0.75,
              updatedAt: "",
            }),
          consumeAnalysisBudget: () => {
            budgetCalls += 1;
            return Effect.succeed({ allowed: true, isNew: true, shouldRun: true });
          },
          completeAnalysisAttempt: () => Effect.void,
          list: () => Effect.succeed({ proposals: [] }),
          create: () => Effect.die("unexpected proposal"),
        } as unknown as ProposalStore.HarnessProposalService["Service"]),
        Effect.provideService(SkillsService.HarnessSkillsService, {
          discover: () => Effect.succeed([]),
        } as unknown as SkillsService.HarnessSkillsService["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          listShells: () => Effect.succeed([{ id: "project:1" }]),
          getById: () => Effect.succeedSome({ workspaceRoot: "/home/test" }),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ThreadManagementService.ThreadManagementService, {
          listProjectThreads: () => Effect.sync(() => projection),
        } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
        Effect.provideService(ServerSettings.ServerSettingsService, {
          getSettings: Effect.succeed({
            textGenerationModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5",
            },
          }),
        } as unknown as ServerSettings.ServerSettingsService["Service"]),
        Effect.provideService(HostProcess.HomeDirectory, "/home/test"),
      );
      yield* Queue.offer(eventQueue, rootEvent);
      yield* Deferred.await(rootAcknowledged);
      assert.strictEqual(engineCalls, 0);
      assert.strictEqual(budgetCalls, 0);
      assert.isTrue(candidates.has(rootEvent.id));

      projection = projected(
        rootThread as unknown as OrchestrationV2ThreadShell,
        {
          ...projection[1]!,
          status: "idle",
        } as unknown as OrchestrationV2ThreadShell,
      );
      yield* Queue.offer(eventQueue, childEvent);
      yield* Deferred.await(engineCalled);
      yield* Deferred.await(childAcknowledged);
      assert.strictEqual(engineCalls, 1);
      assert.strictEqual(budgetCalls, 1);
      assert.deepStrictEqual(enqueuedCandidateIds, [rootEvent.id]);
      assert.isFalse(candidates.has(rootEvent.id));
      assert.isFalse(candidates.has(childEvent.id));
    }),
);

it("rejects a terminal candidate after a newer root run starts or becomes current", () => {
  assert.isFalse(
    Analysis.isSafeAutomaticRootAnalysis(
      { id: "success:old-run", sourceRefs: ["event", "run:1"] },
      { ...rootThread, latestRunId: "run:2" } as unknown as OrchestrationV2ThreadShell,
      projected({ ...rootThread, latestRunId: "run:2" }),
      [],
    ),
  );
  assert.isFalse(
    Analysis.isSafeAutomaticRootAnalysis(
      { id: "success:run", sourceRefs: ["event", "run:1"] },
      {
        ...rootThread,
        activeRunId: "run:2",
        activityRunStatus: "running",
      } as unknown as OrchestrationV2ThreadShell,
      projected({ ...rootThread, activeRunId: "run:2", activityRunStatus: "running" }),
      [],
    ),
  );
});

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
