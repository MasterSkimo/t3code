import {
  CommandId,
  HarnessError,
  PlotlineDagRecordVerificationInput,
  PlotlineVerifierRequest,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type PlotlineDag,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as PlotlineDagService from "../plotline/PlotlineDagService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { findPlotlineTaskRunMatches } from "./plotlineTaskTracking.ts";
import { classifySuccessfulRun, isCorrectionPrompt } from "./signalQuality.ts";
import { makeLoopGuardCollector, type LoopGuardIntervention } from "./loopGuard.ts";

const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(UnknownJsonString);
const encodeJson = Schema.encodeSync(UnknownJsonString);
const decodeVerifierRequest = Schema.decodeUnknownEffect(PlotlineVerifierRequest);
const decodeVerifierAttempt = Schema.decodeEffect(PlotlineDagRecordVerificationInput);
const VerifierEvidence = Schema.Struct({
  verdict: Schema.Literals(["pass", "fail", "inconclusive"]),
  summary: Schema.String,
  criterionResults: Schema.Array(
    Schema.Struct({
      criterionId: Schema.String,
      verdict: Schema.Literals(["pass", "fail", "inconclusive"]),
      evidence: Schema.String,
    }),
  ),
});
const decodeVerifierEvidence = Schema.decodeUnknownEffect(Schema.fromJsonString(VerifierEvidence));

export type HarnessSignificantEventType =
  | "user_feedback"
  | "repeated_workflow"
  | "successful_output"
  | "validated_success"
  | "failure"
  | "recovered_workflow"
  | "loop_guard";

export interface HarnessSignificantEvent {
  readonly id: string;
  readonly at: string;
  readonly threadId?: string;
  readonly projectId?: string;
  readonly type: HarnessSignificantEventType;
  readonly summary: string;
  readonly evidence: ReadonlyArray<string>;
  readonly sourceRefs: ReadonlyArray<string>;
  readonly loopGuard?: Pick<
    LoopGuardIntervention,
    "state" | "reason" | "observedCount" | "recommendation" | "recoveryAction" | "advisoryOnly"
  >;
}

const MAX_EVENTS = 100;
const MAX_DEDUPE_IDS = 1_000;
const MAX_DELIVERY_ATTEMPTS = 3;
const MAX_RETRY_DELAY_SECONDS = 300;
const REPLAY_CONTEXT_EVENTS = 500;
const MAX_EVIDENCE_CHARS = 1_000;

const bounded = (value: string): string => value.trim().slice(0, MAX_EVIDENCE_CHARS);

const redactEvidence = (value: string): string =>
  bounded(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[redacted]");

const normalizedText = (value: string): string =>
  value
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\p{P}\p{S}]/gu, "")
    .trim();

/** Collects provider-neutral signals from the committed orchestration event stream. */
export function collectSignificantEvents(
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
): ReadonlyArray<HarnessSignificantEvent> {
  const messagesByRun = new Map<
    string,
    Array<Extract<OrchestrationV2DomainEvent, { type: "message.updated" }>>
  >();
  const userPrompts = new Map<
    string,
    Array<Extract<OrchestrationV2DomainEvent, { type: "message.updated" }>>
  >();
  for (const event of events) {
    if (event.type !== "message.updated" || event.payload.workflowScript) continue;
    const message = event.payload;
    if (message.role === "assistant" && message.runId) {
      const messages = messagesByRun.get(message.runId) ?? [];
      messages.push(event);
      messagesByRun.set(message.runId, messages);
    }
    if (message.role === "user" && message.text.trim().length > 0) {
      const key = `${event.threadId}:${normalizedText(message.text)}`;
      if (!key) continue;
      const prompts = userPrompts.get(key) ?? [];
      prompts.push(event);
      userPrompts.set(key, prompts);
    }
  }

  const output: Array<HarnessSignificantEvent> = [];
  const emitted = new Set<string>();
  const add = (event: HarnessSignificantEvent) => {
    if (emitted.has(event.id)) return;
    emitted.add(event.id);
    output.push(event);
  };

  for (const event of events) {
    if (
      event.type === "message.updated" &&
      event.payload.role === "user" &&
      !event.payload.workflowScript
    ) {
      const text = event.payload.text.trim();
      const key = `${event.threadId}:${normalizedText(text)}`;
      const repeats = userPrompts.get(key) ?? [];
      if (isCorrectionPrompt(text)) {
        add({
          id: `feedback:${event.id}`,
          at: DateTime.formatIso(event.occurredAt),
          threadId: event.threadId,
          type: "user_feedback",
          summary: "The user corrected or redirected the agent.",
          evidence: [redactEvidence(text)],
          sourceRefs: [event.id, event.payload.id],
        });
      }
      if (repeats.length > 1 && repeats[0]?.id === event.id) {
        add({
          id: `repeat:${event.id}`,
          at: DateTime.formatIso(event.occurredAt),
          threadId: event.threadId,
          type: "repeated_workflow",
          summary: `The same user request appeared ${repeats.length} times.`,
          evidence: [redactEvidence(text)],
          sourceRefs: repeats.flatMap((item) => [item.id, item.payload.id]),
        });
      }
    }

    if (event.type === "run.updated" && event.payload.status === "failed") {
      add({
        id: `failure:${event.id}`,
        at: DateTime.formatIso(event.occurredAt),
        threadId: event.threadId,
        type: "failure",
        summary: "The agent run failed.",
        evidence: ["Run status: failed."],
        sourceRefs: [event.id, event.payload.id],
      });
    }

    if (event.type === "run.updated" && event.payload.status === "completed") {
      const messages = messagesByRun.get(event.payload.id) ?? [];
      const latest = messages.at(-1);
      add({
        id: `success:${event.id}`,
        at: DateTime.formatIso(event.occurredAt),
        threadId: event.threadId,
        type: "successful_output",
        summary: "The agent completed a run successfully.",
        evidence: [
          ...(latest?.payload.text.trim() ? [redactEvidence(latest.payload.text)] : []),
          "Run status: completed.",
        ],
        sourceRefs: [event.id, event.payload.id, ...(latest ? [latest.id, latest.payload.id] : [])],
      });
    }
  }

  return output.slice(-MAX_EVENTS);
}

export interface SignificantEventCollector {
  readonly observe: (event: OrchestrationV2DomainEvent) => ReadonlyArray<HarnessSignificantEvent>;
  readonly observePlotlineDags: (
    dags: ReadonlyArray<PlotlineDag>,
  ) => ReadonlyArray<HarnessSignificantEvent>;
  readonly snapshot: () => ReadonlyArray<HarnessSignificantEvent>;
  readonly seed: (event: HarnessSignificantEvent) => void;
  readonly seedId: (id: string) => void;
}

export class HarnessSignificantEventStore extends Context.Service<
  HarnessSignificantEventStore,
  {
    readonly snapshot: () => ReadonlyArray<HarnessSignificantEvent>;
    readonly stream: Stream.Stream<HarnessSignificantEvent, HarnessError>;
    readonly acknowledge: (eventId: string) => Effect.Effect<void, HarnessError>;
    readonly recordFailure: (eventId: string) => Effect.Effect<boolean, HarnessError>;
    readonly listPlotlineDags: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<PlotlineDag>, HarnessError>;
    readonly enqueueRootCandidate: (input: {
      readonly eventId: string;
      readonly projectId: string | null;
      readonly rootThreadId: string;
      readonly runId: string;
      readonly event: HarnessSignificantEvent;
      readonly at: string;
    }) => Effect.Effect<void, HarnessError>;
    readonly pendingRootCandidates: () => Effect.Effect<
      ReadonlyArray<{
        readonly eventId: string;
        readonly projectId: string | null;
        readonly rootThreadId: string;
        readonly runId: string;
        readonly event: HarnessSignificantEvent;
        readonly deliveryAttempts: number;
      }>,
      HarnessError
    >;
    readonly completeRootCandidate: (eventId: string) => Effect.Effect<void, HarnessError>;
    readonly reconcileCorrectionChild: (input: {
      readonly childThreadId: string;
      readonly childRunId: string;
    }) => Effect.Effect<void, HarnessError>;
    readonly failRootCandidate: (
      eventId: string,
      detail: string,
    ) => Effect.Effect<void, HarnessError>;
  }
>()("t3/harness/events/HarnessSignificantEventStore") {}

/** Keeps only the bounded signal history needed by Harness; safe to call from a committed event stream. */
export function makeSignificantEventCollector(): SignificantEventCollector {
  const events: Array<HarnessSignificantEvent> = [];
  const seen = new Set<string>();
  const requests = new Map<
    string,
    { count: number; sourceRefs: Array<string>; evidence: string }
  >();
  const assistantByRun = new Map<string, { id: string; messageId: string; text: string }>();
  const completedByThread = new Map<
    string,
    Array<{ id: string; runId: string; at: string; threadId: string }>
  >();
  const taskStates = new Map<string, { state: string; updatedAt: string }>();
  const loopGuard = makeLoopGuardCollector();
  const plotlineRuns = new Map<string, Array<{ dagId: string; taskId: string }>>();

  const add = (event: HarnessSignificantEvent): ReadonlyArray<HarnessSignificantEvent> => {
    if (seen.has(event.id)) return [];
    seen.add(event.id);
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
    return [event];
  };

  const observeSignificant = (
    event: OrchestrationV2DomainEvent,
  ): ReadonlyArray<HarnessSignificantEvent> => {
    if (event.type === "message.updated") {
      const message = event.payload;
      if (message.workflowScript) return [];
      if (message.role === "assistant" && message.runId) {
        assistantByRun.set(message.runId, {
          id: event.id,
          messageId: message.id,
          text: message.text,
        });
        if (assistantByRun.size > 1_000) assistantByRun.delete(assistantByRun.keys().next().value!);
        return [];
      }
      if (message.role !== "user" || !message.text.trim()) return [];
      const text = message.text.trim();
      const refs = [event.id, message.id];
      const found: Array<HarnessSignificantEvent> = [];
      if (isCorrectionPrompt(text)) {
        found.push(
          ...add({
            id: `feedback:${event.id}`,
            at: DateTime.formatIso(event.occurredAt),
            threadId: event.threadId,
            type: "user_feedback",
            summary: "The user corrected or redirected the agent.",
            evidence: [redactEvidence(text)],
            sourceRefs: refs,
          }),
        );
      }
      if (classifySuccessfulRun(text) === "validated_success") {
        const pending = completedByThread.get(event.threadId) ?? [];
        const latest = pending.at(-1);
        if (latest) {
          found.push(
            ...add({
              id: `validated:${event.id}:${latest.id}`,
              at: DateTime.formatIso(event.occurredAt),
              threadId: event.threadId,
              type: "validated_success",
              summary: "The user explicitly confirmed the completed result.",
              evidence: [redactEvidence(text)],
              sourceRefs: [event.id, message.id, latest.id, latest.runId],
            }),
          );
        }
      }
      // Only an immediate follow-up can validate the latest run; unrelated user work
      // breaks the evidence link and must not upgrade an older completion.
      completedByThread.delete(event.threadId);
      const key = `${event.threadId}:${normalizedText(text)}`;
      if (key) {
        const prior = requests.get(key) ?? { count: 0, sourceRefs: [], evidence: text };
        prior.count += 1;
        prior.sourceRefs.push(...refs);
        requests.set(key, prior);
        if (prior.count === 2) {
          found.push(
            ...add({
              id: `repeat:${event.id}`,
              at: DateTime.formatIso(event.occurredAt),
              threadId: event.threadId,
              type: "repeated_workflow",
              summary: "The same user request appeared more than once.",
              evidence: [redactEvidence(prior.evidence)],
              sourceRefs: [...prior.sourceRefs],
            }),
          );
        }
        if (requests.size > MAX_EVENTS * 10) requests.delete(requests.keys().next().value!);
      }
      return found;
    }

    if (event.type !== "run.updated") return [];
    // Plotline owns the state transition and rechecks the persisted run identity atomically.
    // A successful run is not verification for tasks with acceptance criteria.
    // (The async persistence path below uses the same event identity after commit.)
    const linkedTasks = plotlineRuns.get(`${event.threadId}\0${event.payload.id}`) ?? [];
    const taskRefs = linkedTasks.flatMap((task) => [
      `plotline:${task.dagId}`,
      `plotline:${task.dagId}:${task.taskId}`,
    ]);
    if (event.payload.status === "failed") {
      return add({
        id: `failure:${event.id}`,
        at: DateTime.formatIso(event.occurredAt),
        threadId: event.threadId,
        type: "failure",
        summary: "The agent run failed.",
        evidence: ["Run status: failed."],
        sourceRefs: [event.id, event.payload.id, ...taskRefs],
      });
    }
    if (event.payload.status === "completed") {
      const latest = assistantByRun.get(event.payload.id);
      const pending = completedByThread.get(event.threadId) ?? [];
      pending.push({
        id: event.id,
        runId: event.payload.id,
        at: DateTime.formatIso(event.occurredAt),
        threadId: event.threadId,
      });
      if (pending.length > 20) pending.shift();
      completedByThread.set(event.threadId, pending);
      if (completedByThread.size > 500) {
        completedByThread.delete(completedByThread.keys().next().value!);
      }
      return add({
        id: `success:${event.id}`,
        at: DateTime.formatIso(event.occurredAt),
        threadId: event.threadId,
        type: "successful_output",
        summary: "The agent run completed successfully.",
        evidence: [
          ...(latest?.text.trim() ? [redactEvidence(latest.text)] : []),
          "Run status: completed.",
        ],
        sourceRefs: [
          event.id,
          event.payload.id,
          ...taskRefs,
          ...(latest ? [latest.id, latest.messageId] : []),
        ],
      });
    }
    return [];
  };

  const observePlotlineDags = (
    dags: ReadonlyArray<PlotlineDag>,
  ): ReadonlyArray<HarnessSignificantEvent> => {
    plotlineRuns.clear();
    const found: Array<HarnessSignificantEvent> = [];
    for (const dag of dags) {
      for (const task of dag.tasks) {
        if (task.threadId !== null && task.runId !== null) {
          const key = `${task.threadId}\0${task.runId}`;
          const matches = plotlineRuns.get(key) ?? [];
          matches.push({ dagId: dag.id, taskId: task.id });
          plotlineRuns.set(key, matches);
        }
        const key = `${dag.id}:${task.id}`;
        const previous = taskStates.get(key);
        taskStates.set(key, { state: task.state, updatedAt: task.updatedAt });
        if (taskStates.size > 1_000) taskStates.delete(taskStates.keys().next().value!);
        if (!previous || previous.state === task.state) continue;
        const recovered =
          previous.state === "failed" && (task.state === "running" || task.state === "done");
        const completed = task.state === "done";
        const failed = task.state === "failed";
        if (!recovered && !completed && !failed) continue;
        const type: HarnessSignificantEventType = recovered
          ? "recovered_workflow"
          : completed
            ? "successful_output"
            : "failure";
        const sourceEvent = dag.events.find(
          (candidate) => candidate.at === task.updatedAt && candidate.taskId === task.id,
        );
        const signal: HarnessSignificantEvent = {
          id: `plotline:${dag.id}:${task.id}:${task.updatedAt}:${task.state}`,
          at: task.updatedAt,
          ...(task.threadId ? { threadId: task.threadId } : {}),
          projectId: dag.projectId,
          type,
          summary: recovered
            ? "A previously failed Plotline task was restarted or completed."
            : completed
              ? "A Plotline task completed successfully."
              : "A Plotline task failed.",
          evidence: [redactEvidence(`Task: ${task.title}. State: ${task.state}.`)],
          sourceRefs: [dag.id, task.id, ...(sourceEvent ? [sourceEvent.id] : [])],
        };
        found.push(...add(signal));
      }
    }
    return found;
  };

  const seed = (event: HarnessSignificantEvent) => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
  };
  const seedId = (id: string) => seen.add(id);

  const observe = (event: OrchestrationV2DomainEvent): ReadonlyArray<HarnessSignificantEvent> => {
    const significant = observeSignificant(event);
    const interventions = loopGuard.observe(event);
    const emitted = interventions.flatMap((intervention) =>
      add({
        id: intervention.id,
        at: intervention.at,
        threadId: intervention.threadId,
        type: "loop_guard",
        // Persist only aggregate counts and event references: no raw tool input or secrets.
        summary: `Loop Guard: ${intervention.state} (${intervention.reason}, ${intervention.observedCount}).`,
        evidence: [intervention.recommendation],
        sourceRefs: [...intervention.evidenceRefs],
        loopGuard: {
          state: intervention.state,
          reason: intervention.reason,
          observedCount: intervention.observedCount,
          recommendation: intervention.recommendation,
          ...(intervention.recoveryAction ? { recoveryAction: intervention.recoveryAction } : {}),
          advisoryOnly: true,
        },
      }),
    );
    return [...significant, ...emitted];
  };

  return { observe, observePlotlineDags, snapshot: () => [...events], seed, seedId };
}

export const makeStore = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* Effect.serviceOption(
    ThreadManagementService.ThreadManagementService,
  ) as Effect.Effect<
    Option.Option<ThreadManagementService.ThreadManagementService["Service"]>,
    never,
    never
  >;
  const eventSink = yield* Effect.serviceOption(EventSink.EventSinkV2) as Effect.Effect<
    Option.Option<EventSink.EventSinkV2["Service"]>,
    never,
    never
  >;
  const plotline = yield* PlotlineDagService.PlotlineDagService;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sql = yield* SqlClient.SqlClient;
  const collector = makeSignificantEventCollector();
  const changes = yield* PubSub.sliding<HarnessSignificantEvent>(100);
  const reconciliationWake = yield* Queue.dropping<void>(1);
  const activeReconciliations = new Set<string>();
  yield* sql`UPDATE harness_opencode_reconciliation SET status = 'pending', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'delivering'`;
  const publish = (items: ReadonlyArray<HarnessSignificantEvent>) =>
    Effect.forEach(items, (event) => PubSub.publish(changes, event), { discard: true }).pipe(
      Effect.ignoreCause({ log: true }),
    );
  const [cursor] = yield* sql<{ readonly sequence: number }>`
    SELECT sequence FROM harness_event_cursor WHERE consumer_id = 'significant-events'
  `;
  const persisted = yield* sql<{
    readonly payload_json: string;
  }>`SELECT payload_json FROM harness_significant_events ORDER BY sequence DESC LIMIT ${MAX_EVENTS}`;
  // The bounded persisted window restores the user-visible history across restarts.
  // Parsing is guarded so a damaged optional Harness row cannot prevent server startup.
  for (const row of [...persisted].reverse()) {
    const decoded = yield* decodeJson(row.payload_json).pipe(Effect.orElseSucceed(() => null));
    if (
      decoded !== null &&
      typeof decoded === "object" &&
      "id" in decoded &&
      typeof decoded.id === "string" &&
      "summary" in decoded &&
      typeof decoded.summary === "string"
    ) {
      collector.seed(decoded as HarnessSignificantEvent);
    }
  }
  const dedupeRows = yield* sql<{ readonly signal_id: string }>`
    SELECT signal_id FROM harness_significant_event_dedupe ORDER BY sequence DESC LIMIT ${MAX_DEDUPE_IDS}
  `;
  for (const row of dedupeRows) collector.seedId(row.signal_id);
  const committedSequences = new Set<number>();
  const pendingSignals = new Map<number, ReadonlyArray<HarnessSignificantEvent>>();
  let lastCommittedSequence = cursor?.sequence ?? 0;
  const deliverOpenCodeRun = Effect.fn("HarnessSignificantEventStore.deliverOpenCodeRun")(
    function* (eventId: string) {
      const [row] = yield* sql<{
        readonly thread_id: string;
        readonly run_id: string;
        readonly run_status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
        readonly event_kind: "opencode_run" | "correction_child";
      }>`SELECT thread_id, run_id, run_status, event_kind FROM harness_opencode_reconciliation
        WHERE event_id = ${eventId} AND status IN ('pending', 'failed')`;
      if (!row) return;
      const [claimed] = yield* sql<{ readonly delivery_attempts: number }>`
        UPDATE harness_opencode_reconciliation
        SET delivery_attempts = delivery_attempts + 1, status = 'delivering', updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ${eventId} AND status IN ('pending', 'failed')
        RETURNING delivery_attempts
      `;
      if (!claimed) return;
      const result = yield* (
        row.event_kind === "correction_child"
          ? Effect.gen(function* () {
              const dags = yield* plotline.list({}).pipe(
                Effect.mapError(
                  () =>
                    new HarnessError({
                      message: "Could not inspect linked correction children.",
                    }),
                ),
              );
              let matched = false;
              for (const dag of dags.dags) {
                for (const task of dag.tasks) {
                  for (const correction of task.correctionAttempts ?? []) {
                    if (
                      correction.state !== "running" ||
                      correction.childThreadId !== row.thread_id ||
                      correction.childRunId !== row.run_id
                    )
                      continue;
                    matched = true;
                    yield* plotline.settleCorrection(dag.projectId, {
                      dagId: dag.id,
                      taskId: task.id,
                      correctionId: correction.id,
                      state:
                        row.run_status === "running"
                          ? "interrupted"
                          : row.run_status === "completed"
                            ? "completed"
                            : row.run_status,
                    });
                  }
                }
              }
              return matched;
            })
          : plotline
              .reconcileRun(
                row.thread_id,
                row.run_id,
                row.run_status as "running" | "completed" | "failed",
              )
              .pipe(Effect.as(true))
      ).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      );
      if (result.ok && (row.event_kind !== "correction_child" || result.value)) {
        yield* sql`UPDATE harness_opencode_reconciliation SET status = 'complete', failure_detail = NULL,
          next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE event_id = ${eventId} AND status = 'delivering'`;
        return;
      }
      if (result.ok) {
        // Keep unmatched app-owned children dormant until Plotline links this exact identity.
        // They are reactivated by link-time reconciliation, not retried as arbitrary subagents.
        yield* sql`UPDATE harness_opencode_reconciliation SET status = 'awaiting_link', updated_at = CURRENT_TIMESTAMP
          WHERE event_id = ${eventId} AND status = 'delivering'`;
        return;
      }
      const failureDetail =
        result.error instanceof Error ? result.error.message : String(result.error);
      const retryDelaySeconds = Math.min(
        2 ** Math.min(claimed.delivery_attempts - 1, 9),
        MAX_RETRY_DELAY_SECONDS,
      );
      const now = yield* DateTime.now;
      const nextAttemptAt = DateTime.formatIso(
        DateTime.toUtc(DateTime.add(now, { seconds: retryDelaySeconds })),
      );
      yield* sql`UPDATE harness_opencode_reconciliation
        SET status = CASE WHEN delivery_attempts >= ${MAX_DELIVERY_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
            failure_detail = ${failureDetail.slice(0, 500)},
            next_attempt_at = ${nextAttemptAt}, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ${eventId} AND status = 'delivering'`;
    },
  );
  const scheduleReconciliation = Effect.fn("HarnessSignificantEventStore.scheduleReconciliation")(
    function* (eventId: string) {
      const started = yield* Effect.sync(() => {
        if (activeReconciliations.has(eventId)) return false;
        activeReconciliations.add(eventId);
        return true;
      });
      if (!started) return;
      yield* deliverOpenCodeRun(eventId).pipe(
        Effect.ensuring(
          Effect.sync(() => activeReconciliations.delete(eventId)).pipe(
            Effect.andThen(Queue.offer(reconciliationWake, undefined)),
          ),
        ),
        Effect.forkScoped,
      );
    },
  );
  const processStoredEvent = Effect.fn("HarnessSignificantEventStore.processStoredEvent")(
    function* (stored: import("@t3tools/contracts").OrchestrationV2StoredEvent) {
      if (committedSequences.has(stored.sequence)) return;
      const found = pendingSignals.get(stored.sequence) ?? collector.observe(stored.event);
      pendingSignals.set(stored.sequence, found);
      let reconcileOpenCodeRun = false;
      let reconcileCorrectionChild = false;
      if (
        stored.event.type === "run.updated" &&
        ["running", "completed", "failed"].includes(stored.event.payload.status)
      ) {
        const instance = yield* providers.getInstance(
          stored.event.payload.modelSelection.instanceId,
        );
        reconcileOpenCodeRun = instance?.driverKind === "opencode";
      }
      if (
        stored.event.type === "subagent.updated" &&
        stored.event.payload.origin === "app_owned" &&
        ["cancelled", "interrupted", "failed", "completed"].includes(stored.event.payload.status) &&
        stored.event.payload.childThreadId !== null &&
        stored.event.payload.runId !== null
      ) {
        reconcileCorrectionChild = true;
      }
      const newEvents: Array<HarnessSignificantEvent> = [];
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (reconcileOpenCodeRun && stored.event.type === "run.updated") {
            yield* sql`
              INSERT INTO harness_opencode_reconciliation
                (event_id, sequence, thread_id, run_id, run_status, created_at, updated_at)
              VALUES (
                ${stored.event.id}, ${stored.sequence}, ${stored.event.threadId},
                ${stored.event.payload.id}, ${stored.event.payload.status},
                ${DateTime.formatIso(stored.event.occurredAt)}, ${DateTime.formatIso(stored.event.occurredAt)}
              ) ON CONFLICT(event_id) DO NOTHING
            `;
          }
          if (reconcileCorrectionChild && stored.event.type === "subagent.updated") {
            const status = stored.event.payload.status;
            yield* sql`
              INSERT INTO harness_opencode_reconciliation
                (event_id, sequence, thread_id, run_id, run_status, event_kind, created_at, updated_at)
              VALUES (
                ${stored.event.id}, ${stored.sequence}, ${stored.event.payload.childThreadId!},
                ${stored.event.payload.runId!}, ${status === "completed" ? "completed" : status === "failed" ? "failed" : status},
                'correction_child', ${DateTime.formatIso(stored.event.occurredAt)}, ${DateTime.formatIso(stored.event.occurredAt)}
              ) ON CONFLICT(event_id) DO NOTHING
            `;
          }
          for (const event of found) {
            const inserted = yield* sql<{ readonly signal_id: string }>`
              INSERT INTO harness_significant_event_dedupe (signal_id, sequence)
              VALUES (${event.id}, ${stored.sequence})
              ON CONFLICT(signal_id) DO NOTHING
              RETURNING signal_id
            `;
            if (inserted.length === 0) continue;
            yield* sql`
              INSERT INTO harness_significant_events (event_id, sequence, payload_json, created_at)
              VALUES (${event.id}, ${stored.sequence}, ${encodeJson(event)}, ${event.at})
              ON CONFLICT(event_id) DO NOTHING
            `;
            newEvents.push(event);
          }
          yield* sql`
            UPDATE harness_event_cursor SET sequence = ${stored.sequence}
            WHERE consumer_id = 'significant-events' AND sequence < ${stored.sequence}
          `;
          yield* sql`DELETE FROM harness_significant_events WHERE delivery_status != 'pending' AND event_id IN (
            SELECT event_id FROM harness_significant_events WHERE delivery_status != 'pending' ORDER BY sequence DESC LIMIT -1 OFFSET ${MAX_EVENTS}
          )`;
          yield* sql`DELETE FROM harness_significant_event_dedupe WHERE signal_id IN (
            SELECT signal_id FROM harness_significant_event_dedupe ORDER BY sequence DESC LIMIT -1 OFFSET ${MAX_DEDUPE_IDS}
          )`;
        }),
      );
      committedSequences.add(stored.sequence);
      lastCommittedSequence = Math.max(lastCommittedSequence, stored.sequence);
      if (committedSequences.size > REPLAY_CONTEXT_EVENTS * 2) {
        const oldest = committedSequences.values().next().value;
        if (oldest !== undefined) committedSequences.delete(oldest);
      }
      pendingSignals.delete(stored.sequence);
      yield* publish(newEvents);
      yield* reconcileVerifierResult(stored.event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Verifier result reconciliation was deferred.", { cause }),
        ),
      );
      if (reconcileOpenCodeRun || reconcileCorrectionChild) {
        yield* scheduleReconciliation(stored.event.id);
        yield* Queue.offer(reconciliationWake, undefined);
      }
      // Surface persisted Loop Guard evidence in the existing read-only Plotline panel.
      // Task ownership and orchestration state are untouched.
      const interventions = newEvents.filter((signal) => signal.type === "loop_guard");
      if (interventions.length > 0) {
        const source = stored.event;
        const runId =
          source.runId ??
          (source.type === "turn-item.updated" ? source.payload.runId : undefined) ??
          (source.type === "run-attempt.updated" ? source.payload.runId : undefined) ??
          (source.type === "run.updated" ? source.payload.id : undefined);
        if (runId) {
          const dags = yield* plotline.list({}).pipe(Effect.orElseSucceed(() => ({ dags: [] })));
          const matches = findPlotlineTaskRunMatches(dags.dags, source.threadId, runId);
          for (const match of matches) {
            const dag = dags.dags.find((entry) => entry.id === match.dagId);
            if (!dag) continue;
            for (const intervention of interventions) {
              yield* plotline
                .addEvent(dag.projectId, {
                  dagId: match.dagId,
                  taskId: match.taskId,
                  message: intervention.summary,
                  level: intervention.summary.includes("resolved")
                    ? "ok"
                    : intervention.summary.includes("warning")
                      ? "live"
                      : "error",
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }
        }
      }
    },
  );
  const runEventStream = Effect.suspend(() =>
    Stream.runForEach(
      orchestrator.streamStoredEventsFrom({
        afterSequence: Math.max(0, lastCommittedSequence - REPLAY_CONTEXT_EVENTS),
      }),
      processStoredEvent,
    ),
  );
  const recoverRequestedCorrections = Effect.fn(
    "HarnessSignificantEventStore.recoverRequestedCorrections",
  )(function* () {
    const dags = yield* plotline
      .list({})
      .pipe(
        Effect.mapError(
          () => new HarnessError({ message: "Could not inspect requested corrections." }),
        ),
      );
    for (const dag of dags.dags) {
      for (const task of dag.tasks) {
        for (const correction of task.correctionAttempts ?? []) {
          if (correction.state !== "requested") continue;
          const failUnresolvable = () =>
            plotline.settleCorrection(dag.projectId, {
              dagId: dag.id,
              taskId: task.id,
              correctionId: correction.id,
              state: "failed",
            });
          if (correction.dispatchInput === undefined) {
            yield* failUnresolvable().pipe(Effect.ignore);
            continue;
          }
          const dispatchInput = correction.dispatchInput as Omit<
            Extract<OrchestrationV2ServerCommand, { type: "delegated_task.request" }>,
            "commandId"
          >;
          if (
            dispatchInput.type !== "delegated_task.request" ||
            !dispatchInput.parentThreadId ||
            !dispatchInput.parentRunId
          ) {
            yield* failUnresolvable().pipe(Effect.ignore);
            continue;
          }
          const commandId = CommandId.make(`plotline-correction-${correction.id}`);
          const dispatched = yield* orchestrator.dispatch({ ...dispatchInput, commandId }).pipe(
            Effect.catch((cause) => {
              const rejected =
                typeof cause === "object" &&
                cause !== null &&
                "_tag" in cause &&
                (cause._tag === "OrchestratorCommandPreviouslyRejectedError" ||
                  cause._tag === "OrchestratorCommandIdConflictError" ||
                  cause._tag === "OrchestratorCommandRejectedError");
              if (rejected) {
                return plotline
                  .settleCorrection(dag.projectId, {
                    dagId: dag.id,
                    taskId: task.id,
                    correctionId: correction.id,
                    state: "failed",
                  })
                  .pipe(
                    Effect.tap(() =>
                      Effect.logWarning(
                        "Plotline correction was permanently rejected and escalated.",
                        {
                          dagId: dag.id,
                          taskId: task.id,
                          correctionId: correction.id,
                          cause,
                        },
                      ),
                    ),
                    Effect.as(null),
                    Effect.catchCause(() => Effect.succeed(null)),
                  );
              }
              return Effect.logWarning("Requested Plotline correction recovery was deferred.", {
                dagId: dag.id,
                taskId: task.id,
                correctionId: correction.id,
                cause,
              }).pipe(Effect.as(null));
            }),
          );
          if (dispatched === null) continue;
          const child = dispatched.storedEvents.find(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.origin === "app_owned",
          );
          if (
            child?.event.type !== "subagent.updated" ||
            child.event.payload.childThreadId === null
          )
            continue;
          const correctionChildThreadId = child.event.payload.childThreadId;
          const childRun = dispatched.storedEvents.find(
            (stored) =>
              stored.event.type === "run.created" &&
              stored.event.threadId === correctionChildThreadId,
          );
          if (childRun?.event.type !== "run.created") continue;
          yield* plotline
            .linkCorrection(dag.projectId, {
              dagId: dag.id,
              taskId: task.id,
              correctionId: correction.id,
              childTaskId: child.event.payload.id,
              childThreadId: child.event.payload.childThreadId,
              childRunId: childRun.event.payload.id,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  "Recovered correction could not be linked; stable command replay will retry.",
                  { dagId: dag.id, correctionId: correction.id, cause },
                ),
              ),
            );
        }
      }
    }
  });
  const failVerifierRequest = Effect.fn("HarnessSignificantEventStore.failVerifierRequest")(
    function* (
      dagId: string,
      projectId: string,
      taskId: string,
      correctionId: string,
      criteriaVersion: number,
      expectedRunId: string | null,
    ) {
      yield* plotline
        .updateVerifierRequest(projectId, {
          dagId,
          taskId,
          correctionId,
          state: "failed",
        })
        .pipe(Effect.ignore);
      const latest = yield* plotline
        .getForProject(projectId, dagId)
        .pipe(Effect.orElseSucceed(() => null));
      const task = latest?.tasks.find((candidate) => candidate.id === taskId);
      if (
        task &&
        (task.criteriaVersion ?? 1) === criteriaVersion &&
        (task.runId ?? null) === expectedRunId
      )
        yield* plotline
          .updateTask(projectId, { dagId, taskId, state: "failed" })
          .pipe(Effect.ignore);
    },
  );
  const recoverVerifierRequests = Effect.fn("HarnessSignificantEventStore.recoverVerifierRequests")(
    function* () {
      if (Option.isNone(threads)) return;
      const dags = yield* plotline.list({}).pipe(
        Effect.mapError(
          () => new HarnessError({ message: "Could not inspect verifier requests." }),
        ),
        Effect.catchCause(() => Effect.succeed({ dags: [] })),
      );
      for (const dag of dags.dags) {
        for (const task of dag.tasks) {
          for (const correction of task.correctionAttempts ?? []) {
            const decoded = correction.verifierRequest
              ? yield* decodeVerifierRequest(correction.verifierRequest).pipe(
                  Effect.orElseSucceed(() => null),
                )
              : null;
            if (!decoded) continue;
            if (decoded.state === "dispatched") {
              if (Option.isNone(eventSink) || decoded.childTaskId === undefined) continue;
              const existingEvents = yield* Stream.runCollect(
                eventSink.value.stream({
                  threadId: decoded.parentThreadId,
                  eventType: "subagent.updated",
                }),
              ).pipe(Effect.orElseSucceed(() => []));
              const terminal = [...existingEvents]
                .reverse()
                .find(
                  (stored) =>
                    stored.event.type === "subagent.updated" &&
                    stored.event.payload.id === decoded.childTaskId &&
                    stored.event.payload.origin === "app_owned" &&
                    ["completed", "failed", "cancelled", "interrupted"].includes(
                      stored.event.payload.status,
                    ),
                );
              if (terminal) yield* reconcileVerifierResult(terminal.event).pipe(Effect.ignore);
              continue;
            }
            if (decoded.state !== "requested") continue;
            if (
              decoded.modelSelection === undefined ||
              decoded.runtimeMode === undefined ||
              decoded.interactionMode === undefined
            ) {
              yield* failVerifierRequest(
                dag.id,
                dag.projectId,
                task.id,
                correction.id,
                decoded.criteriaVersion,
                decoded.expectedRunId,
              );
              continue;
            }
            const command = {
              type: "delegated_task.request" as const,
              commandId: CommandId.make(decoded.commandId),
              createdBy: "agent" as const,
              creationSource: "mcp" as const,
              parentThreadId: decoded.parentThreadId,
              parentRunId: decoded.parentRunId as never,
              parentNodeId: decoded.parentNodeId as never,
              task: decoded.task,
              title: `Verify Plotline task ${task.id}`,
              modelSelection: decoded.modelSelection,
              runtimeMode: decoded.runtimeMode,
              interactionMode: decoded.interactionMode,
              completionWake: "always" as const,
            };
            const dispatched = yield* threads.value
              .dispatch(command)
              .pipe(Effect.match({ onFailure: () => null, onSuccess: (result) => result }));
            if (dispatched === null) {
              // Inactive parents and unavailable providers are explicit escalations, not retries.
              yield* failVerifierRequest(
                dag.id,
                dag.projectId,
                task.id,
                correction.id,
                decoded.criteriaVersion,
                decoded.expectedRunId,
              );
              continue;
            }
            const receipt = Option.isSome(eventSink)
              ? yield* Stream.runCollect(
                  eventSink.value.readByCommandId({ commandId: CommandId.make(decoded.commandId) }),
                ).pipe(Effect.orElseSucceed(() => dispatched.storedEvents))
              : dispatched.storedEvents;
            const storedEvents = receipt.length === 0 ? dispatched.storedEvents : [...receipt];
            const child = storedEvents.find(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.origin === "app_owned",
            );
            if (
              child?.event.type !== "subagent.updated" ||
              child.event.payload.childThreadId === null
            ) {
              yield* failVerifierRequest(
                dag.id,
                dag.projectId,
                task.id,
                correction.id,
                decoded.criteriaVersion,
                decoded.expectedRunId,
              );
              continue;
            }
            const verifierChildThreadId = child.event.payload.childThreadId;
            const childRun = storedEvents.find(
              (stored) =>
                stored.event.type === "run.created" &&
                stored.event.threadId === verifierChildThreadId,
            );
            if (childRun?.event.type !== "run.created") continue;
            yield* plotline
              .updateVerifierRequest(dag.projectId, {
                dagId: dag.id,
                taskId: task.id,
                correctionId: correction.id,
                state: "dispatched",
                childTaskId: child.event.payload.id,
                childThreadId: child.event.payload.childThreadId,
                childRunId: childRun.event.payload.id,
              })
              .pipe(Effect.ignore);
          }
        }
      }
    },
  );
  const reconcileVerifierResult = Effect.fn("HarnessSignificantEventStore.reconcileVerifierResult")(
    function* (event: OrchestrationV2DomainEvent) {
      if (event.type !== "subagent.updated" || event.payload.origin !== "app_owned") return;
      const payload = event.payload;
      if (
        payload.status !== "completed" &&
        payload.status !== "failed" &&
        payload.status !== "cancelled" &&
        payload.status !== "interrupted"
      )
        return;
      const dags = yield* plotline.list({}).pipe(Effect.orElseSucceed(() => ({ dags: [] })));
      for (const dag of dags.dags) {
        for (const task of dag.tasks) {
          for (const correction of task.correctionAttempts ?? []) {
            const request = correction.verifierRequest;
            if (
              !request ||
              request.state !== "dispatched" ||
              request.childTaskId !== payload.id ||
              request.childThreadId !== payload.childThreadId
            )
              continue;
            const evidence =
              payload.status === "completed" && payload.result !== null
                ? yield* decodeVerifierEvidence(payload.result).pipe(
                    Effect.orElseSucceed(() => null),
                  )
                : null;
            if (evidence === null) {
              yield* failVerifierRequest(
                dag.id,
                dag.projectId,
                task.id,
                correction.id,
                request.criteriaVersion,
                request.expectedRunId,
              );
              continue;
            }
            const attemptInput = yield* decodeVerifierAttempt({
              dagId: dag.id,
              taskId: task.id,
              attemptId: `plotline-verification-${correction.id}`,
              expectedCriteriaVersion: request.criteriaVersion,
              expectedRunId: request.expectedRunId,
              ...evidence,
            }).pipe(Effect.orElseSucceed(() => null));
            if (attemptInput === null) {
              yield* failVerifierRequest(
                dag.id,
                dag.projectId,
                task.id,
                correction.id,
                request.criteriaVersion,
                request.expectedRunId,
              );
              continue;
            }
            const recorded = yield* plotline
              .recordVerificationAttempt(dag.projectId, attemptInput)
              .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
            if (!recorded) {
              yield* failVerifierRequest(
                dag.id,
                dag.projectId,
                task.id,
                correction.id,
                request.criteriaVersion,
                request.expectedRunId,
              );
              continue;
            }
            if (evidence.verdict === "fail") {
              const failedCriteria = evidence.criterionResults
                .filter((result) => result.verdict === "fail")
                .map((result) => {
                  const criterion = task.acceptanceCriteria?.find(
                    (item) => item.id === result.criterionId,
                  );
                  return `- ${result.criterionId}: ${criterion?.description ?? "Acceptance criterion"}\n  Evidence: ${result.evidence}`;
                })
                .join("\n");
              const dispatchInput = {
                type: "delegated_task.request" as const,
                createdBy: "agent" as const,
                creationSource: "mcp" as const,
                parentThreadId: request.parentThreadId,
                parentRunId: request.parentRunId as never,
                parentNodeId: request.parentNodeId as never,
                title: `Correct Plotline task ${task.id}`,
                task: [
                  `Correct native Plotline task ${task.id} (DAG ${dag.id}).`,
                  `This is correction cycle ${
                    (task.correctionAttempts?.length ?? 0) + 1
                  } of 3. Preserve the task's intent and make the narrowest appropriate correction.`,
                  `Failed verifier summary: ${evidence.summary}`,
                  `Failed criteria:\n${failedCriteria || "No criterion-specific failure evidence was supplied."}`,
                  "Do not claim acceptance. The parent will independently verify the resulting run against the current acceptance criteria.",
                ].join("\n\n"),
                modelSelection: request.modelSelection,
                runtimeMode: request.runtimeMode,
                interactionMode: request.interactionMode,
                completionWake: "always" as const,
              };
              const reservation = yield* plotline
                .beginCorrection(dag.projectId, {
                  dagId: dag.id,
                  taskId: task.id,
                  verificationAttemptId: attemptInput.attemptId,
                  expectedCriteriaVersion: request.criteriaVersion,
                  expectedRunId: request.expectedRunId,
                  dispatchInput,
                })
                .pipe(Effect.match({ onFailure: () => null, onSuccess: (result) => result }));
              // Keep the terminal verifier request replayable until its failed result has
              // durably reserved the correction (or durably recorded escalation).
              if (reservation === null) continue;
              if (reservation.shouldDispatch) yield* recoverRequestedCorrections();
              yield* plotline
                .updateVerifierRequest(dag.projectId, {
                  dagId: dag.id,
                  taskId: task.id,
                  correctionId: correction.id,
                  state: "completed",
                })
                .pipe(Effect.ignore);
              continue;
            }
            // Only a fully passing, current evidence set can complete the task. Inconclusive
            // evidence stops safely for maintainer review.
            const settled = yield* plotline
              .updateTask(dag.projectId, {
                dagId: dag.id,
                taskId: task.id,
                state: evidence.verdict === "pass" ? "done" : "failed",
              })
              .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
            if (!settled) continue;
            yield* plotline
              .updateVerifierRequest(dag.projectId, {
                dagId: dag.id,
                taskId: task.id,
                correctionId: correction.id,
                state: "completed",
              })
              .pipe(Effect.ignore);
          }
        }
      }
    },
  );
  const reconciliationWorker = Effect.forever(
    Effect.gen(function* () {
      yield* recoverRequestedCorrections().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Requested Plotline correction recovery failed; retrying.", { cause }),
        ),
      );
      yield* recoverVerifierRequests().pipe(Effect.ignoreCause);
      const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
      const activeIds = [...activeReconciliations];
      const pending = yield* sql<{ readonly event_id: string }>`
        SELECT current.event_id FROM harness_opencode_reconciliation AS current
        WHERE current.status IN ('pending', 'failed')
          AND (current.next_attempt_at IS NULL OR current.next_attempt_at <= ${now})
          ${activeIds.length === 0 ? sql`` : sql`AND current.event_id NOT IN ${sql.in(activeIds)}`}
          AND NOT EXISTS (
            SELECT 1 FROM harness_opencode_reconciliation AS earlier
            WHERE earlier.event_kind = current.event_kind
              AND earlier.thread_id = current.thread_id AND earlier.run_id = current.run_id
              AND earlier.sequence < current.sequence AND earlier.status != 'complete'
          )
        ORDER BY current.sequence ASC LIMIT ${MAX_EVENTS}
      `;
      if (pending.length === 0) {
        const [next] = yield* sql<{ readonly next_attempt_at: string | null }>`
          SELECT MIN(current.next_attempt_at) AS next_attempt_at
          FROM harness_opencode_reconciliation AS current
          WHERE current.status IN ('pending', 'failed')
            ${activeIds.length === 0 ? sql`` : sql`AND current.event_id NOT IN ${sql.in(activeIds)}`}
            AND NOT EXISTS (
              SELECT 1 FROM harness_opencode_reconciliation AS earlier
              WHERE earlier.event_kind = current.event_kind
                AND earlier.thread_id = current.thread_id AND earlier.run_id = current.run_id
                AND earlier.sequence < current.sequence AND earlier.status != 'complete'
            )
        `;
        if (next === undefined || next.next_attempt_at === null) {
          yield* Queue.take(reconciliationWake).pipe(
            Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
          );
        } else {
          const delay = Math.max(
            1,
            Date.parse(next.next_attempt_at) - DateTime.toEpochMillis(yield* DateTime.now),
          );
          yield* Queue.take(reconciliationWake).pipe(
            Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.void }),
          );
        }
        return;
      }
      yield* Effect.forEach(pending, (row) => scheduleReconciliation(row.event_id), {
        discard: true,
      });
    }),
  ).pipe(
    Effect.tapCause((cause) =>
      Effect.logWarning("OpenCode run reconciliation worker hit a storage error; retrying.", {
        cause,
      }),
    ),
    Effect.retry({ schedule: Schedule.exponential("1 second") }),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* reconciliationWorker;
  yield* runEventStream.pipe(
    Effect.tapCause((cause) =>
      Effect.logWarning("Harness event collection hit an orchestration stream error; retrying.", {
        cause,
      }),
    ),
    Effect.retry({ schedule: Schedule.exponential("1 second") }),
    Effect.forkScoped,
  );
  yield* plotline.subscribe({}).pipe(
    Stream.runForEach((result) =>
      Queue.offer(reconciliationWake, undefined).pipe(
        Effect.andThen(Effect.sync(() => collector.observePlotlineDags(result.dags))),
        Effect.flatMap(publish),
        Effect.ignoreCause({ log: true }),
      ),
    ),
    Effect.tapCause((cause) =>
      Effect.logWarning("Harness Plotline event collection stopped after a subscription error.", {
        cause,
      }),
    ),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );
  const persistedStream = (): Stream.Stream<HarnessSignificantEvent, HarnessError> =>
    Stream.suspend(() =>
      Stream.fromEffect(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly event_id: string;
            readonly payload_json: string;
          }>`SELECT event_id, payload_json FROM harness_significant_events WHERE delivery_status = 'pending' ORDER BY sequence ASC LIMIT ${MAX_EVENTS}`.pipe(
            Effect.mapError(
              () => new HarnessError({ message: "Could not load pending Harness events." }),
            ),
          );
          const events: Array<HarnessSignificantEvent> = [];
          for (const row of rows) {
            const decoded = yield* decodeJson(row.payload_json).pipe(
              Effect.orElseSucceed(() => null),
            );
            if (
              decoded !== null &&
              typeof decoded === "object" &&
              "id" in decoded &&
              typeof decoded.id === "string" &&
              "summary" in decoded &&
              typeof decoded.summary === "string"
            ) {
              events.push(decoded as HarnessSignificantEvent);
            } else {
              yield* sql`
                UPDATE harness_significant_events SET delivery_status = 'failed'
                WHERE event_id = ${row.event_id} AND delivery_status = 'pending'
              `.pipe(
                Effect.mapError(
                  () =>
                    new HarnessError({ message: "Could not quarantine an invalid Harness event." }),
                ),
              );
            }
          }
          return events;
        }),
      ).pipe(
        Stream.flatMap((events) =>
          events.length === 0
            ? Stream.empty
            : Stream.concat(Stream.fromIterable(events), persistedStream()),
        ),
      ),
    );
  return HarnessSignificantEventStore.of({
    snapshot: collector.snapshot,
    acknowledge: Effect.fn("HarnessSignificantEventStore.acknowledge")(function* (eventId: string) {
      yield* sql`
        UPDATE harness_significant_events SET delivery_status = 'complete'
        WHERE event_id = ${eventId} AND delivery_status = 'pending'
      `.pipe(
        Effect.mapError(
          () => new HarnessError({ message: "Could not acknowledge Harness event." }),
        ),
      );
    }),
    recordFailure: Effect.fn("HarnessSignificantEventStore.recordFailure")(function* (
      eventId: string,
    ) {
      const rows = yield* sql<{ readonly delivery_attempts: number }>`
        UPDATE harness_significant_events
        SET delivery_attempts = delivery_attempts + 1,
            delivery_status = CASE WHEN delivery_attempts + 1 >= ${MAX_DELIVERY_ATTEMPTS} THEN 'failed' ELSE 'pending' END
        WHERE event_id = ${eventId} AND delivery_status = 'pending'
        RETURNING delivery_attempts
      `.pipe(
        Effect.mapError(
          () => new HarnessError({ message: "Could not record Harness delivery failure." }),
        ),
      );
      return (rows[0]?.delivery_attempts ?? MAX_DELIVERY_ATTEMPTS) >= MAX_DELIVERY_ATTEMPTS;
    }),
    listPlotlineDags: Effect.fn("HarnessSignificantEventStore.listPlotlineDags")(function* (
      projectId: string,
    ) {
      return yield* plotline.list({ projectId }).pipe(
        Effect.map((result) => result.dags),
        Effect.mapError(
          () => new HarnessError({ message: "Could not read associated Plotline DAGs." }),
        ),
      );
    }),
    enqueueRootCandidate: Effect.fn("HarnessSignificantEventStore.enqueueRootCandidate")(
      function* (input) {
        yield* sql`INSERT INTO harness_root_candidates (event_id, project_id, root_thread_id, run_id, event_json, created_at, updated_at)
        VALUES (${input.eventId}, ${input.projectId}, ${input.rootThreadId}, ${input.runId}, ${encodeJson(input.event)}, ${input.at}, ${input.at})
        ON CONFLICT(event_id) DO NOTHING`.pipe(
          Effect.mapError(
            () => new HarnessError({ message: "Could not persist a root analysis candidate." }),
          ),
        );
      },
    ),
    pendingRootCandidates: Effect.fn("HarnessSignificantEventStore.pendingRootCandidates")(
      function* () {
        const rows = yield* sql<{
          readonly event_id: string;
          readonly project_id: string | null;
          readonly root_thread_id: string;
          readonly run_id: string;
          readonly event_json: string;
          readonly delivery_attempts: number;
        }>`SELECT event_id, project_id, root_thread_id, run_id, event_json, delivery_attempts FROM harness_root_candidates WHERE status = 'pending' ORDER BY created_at`.pipe(
          Effect.mapError(
            () => new HarnessError({ message: "Could not load pending root analysis candidates." }),
          ),
        );
        const candidates = [];
        for (const row of rows) {
          const event = yield* decodeJson(row.event_json).pipe(Effect.orElseSucceed(() => null));
          if (event && typeof event === "object" && "id" in event && "sourceRefs" in event) {
            candidates.push({
              eventId: row.event_id,
              projectId: row.project_id,
              rootThreadId: row.root_thread_id,
              runId: row.run_id,
              event: event as HarnessSignificantEvent,
              deliveryAttempts: row.delivery_attempts,
            });
          } else {
            yield* sql`UPDATE harness_root_candidates SET status = 'failed', failure_detail = 'Stored root event evidence is invalid.', updated_at = CURRENT_TIMESTAMP WHERE event_id = ${row.event_id} AND status = 'pending'`.pipe(
              Effect.mapError(
                () =>
                  new HarnessError({ message: "Could not quarantine an invalid root candidate." }),
              ),
            );
          }
        }
        return candidates;
      },
    ),
    completeRootCandidate: Effect.fn("HarnessSignificantEventStore.completeRootCandidate")(
      function* (eventId: string) {
        yield* sql`UPDATE harness_root_candidates SET status = 'complete', updated_at = CURRENT_TIMESTAMP WHERE event_id = ${eventId} AND status = 'pending'`.pipe(
          Effect.mapError(
            () => new HarnessError({ message: "Could not complete a root analysis candidate." }),
          ),
        );
      },
    ),
    reconcileCorrectionChild: Effect.fn("HarnessSignificantEventStore.reconcileCorrectionChild")(
      function* ({
        childThreadId,
        childRunId,
      }: {
        readonly childThreadId: string;
        readonly childRunId: string;
      }) {
        const dags = yield* plotline
          .list({})
          .pipe(
            Effect.mapError(
              () => new HarnessError({ message: "Could not inspect linked correction children." }),
            ),
          );
        const correctionIsRunning = dags.dags.some((dag) =>
          dag.tasks.some((task) =>
            task.correctionAttempts?.some(
              (correction) =>
                correction.state === "running" &&
                correction.childThreadId === childThreadId &&
                correction.childRunId === childRunId,
            ),
          ),
        );
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const matching = yield* sql<{
                readonly sequence: number;
                readonly event_id: string;
                readonly thread_id: string;
                readonly status: "cancelled" | "interrupted" | "failed" | "completed";
                readonly occurred_at: string;
              }>`SELECT sequence, event_id, ${childThreadId} AS thread_id,
              json_extract(payload_json, '$.status') AS status, occurred_at
            FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND event_type = 'subagent.updated'
              AND json_extract(payload_json, '$.origin') = 'app_owned'
              AND json_extract(payload_json, '$.childThreadId') = ${childThreadId}
              AND json_extract(payload_json, '$.runId') = ${childRunId}
              AND json_extract(payload_json, '$.status') IN ('cancelled', 'interrupted', 'failed', 'completed')
            ORDER BY sequence ASC`;
              yield* Effect.forEach(matching, (storedEvent) => {
                const status = storedEvent.status;
                return sql`
            INSERT INTO harness_opencode_reconciliation
              (event_id, sequence, thread_id, run_id, run_status, event_kind, status, created_at, updated_at)
            VALUES (
              ${storedEvent.event_id}, ${storedEvent.sequence}, ${storedEvent.thread_id}, ${childRunId},
              ${status === "completed" ? "completed" : status === "failed" ? "failed" : status},
              'correction_child', 'pending', ${storedEvent.occurred_at}, ${storedEvent.occurred_at}
              ) ON CONFLICT(event_id) DO UPDATE SET
                sequence = excluded.sequence,
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                run_status = excluded.run_status,
                event_kind = excluded.event_kind,
                status = CASE WHEN harness_opencode_reconciliation.status IN ('awaiting_link', 'delivering')
                  OR (harness_opencode_reconciliation.status = 'complete' AND ${correctionIsRunning})
                THEN 'pending' ELSE harness_opencode_reconciliation.status END,
              next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
          `;
              });
            }),
          )
          .pipe(
            Effect.mapError(
              () => new HarnessError({ message: "Could not reconcile a linked correction child." }),
            ),
          );
        yield* Queue.offer(reconciliationWake, undefined);
      },
    ),
    failRootCandidate: Effect.fn("HarnessSignificantEventStore.failRootCandidate")(function* (
      eventId: string,
      detail: string,
    ) {
      yield* sql`UPDATE harness_root_candidates SET delivery_attempts = delivery_attempts + 1,
        status = CASE WHEN delivery_attempts + 1 >= ${MAX_DELIVERY_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
        failure_detail = ${detail.slice(0, 500)}, updated_at = CURRENT_TIMESTAMP WHERE event_id = ${eventId} AND status = 'pending'`.pipe(
        Effect.mapError(
          () => new HarnessError({ message: "Could not record root candidate failure." }),
        ),
      );
    }),
    // Merge the durable outbox and live updates without repeating a signal from both paths.
    stream: Stream.unwrap(
      Effect.sync(() => {
        const deliveredIds = new Set<string>();
        return Stream.merge(persistedStream(), Stream.fromPubSub(changes)).pipe(
          Stream.filter((event) => {
            if (deliveredIds.has(event.id)) return false;
            deliveredIds.add(event.id);
            if (deliveredIds.size > MAX_DEDUPE_IDS) {
              deliveredIds.delete(deliveredIds.values().next().value!);
            }
            return true;
          }),
        );
      }),
    ),
  });
});

export const layer = Layer.effect(HarnessSignificantEventStore, makeStore);
