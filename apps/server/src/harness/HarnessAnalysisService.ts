import {
  HarnessError,
  ProjectId,
  type HarnessProposal,
  type HarnessProposalScope,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  isLiveSubagentShell,
  type OrchestrationV2ThreadShell,
  type PlotlineDag,
} from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as HarnessProposalService from "./HarnessProposalService.ts";
import * as HarnessSkillsService from "./HarnessSkillsService.ts";
import * as HarnessSignificantEvents from "./events.ts";
import * as HarnessEngine from "./engine.ts";

export interface HarnessAnalysisServiceShape {
  readonly analyze: (input: {
    readonly scope: HarnessProposalScope;
    readonly context?: string;
  }) => Effect.Effect<{ readonly proposals: ReadonlyArray<HarnessProposal> }, HarnessError>;
}

export class HarnessAnalysisService extends Context.Service<
  HarnessAnalysisService,
  HarnessAnalysisServiceShape
>()("t3/harness/HarnessAnalysisService") {}

export function isSafeAutomaticRootAnalysis(
  event: Pick<HarnessEngine.HarnessAnalysisEvent, "id" | "sourceRefs">,
  source: Pick<OrchestrationV2ThreadShell, "id" | "lineage">,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  dags: ReadonlyArray<PlotlineDag>,
): boolean {
  if (!/^(success|failure):/.test(event.id)) return false;
  const root = threads.find((thread) => thread.id === source.lineage.rootThreadId);
  if (
    !root ||
    root.id !== source.id ||
    root.lineage.parentThreadId !== null ||
    root.lineage.relationshipToParent !== null
  )
    return false;
  const terminalRunId = event.sourceRefs[1];
  if (
    !terminalRunId ||
    root.latestRunId !== terminalRunId ||
    root.activeRunId !== null ||
    root.activityRunStatus != null
  )
    return false;
  if (
    threads.some(
      (thread) =>
        thread.lineage.rootThreadId === root.id &&
        thread.lineage.relationshipToParent === "subagent" &&
        isLiveSubagentShell(thread as Parameters<typeof isLiveSubagentShell>[0]),
    )
  )
    return false;
  return !dags.some(
    (dag) =>
      dag.originatingThreadId === root.id && (dag.state === "running" || dag.state === "waiting"),
  );
}

export const makeHarnessAnalysisService = Effect.gen(function* () {
  const engine = yield* HarnessEngine.HarnessEngine;
  const events = yield* HarnessSignificantEvents.HarnessSignificantEventStore;
  const proposals = yield* HarnessProposalService.HarnessProposalService;
  const skillService = yield* HarnessSkillsService.HarnessSkillsService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const home = yield* HostProcess.HomeDirectory;

  interface CreatedProposalResult {
    readonly kind: "skipped";
  }
  interface PersistedProposalResult {
    readonly kind: "created";
    readonly value: HarnessProposal;
  }
  const analyzeScope = Effect.fn("HarnessAnalysisService.analyzeScope")(function* (
    scope: HarnessProposalScope,
    requestId?: string,
    automatic = false,
    userContext = "",
  ): Effect.fn.Return<
    { readonly proposals: ReadonlyArray<HarnessProposal>; readonly deferred?: boolean },
    HarnessError
  > {
    const defaults = yield* proposals.getDefaults(scope);
    if (!defaults.enabled || (automatic && !defaults.autoLearn)) {
      return { proposals: [] };
    }
    if (defaults.engineId !== engine.engineId) {
      return yield* new HarnessError({
        message: `Harness engine '${defaults.engineId}' is unavailable.`,
      });
    }

    let cwd = home;
    let threadIds: ReadonlySet<string> | undefined;
    if (scope.kind === "project") {
      const projectResult = yield* projects
        .getById(ProjectId.make(scope.projectId))
        .pipe(
          Effect.mapError(() => new HarnessError({ message: "Could not resolve the project." })),
        );
      const project = Option.getOrUndefined(projectResult);
      if (!project) return yield* new HarnessError({ message: "Project was not found." });
      cwd = project.workspaceRoot;
      const projectThreads = yield* threads
        .listProjectThreads({ projectId: ProjectId.make(scope.projectId), includeSubagents: true })
        .pipe(
          Effect.mapError(() => new HarnessError({ message: "Could not read project threads." })),
        );
      threadIds = new Set(projectThreads.map((thread) => thread.id));
    }

    const scopedEvents = events
      .snapshot()
      .filter(
        (event) =>
          threadIds === undefined ||
          (scope.kind === "project" && event.projectId === scope.projectId) ||
          (event.threadId !== undefined && threadIds.has(event.threadId)),
      );
    if (scopedEvents.length === 0 && userContext.trim().length === 0) return { proposals: [] };

    const today = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now)).slice(0, 10);
    const budget = yield* proposals.consumeAnalysisBudget(
      scope,
      defaults.dailyAnalysisBudget,
      today,
      requestId,
    );
    if (!budget.allowed || !budget.shouldRun)
      return { proposals: [], deferred: automatic && !budget.allowed };

    const allSkills = yield* skillService.discover(scope);
    const serverSettings = yield* settings.getSettings.pipe(
      Effect.mapError(() => new HarnessError({ message: "Could not read provider settings." })),
    );
    const selectedModel: ModelSelection =
      defaults.modelSelection ?? serverSettings.textGenerationModelSelection;
    const generated = yield* engine
      .analyze({
        cwd,
        scope,
        modelSelection: selectedModel,
        context: `${scope.kind === "global" ? "User-wide skill analysis." : "Project skill analysis."}\n${redactSensitive(userContext)?.slice(0, 4_000) ?? ""}`,
        events: scopedEvents,
        skills: allSkills.map((skill) => ({
          id: skill.id,
          title: skill.name,
          description: redactSensitive(skill.description ?? "") ?? "",
          // External skill bodies remain private until a separate consent mechanism is enabled.
          content: skill.managed ? safeSkillContent(skill.content) : "",
        })),
      })
      .pipe(
        Effect.mapError(
          () =>
            new HarnessError({
              message: "Harness could not complete analysis with the selected provider.",
            }),
        ),
      );

    const existing = (yield* proposals.list({ scope })).proposals;
    const existingKeys = new Set(
      existing.map(
        (proposal) =>
          `${proposal.operation}:${[...proposal.targetSkillIds].sort().join(",")}:${[...proposal.sourceRefs].sort().join(",")}`,
      ),
    );
    const skillById = new Map(allSkills.map((skill) => [skill.id, skill]));
    const eligibleProposals = generated.proposals
      .filter((proposal) => proposal.confidence >= defaults.minimumConfidence)
      .filter((proposal) => {
        if (proposal.target.resourceType !== "skill") return proposal.targetSkillIds.length === 0;
        if (proposal.operation === "create") return proposal.targetSkillIds.length === 0;
        if (proposal.operation === "merge") {
          return (
            proposal.targetSkillIds.length > 1 &&
            proposal.targetSkillIds.every((id) => {
              const skill = skillById.get(id);
              return skill !== undefined && skill.managed;
            })
          );
        }
        if (proposal.targetSkillIds.length !== 1) return false;
        const skill = skillById.get(proposal.targetSkillIds[0]!);
        return skill !== undefined && skill.managed;
      })
      .filter((proposal) => {
        const key = `${proposal.operation}:${[...proposal.targetSkillIds].sort().join(",")}:${[...proposal.sourceRefs].sort().join(",")}`;
        return !existingKeys.has(key);
      });
    const createOne = (
      proposal: HarnessEngine.HarnessAnalysisProposal,
    ): Effect.Effect<CreatedProposalResult | PersistedProposalResult, HarnessError> => {
      const targets = proposal.targetSkillIds.flatMap((id) =>
        skillById.has(id) ? [skillById.get(id)!] : [],
      );
      const target = targets[0];
      if (proposal.target.resourceType !== "skill") {
        return proposals
          .create({
            scope,
            operation: proposal.operation,
            targetSkillIds: [],
            skillName: safeSkillName(proposal.skillName) ?? "recommendation",
            evidence: proposal.evidence
              .map(redactSensitive)
              .filter((value): value is string => value !== null)
              .slice(0, 12),
            sourceRefs: proposal.sourceRefs.slice(0, 32),
            contentDiff: { before: null, after: null },
            engineId: generated.engineId,
            engineVersion: generated.engineVersion,
            confidence: proposal.confidence,
            rationale: redactSensitive(proposal.rationale) ?? "Supported by project evidence.",
            target: {
              ...proposal.target,
              scope,
              operation: proposal.operation,
              expectedModification:
                redactSensitive(proposal.target.expectedModification) ??
                "Review the recommendation.",
              validationCriteria: proposal.target.validationCriteria
                .map(redactSensitive)
                .filter((value): value is string => value !== null)
                .slice(0, 8),
            },
            ...(requestId === undefined
              ? {}
              : {
                  idempotencyKey: `auto:${requestId}:${proposal.operation}:${proposal.target.resourceType}:${proposal.sourceRefs.join(",")}`,
                }),
          })
          .pipe(Effect.map((value) => ({ kind: "created" as const, value })));
      }
      const after = redactSensitive(proposal.contentDiff.after);
      const before =
        proposal.operation === "create"
          ? null
          : proposal.operation === "merge"
            ? targets
                .map((item) => `# ${item.name}\n${safeSkillContent(item.content)}`)
                .join("\n\n")
            : target
              ? safeSkillContent(target.content)
              : null;
      const skillName =
        proposal.operation === "create"
          ? safeSkillName(proposal.skillName)
          : (target?.name ?? safeSkillName(proposal.skillName));
      if (
        !skillName ||
        (proposal.operation === "create" && after === null) ||
        (proposal.operation !== "archive" && after === null)
      ) {
        return Effect.succeed({ kind: "skipped" as const });
      }
      const contentDiff =
        proposal.operation === "archive" ? { before, after: null } : { before, after };
      return proposals
        .create({
          scope,
          operation: proposal.operation,
          targetSkillIds: proposal.targetSkillIds,
          skillName,
          evidence: proposal.evidence
            .map(redactSensitive)
            .filter((value): value is string => value !== null)
            .slice(0, 12),
          sourceRefs: proposal.sourceRefs.slice(0, 32),
          contentDiff,
          engineId: generated.engineId,
          engineVersion: generated.engineVersion,
          confidence: proposal.confidence,
          rationale:
            redactSensitive(proposal.rationale) ?? "Supported by repeated project evidence.",
          target: {
            ...proposal.target,
            scope,
            operation: proposal.operation,
            expectedModification:
              redactSensitive(proposal.target.expectedModification) ??
              "Review the proposed skill change.",
            validationCriteria: proposal.target.validationCriteria
              .map(redactSensitive)
              .filter((value): value is string => value !== null)
              .slice(0, 8),
          },
          ...(requestId === undefined
            ? {}
            : {
                idempotencyKey: `auto:${requestId}:${proposal.operation}:${proposal.targetSkillIds.join(",")}:${proposal.sourceRefs.join(",")}`,
              }),
        })
        .pipe(Effect.map((value) => ({ kind: "created" as const, value })));
    };
    const created = yield* Effect.forEach(eligibleProposals, createOne, { concurrency: 1 });
    if (requestId !== undefined) yield* proposals.completeAnalysisAttempt(scope, requestId);
    return {
      proposals: created.flatMap((result) => (result.kind === "created" ? [result.value] : [])),
    };
  });

  const analyze: HarnessAnalysisServiceShape["analyze"] = ({ scope, context }) =>
    analyzeScope(scope, undefined, false, context);

  const processAutomaticEvent = Effect.fn("HarnessAnalysisService.processAutomaticEvent")(
    function* (event: HarnessEngine.HarnessAnalysisEvent) {
      const projectShells = yield* projects.listShells();
      // Only terminal root runs create durable candidates. Child and DAG signals below
      // are wakeups only and cannot independently cause inference.
      if (/^(success|failure):/.test(event.id) && event.threadId && event.sourceRefs[1]) {
        let terminalThread: OrchestrationV2ThreadShell | undefined;
        for (const project of projectShells) {
          const projectThreads = yield* threads.listProjectThreads({
            projectId: project.id,
            includeSubagents: true,
          });
          terminalThread = projectThreads.find((thread) => thread.id === event.threadId);
          if (terminalThread) break;
        }
        if (
          !terminalThread ||
          (terminalThread.lineage.rootThreadId === terminalThread.id &&
            terminalThread.lineage.parentThreadId === null)
        )
          yield* events.enqueueRootCandidate({
            eventId: event.id,
            projectId: event.projectId ?? null,
            rootThreadId: event.threadId,
            runId: event.sourceRefs[1],
            event,
            at: event.at,
          });
      }
      const candidates = yield* events.pendingRootCandidates();
      const evaluatedRootRuns = new Set<string>();
      for (const candidate of candidates) {
        const evaluateCandidate = Effect.gen(function* () {
          let project = candidate.projectId
            ? (projectShells.find((item) => item.id === candidate.projectId) ?? null)
            : null;
          if (!project) {
            for (const item of projectShells) {
              const projectThreads = yield* threads.listProjectThreads({
                projectId: item.id,
                includeSubagents: true,
              });
              if (projectThreads.some((thread) => thread.id === candidate.rootThreadId)) {
                project = item;
                break;
              }
            }
          }
          if (!project) {
            yield* events.failRootCandidate(
              candidate.eventId,
              "Project or thread projection is temporarily unavailable.",
            );
            return;
          }
          const projectThreads = yield* threads.listProjectThreads({
            projectId: project.id,
            includeSubagents: true,
          });
          const root = projectThreads.find((thread) => thread.id === candidate.rootThreadId);
          if (!root) {
            yield* events.failRootCandidate(
              candidate.eventId,
              "Root thread projection is temporarily unavailable.",
            );
            return;
          }
          if (root.lineage.rootThreadId !== root.id || root.lineage.parentThreadId !== null) {
            yield* events.completeRootCandidate(candidate.eventId);
            return;
          }
          const significantEvent = candidate.event;
          // Multiple terminal events can remain pending while work is blocked. Only
          // the candidate for the root's latest run owns analysis for that turn.
          if (root.latestRunId !== candidate.runId) {
            yield* events.completeRootCandidate(candidate.eventId);
            return;
          }
          const rootRunKey = `${root.id}:${root.latestRunId}`;
          if (evaluatedRootRuns.has(rootRunKey)) {
            yield* events.completeRootCandidate(candidate.eventId);
            return;
          }
          const dags = yield* events.listPlotlineDags(project.id);
          if (!isSafeAutomaticRootAnalysis(significantEvent, root, projectThreads, dags)) return;
          evaluatedRootRuns.add(rootRunKey);
          const outcome = yield* analyzeScope(
            { kind: "project", projectId: project.id },
            candidate.eventId,
            true,
          );
          if (!outcome.deferred) yield* events.completeRootCandidate(candidate.eventId);
        });
        const outcome = yield* Effect.result(evaluateCandidate);
        if (outcome._tag === "Failure")
          yield* events.failRootCandidate(candidate.eventId, "Root candidate evaluation failed.");
      }
    },
  );

  const deliverAutomaticEvent = (event: HarnessEngine.HarnessAnalysisEvent) =>
    processAutomaticEvent(event).pipe(
      Effect.tap(() => (event.id === "wake:startup" ? Effect.void : events.acknowledge(event.id))),
      Effect.catchCause((cause) =>
        (event.id === "wake:startup" ? Effect.succeed(false) : events.recordFailure(event.id)).pipe(
          Effect.flatMap((terminal) =>
            terminal
              ? Effect.logWarning("Automatic Harness event reached its retry limit.", {
                  eventId: event.id,
                  cause,
                })
              : Effect.failCause(cause),
          ),
        ),
      ),
    );

  const startupWake: HarnessEngine.HarnessAnalysisEvent = {
    id: "wake:startup",
    at: "",
    type: "recovered_workflow",
    summary: "Recheck durable root analysis candidates.",
    evidence: [],
    sourceRefs: [],
  };
  yield* Effect.suspend(() =>
    Stream.concat(Stream.fromIterable([startupWake]), events.stream).pipe(
      Stream.runForEach(deliverAutomaticEvent),
    ),
  ).pipe(
    Effect.tapCause((cause) =>
      Effect.logWarning("Automatic Harness event delivery stopped; retrying.", { cause }),
    ),
    Effect.retry({ schedule: Schedule.exponential("1 second") }),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return HarnessAnalysisService.of({ analyze });
});

export const layer = Layer.effect(HarnessAnalysisService, makeHarnessAnalysisService);

const secretPattern =
  /\b(Bearer\s+[A-Za-z0-9._~+/-]+=*|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/gi;
const pathPattern = /(?:\/Users\/[^\s]+|\/home\/[^\s]+|[A-Z]:\\Users\\[^\s]+)/g;
const MAX_SKILL_CONTENT = 8_000;

function redactSensitive(value: string | null): string | null {
  return value?.replace(secretPattern, "[redacted]").replace(pathPattern, "[path]") ?? null;
}

function safeSkillContent(value: string): string {
  return redactSensitive(value.slice(0, MAX_SKILL_CONTENT)) ?? "";
}

function safeSkillName(value: string): string | undefined {
  const normalized = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 && normalized.length <= 64 ? normalized : undefined;
}
