import {
  PlotlineDag,
  PlotlineDagError,
  PlotlineDagListInput,
  PlotlineDagListResult,
  PlotlineDagSaveInput,
  PlotlineDagAddTasksInput,
  PlotlineDagUpdateTaskInput,
  PlotlineDagAddEventInput,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type PlotlineDagCreateInput,
  type PlotlineDag as PlotlineDagModel,
  type PlotlineDagTask,
  type PlotlineDagRecordVerificationInput as PlotlineDagRecordVerificationInputType,
  type PlotlineDagBeginCorrectionInput,
  type PlotlineDagLinkCorrectionInput,
  type PlotlineDagSettleCorrectionInput,
  type PlotlineDagUpdateVerifierRequestInput,
  type PlotlineCorrectionAttempt,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

const decodeDagJson = Schema.decodeUnknownSync(Schema.fromJsonString(PlotlineDag));
const encodeDagJson = Schema.encodeSync(Schema.fromJsonString(PlotlineDag));
const encodeJsonValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sameJsonValue = (left: unknown, right: unknown) =>
  left === undefined || right === undefined
    ? left === right
    : encodeJsonValue(left) === encodeJsonValue(right);
const validVerifierRequestTransition = (
  before: PlotlineCorrectionAttempt["verifierRequest"],
  after: PlotlineCorrectionAttempt["verifierRequest"],
) => {
  if (!before || !after) return before === after;
  const {
    state: beforeState,
    task: beforePrompt,
    promptVersion: beforePromptVersion,
    childTaskId: beforeTask,
    childThreadId: beforeThread,
    childRunId: beforeRun,
    retryCount: beforeRetry,
    persistenceFailures: beforeFailures,
    nextRetryAt: _beforeNextRetry,
    diagnostic: _beforeDiagnostic,
    commandId: beforeCommand,
    ...beforeImmutable
  } = before;
  const {
    state: afterState,
    task: afterPrompt,
    promptVersion: afterPromptVersion,
    childTaskId: afterTask,
    childThreadId: afterThread,
    childRunId: afterRun,
    retryCount: afterRetry,
    persistenceFailures: afterFailures,
    nextRetryAt: _afterNextRetry,
    diagnostic: _afterDiagnostic,
    commandId: afterCommand,
    ...afterImmutable
  } = after;
  if (!sameJsonValue(beforeImmutable, afterImmutable)) return false;
  const contextMigration =
    beforeState === "requested" &&
    afterState === "requested" &&
    beforePromptVersion === undefined &&
    afterPromptVersion === 2 &&
    afterCommand === beforeCommand &&
    (beforeRetry ?? 0) === (afterRetry ?? 0);
  if (
    !contextMigration &&
    (beforePrompt !== afterPrompt || beforePromptVersion !== afterPromptVersion)
  )
    return false;
  if (contextMigration)
    return (
      beforeTask === afterTask &&
      beforeThread === afterThread &&
      beforeRun === afterRun &&
      (beforeFailures ?? 0) === (afterFailures ?? 0)
    );
  if (
    (afterFailures ?? 0) !== (beforeFailures ?? 0) &&
    !(
      beforeState === "dispatched" &&
      afterState === "dispatched" &&
      (afterFailures ?? 0) === (beforeFailures ?? 0) + 1
    )
  )
    return false;
  const retry = afterState === "requested" && (afterRetry ?? 0) === (beforeRetry ?? 0) + 1;
  if (retry)
    return (
      (beforeState === "requested" || beforeState === "dispatched") &&
      ((afterCommand === beforeCommand && beforeState === "requested") ||
        afterCommand === `plotline-verifier-${before.correctionId}-retry-${afterRetry}`) &&
      afterTask === undefined &&
      afterThread === undefined &&
      afterRun === undefined
    );
  return (
    beforeCommand === afterCommand &&
    (beforeRetry ?? 0) === (afterRetry ?? 0) &&
    (beforeState === afterState ||
      (beforeState === "requested" && ["dispatched", "failed"].includes(afterState)) ||
      (beforeState === "dispatched" && ["completed", "failed"].includes(afterState))) &&
    (beforeTask === afterTask || (beforeTask === undefined && afterTask !== undefined)) &&
    (beforeThread === afterThread || (beforeThread === undefined && afterThread !== undefined)) &&
    (beforeRun === afterRun || (beforeRun === undefined && afterRun !== undefined))
  );
};
const isPlotlineDagError = Schema.is(PlotlineDagError);
const terminal = new Set(["done", "skipped"]);
const transitions: Record<string, ReadonlyArray<string>> = {
  pending: ["running", "done", "failed", "skipped"],
  running: ["done", "failed", "skipped"],
  failed: ["running", "skipped"],
  skipped: ["running"],
  done: [],
};
const makeVerifierRequest = (
  dag: PlotlineDagModel,
  task: PlotlineDagTask,
  correction: PlotlineCorrectionAttempt,
): PlotlineCorrectionAttempt["verifierRequest"] => {
  const owner = correction.dispatchInput as
    | Extract<OrchestrationV2ServerCommand, { type: "delegated_task.request" }>
    | undefined;
  if (
    !owner ||
    owner.parentThreadId === undefined ||
    owner.parentRunId === undefined ||
    owner.parentNodeId === undefined ||
    correction.childRunId === undefined
  )
    return correction.verifierRequest;
  return (
    correction.verifierRequest ?? {
      commandId: `plotline-verifier-${correction.id}`,
      parentThreadId: owner.parentThreadId,
      parentRunId: owner.parentRunId,
      parentNodeId: owner.parentNodeId,
      modelSelection: owner.modelSelection,
      runtimeMode: owner.runtimeMode,
      interactionMode: owner.interactionMode,
      completionWake: "always",
      criteriaVersion: task.criteriaVersion ?? 1,
      expectedRunId: correction.childRunId,
      correctionId: correction.id,
      state: "requested",
      promptVersion: 2,
      task: [
        `Independently verify task ${task.id} in project ${dag.projectId}, DAG ${dag.id}.`,
        `Working directory: ${dag.workspace ?? "Use the correction child thread working directory"}.`,
        `Task: ${task.title}\n${task.description}`,
        `Correction ${correction.id}, child thread ${correction.childThreadId ?? "unknown"}, run ${correction.childRunId}.`,
        ...(owner.task ? [`Correction instructions and relevant commands: ${owner.task}`] : []),
        "Use the supplied context and criteria directly; do not use Plotline MCP tools to discover the parent DAG.",
        `Evaluate every current acceptance criterion against run ${correction.childRunId}.`,
        "Return structured JSON with verdict (pass, fail, or inconclusive), a concise summary, and one result per criterion with criterionId, verdict, and reproducible evidence.",
        `Current criteria: ${encodeJsonValue(task.acceptanceCriteria ?? [])}`,
        "Do not modify the task or claim success without evidence.",
      ].join("\n\n"),
    }
  );
};

export class PlotlineDagService extends Context.Service<
  PlotlineDagService,
  {
    readonly list: (
      input: PlotlineDagListInput,
    ) => Effect.Effect<PlotlineDagListResult, PlotlineDagError>;
    readonly subscribe: (
      input: PlotlineDagListInput,
    ) => Stream.Stream<PlotlineDagListResult, PlotlineDagError>;
    readonly save: (
      input: PlotlineDagSaveInput,
    ) => Effect.Effect<PlotlineDagModel, PlotlineDagError>;
    readonly createForProject: (
      projectId: string,
      threadId: string,
      runId: string | null,
      input: PlotlineDagCreateInput,
    ) => Effect.Effect<PlotlineDagModel, PlotlineDagError>;
    readonly getForProject: (
      projectId: string,
      id: string,
    ) => Effect.Effect<PlotlineDagModel, PlotlineDagError>;
    readonly addTasks: (
      projectId: string,
      input: PlotlineDagAddTasksInput,
    ) => Effect.Effect<PlotlineDagModel, PlotlineDagError>;
    readonly updateTask: (
      projectId: string,
      input: PlotlineDagUpdateTaskInput,
    ) => Effect.Effect<PlotlineDagModel, PlotlineDagError>;
    readonly recordVerificationAttempt: (
      projectId: string,
      input: PlotlineDagRecordVerificationInputType,
    ) => Effect.Effect<PlotlineDagModel, PlotlineDagError>;
    readonly beginCorrection: (
      projectId: string,
      input: PlotlineDagBeginCorrectionInput,
    ) => Effect.Effect<
      {
        readonly dag: PlotlineDagModel;
        readonly correction: PlotlineCorrectionAttempt | null;
        readonly shouldDispatch: boolean;
        readonly escalated: boolean;
      },
      PlotlineDagError
    >;
    readonly linkCorrection: (
      projectId: string,
      input: PlotlineDagLinkCorrectionInput,
    ) => Effect.Effect<PlotlineDagModel, PlotlineDagError>;
    readonly settleCorrection: (
      projectId: string,
      input: PlotlineDagSettleCorrectionInput,
    ) => Effect.Effect<PlotlineDagModel, PlotlineDagError>;
    readonly updateVerifierRequest: (
      projectId: string,
      input: PlotlineDagUpdateVerifierRequestInput,
    ) => Effect.Effect<PlotlineDagModel, PlotlineDagError>;
    readonly reconcileRun: (
      threadId: string,
      runId: string,
      status: "running" | "completed" | "failed",
    ) => Effect.Effect<void, PlotlineDagError>;
    readonly addEvent: (
      projectId: string,
      input: PlotlineDagAddEventInput,
    ) => Effect.Effect<PlotlineDagModel, PlotlineDagError>;
    readonly delete: (id: string, confirm: boolean) => Effect.Effect<void, PlotlineDagError>;
  }
>()("t3/plotline/PlotlineDagService") {}

function dagError(message: string, dagId?: string): PlotlineDagError {
  return new PlotlineDagError({ message, ...(dagId === undefined ? {} : { dagId }) });
}

function appendEvent(
  dag: PlotlineDagModel,
  id: string,
  at: string,
  message: string,
  level: "info" | "live" | "ok" | "error" = "info",
  taskId: string | null = null,
): PlotlineDagModel {
  return {
    ...dag,
    events: [{ id, at, level, message: message.slice(0, 500), taskId }, ...dag.events].slice(
      0,
      200,
    ),
  };
}

function deriveState(tasks: ReadonlyArray<PlotlineDagTask>): PlotlineDagModel["state"] {
  if (tasks.some((task) => task.state === "failed")) return "failed";
  if (tasks.some((task) => task.state === "running")) return "running";
  if (tasks.length > 0 && tasks.every((task) => terminal.has(task.state))) return "done";
  return "waiting";
}

const MAX_VERIFICATION_ATTEMPTS = 100;
const MAX_CORRECTION_CYCLES = 3;

function sameVerificationAttemptContent(
  stored: {
    readonly attemptId: string;
    readonly verdict: string;
    readonly summary: string;
    readonly criteriaVersion?: number | undefined;
    readonly runId?: string | undefined;
    readonly criterionResults: ReadonlyArray<{
      readonly criterionId: string;
      readonly verdict: string;
      readonly evidence: string;
    }>;
  },
  input: PlotlineDagRecordVerificationInputType,
): boolean {
  return (
    stored.attemptId === input.attemptId &&
    stored.verdict === input.verdict &&
    stored.summary === input.summary &&
    stored.criteriaVersion === input.expectedCriteriaVersion &&
    stored.runId === (input.expectedRunId ?? undefined) &&
    stored.criterionResults.length === input.criterionResults.length &&
    stored.criterionResults.every(
      (result, index) =>
        result.criterionId === input.criterionResults[index]?.criterionId &&
        result.verdict === input.criterionResults[index]?.verdict &&
        result.evidence === input.criterionResults[index]?.evidence,
    )
  );
}

const nextUpdatedAt = (previous: string | undefined, now: string) =>
  previous !== undefined && now <= previous
    ? DateTime.formatIso(
        DateTime.toUtc(DateTime.add(DateTime.makeUnsafe(previous), { milliseconds: 1 })),
      )
    : now;

function taskRunLinksChanged(before: PlotlineDagModel, after: PlotlineDagModel): boolean {
  return (
    before.tasks.length !== after.tasks.length ||
    before.tasks.some((task, index) => {
      const next = after.tasks[index];
      return (
        next === undefined ||
        task.id !== next.id ||
        task.threadId !== next.threadId ||
        task.runId !== next.runId
      );
    })
  );
}

function validateDag(dag: PlotlineDagModel, previous?: PlotlineDagModel): PlotlineDagError | null {
  const ids = new Set<string>();
  for (const task of dag.tasks) {
    if (ids.has(task.id)) return dagError(`Duplicate task id: ${task.id}`, dag.id);
    ids.add(task.id);
    if (!Number.isInteger(task.effort) || task.effort < 1 || task.effort > 5)
      return dagError(`Task effort must be an integer from 1 to 5: ${task.id}`, dag.id);
    const criterionIds = new Set<string>();
    for (const criterion of task.acceptanceCriteria ?? []) {
      if (!criterion.id || criterionIds.has(criterion.id))
        return dagError(`Duplicate or empty acceptance criterion id for task ${task.id}`, dag.id);
      criterionIds.add(criterion.id);
    }
    const corrections = task.correctionAttempts ?? [];
    if (corrections.length > MAX_CORRECTION_CYCLES)
      return dagError(`Task ${task.id} exceeds the correction cycle limit.`, dag.id);
    const correctionIds = new Set<string>();
    const correctedVerificationIds = new Set<string>();
    for (const [index, correction] of corrections.entries()) {
      const verification = task.verificationAttempts?.find(
        (attempt) => attempt.attemptId === correction.verificationAttemptId,
      );
      if (
        correctionIds.has(correction.id) ||
        correctedVerificationIds.has(correction.verificationAttemptId) ||
        correction.attempt !== index + 1 ||
        verification === undefined ||
        verification.verdict !== "fail" ||
        (!["requested", "failed"].includes(correction.state) &&
          (correction.childTaskId === undefined ||
            correction.childThreadId === undefined ||
            correction.childRunId === undefined))
      )
        return dagError(`Invalid correction attempt history for task ${task.id}.`, dag.id);
      correctionIds.add(correction.id);
      correctedVerificationIds.add(correction.verificationAttemptId);
    }
  }
  const byId = new Map(dag.tasks.map((task) => [task.id, task]));
  for (const task of dag.tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id || !byId.has(dependency))
        return dagError(`Invalid dependency ${dependency} for task ${task.id}`, dag.id);
      const parent = byId.get(dependency)!;
      if ((task.state === "running" || task.state === "done") && !terminal.has(parent.state))
        return dagError(`Task ${task.id} has an unfinished dependency: ${dependency}`, dag.id);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visited.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  for (const id of ids) {
    if (!visit(id)) return dagError(`Circular task dependency at ${id}`, dag.id);
  }
  if (previous) {
    const oldTasks = new Map(previous.tasks.map((task) => [task.id, task]));
    for (const task of dag.tasks) {
      const old = oldTasks.get(task.id);
      const invalidTransition =
        old &&
        old.state !== task.state &&
        !transitions[old.state]?.includes(task.state) &&
        !(
          old.state === "done" &&
          task.state === "pending" &&
          ((task.criteriaVersion ?? 1) > (old.criteriaVersion ?? 1) ||
            ((task.criteriaVersion ?? 1) === (old.criteriaVersion ?? 1) &&
              (task.verificationAttempts?.length ?? 0) > (old.verificationAttempts?.length ?? 0) &&
              task.verificationAttempts
                ?.filter(
                  (attempt) => (attempt.criteriaVersion ?? 1) === (task.criteriaVersion ?? 1),
                )
                .at(-1)?.verdict !== "pass"))
        );
      if (invalidTransition)
        return dagError(`Invalid task transition ${old.state} → ${task.state}: ${task.id}`, dag.id);
      const oldCorrections = old?.correctionAttempts ?? [];
      const nextCorrections = task.correctionAttempts ?? [];
      if (nextCorrections.length < oldCorrections.length)
        return dagError(`Correction history cannot be removed: ${task.id}`, dag.id);
      for (let index = 0; index < oldCorrections.length; index += 1) {
        const before = oldCorrections[index]!;
        const after = nextCorrections[index]!;
        const validCorrectionTransition =
          before.state === after.state ||
          (before.state === "requested" && ["running", "failed"].includes(after.state)) ||
          (before.state === "running" &&
            ["completed", "failed", "cancelled", "interrupted"].includes(after.state));
        if (
          before.id !== after.id ||
          before.attempt !== after.attempt ||
          before.verificationAttemptId !== after.verificationAttemptId ||
          before.createdAt !== after.createdAt ||
          !validCorrectionTransition ||
          (before.dispatchInput !== undefined &&
            !sameJsonValue(before.dispatchInput, after.dispatchInput)) ||
          (before.verifierRequest !== undefined &&
            !validVerifierRequestTransition(before.verifierRequest, after.verifierRequest)) ||
          (before.verifierRequest === undefined &&
            after.verifierRequest !== undefined &&
            after.state !== "completed") ||
          (before.childTaskId !== undefined && before.childTaskId !== after.childTaskId) ||
          (before.childThreadId !== undefined && before.childThreadId !== after.childThreadId) ||
          (before.childRunId !== undefined && before.childRunId !== after.childRunId)
        )
          return dagError(`Correction history is immutable: ${task.id}`, dag.id);
      }
      if (nextCorrections.some((attempt, index) => attempt.attempt !== index + 1))
        return dagError(`Correction attempts must be sequential: ${task.id}`, dag.id);
    }
  }
  return null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.sliding<void>(1);
  const mutationLock = yield* Semaphore.make(1);
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const syncTaskRunIndex = Effect.fn("PlotlineDagService.syncTaskRunIndex")(function* (
    dag: PlotlineDagModel,
  ) {
    yield* sql`DELETE FROM plotline_task_run_index WHERE dag_id = ${dag.id}`;
    for (const task of dag.tasks) {
      if (task.threadId === null || task.runId === null) continue;
      yield* sql`INSERT INTO plotline_task_run_index (project_id, dag_id, task_id, thread_id, run_id)
          VALUES (${dag.projectId}, ${dag.id}, ${task.id}, ${task.threadId}, ${task.runId})`;
    }
  });

  const list: PlotlineDagService["Service"]["list"] = Effect.fn("PlotlineDagService.list")(
    function* (input: PlotlineDagListInput) {
      const rows = yield* (
        input.projectId === undefined
          ? sql<{
              readonly payload_json: string;
            }>`SELECT payload_json FROM plotline_dags ORDER BY updated_at DESC`
          : sql<{
              readonly payload_json: string;
            }>`SELECT payload_json FROM plotline_dags WHERE project_id = ${input.projectId} ORDER BY updated_at DESC`
      ).pipe(Effect.mapError(() => dagError("Could not read saved DAG data.")));
      const dags = yield* Effect.forEach(rows, (row) =>
        Effect.try({
          try: () => decodeDagJson(row.payload_json),
          catch: () => dagError("Could not read saved DAG data."),
        }),
      );
      return { dags };
    },
  );

  const subscribe: PlotlineDagService["Service"]["subscribe"] = (input) =>
    Stream.concat(
      Stream.fromEffect(list(input)),
      Stream.fromPubSub(changes).pipe(Stream.mapEffect(() => list(input))),
    );

  const saveInternal = Effect.fn("PlotlineDagService.save")(function* (
    input: PlotlineDagSaveInput,
  ) {
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const oldRows = yield* sql<{
            readonly payload_json: string;
          }>`SELECT payload_json FROM plotline_dags WHERE dag_id = ${input.dag.id}`.pipe(
            Effect.mapError(() => dagError("Could not read saved DAG data.", input.dag.id)),
          );
          const previous = oldRows[0]
            ? yield* Effect.try({
                try: () => decodeDagJson(oldRows[0]!.payload_json),
                catch: () => dagError("Saved DAG data is invalid.", input.dag.id),
              })
            : undefined;
          if (previous && input.dag.updatedAt !== previous.updatedAt)
            return yield* dagError(
              "DAG changed since it was loaded. Reload it before saving.",
              input.dag.id,
            );
          const base: PlotlineDagModel = {
            ...input.dag,
            createdAt: previous?.createdAt ?? input.dag.createdAt,
            events: previous?.events ?? input.dag.events,
          };
          const validationError = validateDag(base, previous);
          if (validationError) return yield* validationError;

          const now = nextUpdatedAt(
            previous?.updatedAt,
            DateTime.formatIso(DateTime.toUtc(yield* DateTime.now)),
          );
          const state = deriveState(base.tasks);
          const next: PlotlineDagModel = {
            ...base,
            state,
            updatedAt: now,
            startedAt: state === "waiting" ? null : (base.startedAt ?? now),
            finishedAt: state === "done" || state === "failed" ? now : null,
            tasks: base.tasks.map((task) => {
              const old = previous?.tasks.find((candidate) => candidate.id === task.id);
              if (old?.state === task.state) return task;
              return {
                ...task,
                startedAt: task.state === "running" ? now : task.startedAt,
                finishedAt: terminal.has(task.state) || task.state === "failed" ? now : null,
              };
            }),
          };
          const withEvent = appendEvent(
            next,
            `evt_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
            now,
            previous ? "DAG updated." : `DAG created with ${next.tasks.length} task(s).`,
            previous ? "info" : "ok",
          );
          const payload = encodeDagJson(withEvent);
          yield* sql`
        INSERT INTO plotline_dags (dag_id, project_id, payload_json, updated_at)
        VALUES (${withEvent.id}, ${withEvent.projectId}, ${payload}, ${now})
        ON CONFLICT(dag_id) DO UPDATE SET
          project_id = excluded.project_id,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(() => dagError("Could not save DAG data.", withEvent.id)));
          yield* syncTaskRunIndex(withEvent);
          return withEvent;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPlotlineDagError(error) ? error : dagError("Could not save DAG data.", input.dag.id),
        ),
      );
    yield* notify;
    return result;
  });
  const save: PlotlineDagService["Service"]["save"] = (input) =>
    mutationLock.withPermits(1)(saveInternal(input));

  const getForProject: PlotlineDagService["Service"]["getForProject"] = Effect.fn(
    "PlotlineDagService.getForProject",
  )(function* (projectId: string, id: string) {
    const result = yield* list({ projectId });
    const dag = result.dags.find((item) => item.id === id);
    return dag ?? (yield* dagError("DAG was not found in the current project.", id));
  });

  const createForProjectInternal = Effect.fn("PlotlineDagService.createForProject")(function* (
    projectId: string,
    threadId: string,
    runId: string | null,
    input: PlotlineDagCreateInput,
  ) {
    const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
    const id =
      runId === null
        ? `dag_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`
        : `dag_${threadId}_${runId}`;
    if (runId !== null) {
      const result = yield* list({ projectId });
      const existing = result.dags.find((dag) => dag.id === id);
      if (existing) return existing;
    }
    const dag: PlotlineDagModel = {
      id,
      projectId,
      originatingThreadId: ThreadId.make(threadId),
      title: input.title,
      description: input.description,
      workspace: null,
      state: "waiting",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      tasks: [],
      events: [],
    };
    const withEvent = appendEvent(
      dag,
      `evt_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
      now,
      `DAG created from thread ${threadId}.`,
      "ok",
    );
    yield* sql`INSERT INTO plotline_dags (dag_id, project_id, payload_json, updated_at) VALUES (${id}, ${projectId}, ${encodeDagJson(withEvent)}, ${now}) ON CONFLICT(dag_id) DO NOTHING`.pipe(
      Effect.mapError(() => dagError("Could not create DAG data.", id)),
    );
    const persisted = (yield* list({ projectId })).dags.find((dag) => dag.id === id) ?? withEvent;
    yield* notify;
    return persisted;
  });
  const createForProject: PlotlineDagService["Service"]["createForProject"] = (...args) =>
    mutationLock.withPermits(1)(createForProjectInternal(...args));

  const mutate: (
    projectId: string,
    dagId: string,
    operation: (dag: PlotlineDagModel) => Effect.Effect<PlotlineDagModel, PlotlineDagError>,
  ) => Effect.Effect<PlotlineDagModel, PlotlineDagError> = (projectId, dagId, operation) =>
    mutationLock.withPermits(1)(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const dag = yield* getForProject(projectId, dagId);
            const next = yield* operation(dag);
            if (next === dag) return dag;
            const validationError = validateDag(next, dag);
            if (validationError) return yield* validationError;
            const now = nextUpdatedAt(
              dag.updatedAt,
              DateTime.formatIso(DateTime.toUtc(yield* DateTime.now)),
            );
            const saved: PlotlineDagModel = {
              ...next,
              state: deriveState(next.tasks),
              updatedAt: now,
              startedAt: deriveState(next.tasks) === "waiting" ? null : (dag.startedAt ?? now),
              finishedAt: ["done", "failed"].includes(deriveState(next.tasks)) ? now : null,
            };
            const withEvent = { ...saved, events: saved.events };
            yield* sql`UPDATE plotline_dags SET payload_json = ${encodeDagJson(withEvent)}, updated_at = ${now} WHERE dag_id = ${dagId} AND project_id = ${projectId}`.pipe(
              Effect.mapError(() => dagError("Could not update DAG data.", dagId)),
            );
            if (taskRunLinksChanged(dag, withEvent)) yield* syncTaskRunIndex(withEvent);
            return withEvent;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            isPlotlineDagError(error) ? error : dagError("Could not update DAG data.", dagId),
          ),
          Effect.tap(() => notify),
        ),
    );

  const addTasks: PlotlineDagService["Service"]["addTasks"] = (projectId, input) =>
    mutate(projectId, input.dagId, (dag) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
        const tasks: PlotlineDagTask[] = [];
        for (const inputTask of input.tasks) {
          const old = dag.tasks.find((task) => task.id === inputTask.id);
          if (old) {
            if (
              old.title !== inputTask.title ||
              old.description !== inputTask.description ||
              old.effort !== inputTask.effort ||
              old.dependsOn.join("\0") !== inputTask.dependsOn.join("\0")
            )
              return yield* dagError(
                `Task id already exists with different content: ${inputTask.id}`,
                dag.id,
              );
            continue;
          }
          tasks.push({
            ...inputTask,
            state: "pending",
            threadId: null,
            runId: null,
            legacySessionIds: [],
            acceptanceCriteria: [],
            verificationAttempts: [],
            criteriaVersion: 1,
            agent: null,
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            finishedAt: null,
          });
        }
        if (tasks.length === 0) return dag;
        return appendEvent(
          { ...dag, tasks: [...dag.tasks, ...tasks] },
          `evt_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          now,
          `Added ${tasks.length} task(s).`,
          "info",
        );
      }),
    );

  const updateTask: PlotlineDagService["Service"]["updateTask"] = (projectId, input) =>
    mutate(projectId, input.dagId, (dag) =>
      Effect.gen(function* () {
        const current = dag.tasks.find((task) => task.id === input.taskId);
        if (!current) return yield* dagError("Task was not found in this DAG.", dag.id);
        const criteriaChanged =
          input.acceptanceCriteria !== undefined &&
          (input.acceptanceCriteria.length !== (current.acceptanceCriteria ?? []).length ||
            !input.acceptanceCriteria.every(
              (criterion, index) =>
                criterion.id === current.acceptanceCriteria?.[index]?.id &&
                criterion.description === current.acceptanceCriteria?.[index]?.description,
            ));
        const nextCriteria = input.acceptanceCriteria ?? current.acceptanceCriteria ?? [];
        const nextCriteriaVersion = (current.criteriaVersion ?? 1) + (criteriaChanged ? 1 : 0);
        if (criteriaChanged && current.state === "done") {
          const descendants = new Set<string>([current.id]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const candidate of dag.tasks) {
              if (
                !descendants.has(candidate.id) &&
                candidate.dependsOn.some((id) => descendants.has(id))
              ) {
                descendants.add(candidate.id);
                changed = true;
              }
            }
          }
          if (
            dag.tasks.some(
              (candidate) =>
                descendants.has(candidate.id) &&
                candidate.id !== current.id &&
                (candidate.state === "running" || candidate.state === "done"),
            )
          )
            return yield* dagError(
              `Acceptance criteria for completed prerequisite ${current.id} cannot change while a dependent is running or done.`,
              dag.id,
            );
        }
        if (input.state === "done" && nextCriteria.length > 0) {
          const latestAttempt = (current.verificationAttempts ?? [])
            .filter(
              (attempt) =>
                (attempt.criteriaVersion ?? 1) === nextCriteriaVersion &&
                attempt.runId === (current.runId ?? undefined),
            )
            .at(-1);
          const verified =
            latestAttempt?.verdict === "pass" &&
            latestAttempt.criterionResults.length === nextCriteria.length &&
            nextCriteria.every((criterion) =>
              latestAttempt.criterionResults.some(
                (result) => result.criterionId === criterion.id && result.verdict === "pass",
              ),
            );
          if (!verified)
            return yield* dagError(
              `Task ${current.id} requires a passing verification for its current acceptance criteria.`,
              dag.id,
            );
        }
        const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
        const task = {
          ...current,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
          ...(input.state === undefined
            ? criteriaChanged && current.state === "done"
              ? { state: "pending" as const }
              : {}
            : { state: input.state }),
          ...(input.state === "running" ||
          (input.runId !== undefined && input.runId !== current.runId)
            ? { executionLifecycle: "executing" as const }
            : criteriaChanged
              ? { executionLifecycle: "awaiting_verification" as const }
              : input.state === "failed"
                ? { executionLifecycle: "failed_escalated" as const }
                : {}),
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          ...(input.acceptanceCriteria === undefined
            ? {}
            : {
                acceptanceCriteria: input.acceptanceCriteria,
                criteriaVersion:
                  input.acceptanceCriteria.length === (current.acceptanceCriteria ?? []).length &&
                  input.acceptanceCriteria.every(
                    (criterion, index) =>
                      criterion.id === current.acceptanceCriteria?.[index]?.id &&
                      criterion.description === current.acceptanceCriteria?.[index]?.description,
                  )
                    ? (current.criteriaVersion ?? 1)
                    : (current.criteriaVersion ?? 1) + 1,
              }),
          updatedAt: now,
          ...(input.state === undefined || input.state === current.state
            ? criteriaChanged && current.state === "done"
              ? { finishedAt: null }
              : {}
            : {
                startedAt:
                  input.state === "running" ? (current.startedAt ?? now) : current.startedAt,
                finishedAt: terminal.has(input.state) || input.state === "failed" ? now : null,
              }),
        };
        if (
          [
            "title",
            "description",
            "effort",
            "dependsOn",
            "state",
            "threadId",
            "runId",
            "agent",
            "acceptanceCriteria",
          ].every(
            (key) =>
              input[key as keyof typeof input] === undefined ||
              input[key as keyof typeof input] === current[key as keyof typeof current],
          )
        )
          return dag;
        const next = {
          ...dag,
          tasks: dag.tasks.map((item) => (item.id === task.id ? task : item)),
        };
        return appendEvent(
          next,
          `evt_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          task.updatedAt,
          `Updated task ${task.id}.`,
          "info",
          task.id,
        );
      }),
    );

  const recordVerificationAttempt: PlotlineDagService["Service"]["recordVerificationAttempt"] = (
    projectId,
    input,
  ) =>
    mutate(projectId, input.dagId, (dag) =>
      Effect.gen(function* () {
        const task = dag.tasks.find((item) => item.id === input.taskId);
        if (!task) return yield* dagError("Task was not found in this DAG.", dag.id);
        if (input.expectedCriteriaVersion !== (task.criteriaVersion ?? 1))
          return yield* dagError(
            "Verification submission is stale for the current acceptance criteria.",
            dag.id,
          );
        if (input.expectedRunId !== (task.runId ?? null))
          return yield* dagError(
            "Verification submission is stale for the current task run.",
            dag.id,
          );
        const attempts = task.verificationAttempts ?? [];
        const existing = attempts.find((item) => item.attemptId === input.attemptId);
        const attemptData = {
          attemptId: input.attemptId,
          verdict: input.verdict,
          summary: input.summary,
          criterionResults: input.criterionResults,
        };
        if (existing) {
          if (!sameVerificationAttemptContent(existing, input))
            return yield* dagError(
              `Verification attempt id already exists with different content: ${input.attemptId}`,
              dag.id,
            );
          if ((existing.criteriaVersion ?? 1) !== (task.criteriaVersion ?? 1))
            return yield* dagError(
              `Verification attempt is stale for the current acceptance criteria: ${input.attemptId}`,
              dag.id,
            );
          if (existing.runId !== (task.runId ?? undefined))
            return yield* dagError(
              `Verification attempt is stale for the current task run: ${input.attemptId}`,
              dag.id,
            );
          return dag;
        }
        if (attempts.length >= MAX_VERIFICATION_ATTEMPTS)
          return yield* dagError(
            `Task ${task.id} already has the maximum of ${MAX_VERIFICATION_ATTEMPTS} verification attempts.`,
            dag.id,
          );
        const criterionIds = new Set(
          (task.acceptanceCriteria ?? []).map((criterion) => criterion.id),
        );
        if (input.verdict === "pass" && criterionIds.size === 0)
          return yield* dagError("A passing verification requires acceptance criteria.", dag.id);
        const resultIds = new Set<string>();
        for (const result of input.criterionResults) {
          if (!criterionIds.has(result.criterionId) || resultIds.has(result.criterionId))
            return yield* dagError(
              `Invalid or duplicate acceptance criterion result: ${result.criterionId}`,
              dag.id,
            );
          resultIds.add(result.criterionId);
        }
        if (
          input.verdict === "pass" &&
          (resultIds.size !== criterionIds.size ||
            input.criterionResults.some((result) => result.verdict !== "pass"))
        )
          return yield* dagError(
            "A passing verification must include a passing result for every acceptance criterion.",
            dag.id,
          );
        const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
        const attempt = {
          id: `ver_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          ...attemptData,
          criteriaVersion: input.expectedCriteriaVersion,
          ...(input.expectedRunId === null ? {} : { runId: input.expectedRunId }),
          createdAt: now,
        };
        if (task.state === "done" && input.verdict !== "pass") {
          const descendants = new Set<string>([task.id]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const candidate of dag.tasks) {
              if (
                !descendants.has(candidate.id) &&
                candidate.dependsOn.some((id) => descendants.has(id))
              ) {
                descendants.add(candidate.id);
                changed = true;
              }
            }
          }
          if (
            dag.tasks.some(
              (candidate) =>
                descendants.has(candidate.id) &&
                candidate.id !== task.id &&
                (candidate.state === "running" || candidate.state === "done"),
            )
          )
            return yield* dagError(
              `Cannot record a non-passing verification for completed task ${task.id} while a dependent is running or done.`,
              dag.id,
            );
        }
        return {
          ...dag,
          tasks: dag.tasks.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  ...(item.state === "done" && input.verdict !== "pass"
                    ? { state: "pending" as const, finishedAt: null }
                    : {}),
                  verificationAttempts: [...(item.verificationAttempts ?? []), attempt],
                  executionLifecycle:
                    input.verdict === "pass"
                      ? ("verification_passed" as const)
                      : input.verdict === "fail"
                        ? ("verification_failed" as const)
                        : ("awaiting_verification" as const),
                  updatedAt: now,
                }
              : item,
          ),
        };
      }),
    );

  const beginCorrection: PlotlineDagService["Service"]["beginCorrection"] = Effect.fn(
    "PlotlineDagService.beginCorrection",
  )(function* (projectId, input) {
    let correction: PlotlineCorrectionAttempt | null = null;
    let shouldDispatch = false;
    let escalated = false;
    const dag = yield* mutate(projectId, input.dagId, (currentDag) =>
      Effect.gen(function* () {
        const task = currentDag.tasks.find((item) => item.id === input.taskId);
        if (!task) return yield* dagError("Task was not found in this DAG.", currentDag.id);
        if (
          (task.criteriaVersion ?? 1) !== input.expectedCriteriaVersion ||
          (task.runId ?? null) !== input.expectedRunId
        )
          return yield* dagError(
            "Correction request is stale for the current task criteria or run.",
            currentDag.id,
          );
        const verification = task.verificationAttempts?.find(
          (attempt) => attempt.attemptId === input.verificationAttemptId,
        );
        if (
          verification === undefined ||
          verification.verdict !== "fail" ||
          (verification.criteriaVersion ?? 1) !== input.expectedCriteriaVersion ||
          verification.runId !== (input.expectedRunId ?? undefined)
        )
          return yield* dagError(
            "A current failed verification is required to correct this task.",
            currentDag.id,
          );

        const attempts = task.correctionAttempts ?? [];
        const existing = attempts.find(
          (attempt) => attempt.verificationAttemptId === input.verificationAttemptId,
        );
        if (existing) {
          correction = existing;
          shouldDispatch = existing.state === "requested";
          return currentDag;
        }
        const lastCorrection = attempts.at(-1);
        if (
          lastCorrection &&
          (lastCorrection.state === "failed" ||
            lastCorrection.state === "cancelled" ||
            lastCorrection.state === "interrupted")
        ) {
          escalated = true;
          const marker = `Correction stopped after delegated run ${lastCorrection.childRunId ?? "unknown"} ended ${lastCorrection.state}.`;
          const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
          const escalatedDag = {
            ...currentDag,
            tasks: currentDag.tasks.map((item) =>
              item.id === task.id
                ? {
                    ...item,
                    state: "failed" as const,
                    executionLifecycle: "failed_escalated" as const,
                    finishedAt: now,
                    updatedAt: now,
                  }
                : item,
            ),
          };
          return currentDag.events.some((event) => event.message === marker)
            ? escalatedDag
            : appendEvent(
                escalatedDag,
                `evt_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
                now,
                marker,
                "error",
                task.id,
              );
        }
        if (attempts.length >= MAX_CORRECTION_CYCLES) {
          escalated = true;
          const marker = `Correction limit reached for verification ${input.verificationAttemptId}.`;
          const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
          const escalatedDag = {
            ...currentDag,
            tasks: currentDag.tasks.map((item) =>
              item.id === task.id
                ? {
                    ...item,
                    state: "failed" as const,
                    executionLifecycle: "failed_escalated" as const,
                    finishedAt: now,
                    updatedAt: now,
                  }
                : item,
            ),
          };
          return currentDag.events.some((event) => event.message === marker)
            ? escalatedDag
            : appendEvent(
                escalatedDag,
                `evt_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
                now,
                marker,
                "error",
                task.id,
              );
        }
        const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
        correction = {
          id: `cor_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          verificationAttemptId: input.verificationAttemptId,
          attempt: attempts.length + 1,
          state: "requested",
          ...(input.dispatchInput === undefined ? {} : { dispatchInput: input.dispatchInput }),
          createdAt: now,
          updatedAt: now,
        };
        shouldDispatch = true;
        const nextTask = {
          ...task,
          executionLifecycle: "correction_in_progress" as const,
          correctionAttempts: [...attempts, correction],
          updatedAt: now,
        };
        return appendEvent(
          {
            ...currentDag,
            tasks: currentDag.tasks.map((item) => (item.id === task.id ? nextTask : item)),
          },
          `evt_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          now,
          `Correction ${correction.attempt} requested for task ${task.id}.`,
          "live",
          task.id,
        );
      }),
    );
    return { dag, correction, shouldDispatch, escalated };
  });

  const linkCorrection: PlotlineDagService["Service"]["linkCorrection"] = (projectId, input) =>
    mutate(projectId, input.dagId, (dag) =>
      Effect.gen(function* () {
        const task = dag.tasks.find((item) => item.id === input.taskId);
        if (!task) return yield* dagError("Task was not found in this DAG.", dag.id);
        const attempts = task.correctionAttempts ?? [];
        const index = attempts.findIndex((attempt) => attempt.id === input.correctionId);
        if (index < 0) return yield* dagError("Correction attempt was not found.", dag.id);
        const current = attempts[index]!;
        if (current.childTaskId !== undefined) {
          if (
            current.childTaskId !== input.childTaskId ||
            current.childThreadId !== input.childThreadId ||
            current.childRunId !== input.childRunId
          )
            return yield* dagError(
              "Correction attempt is already linked to a different delegated run.",
              dag.id,
            );
          yield* sql`UPDATE harness_opencode_reconciliation
            SET status = 'pending', next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE event_kind = 'correction_child' AND thread_id = ${input.childThreadId}
              AND run_id = ${input.childRunId} AND status IN ('awaiting_link', 'delivering')`.pipe(
            Effect.mapError(() =>
              dagError("Could not requeue terminal correction deliveries.", dag.id),
            ),
          );
          return dag;
        }
        if (current.state !== "requested")
          return yield* dagError(
            "Only a requested correction can be linked to a delegated run.",
            dag.id,
          );
        const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
        const linked = {
          ...current,
          state: "running" as const,
          childTaskId: input.childTaskId,
          childThreadId: input.childThreadId,
          childRunId: input.childRunId,
          updatedAt: now,
        };
        yield* sql`UPDATE harness_opencode_reconciliation
          SET status = 'pending', next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE event_kind = 'correction_child' AND thread_id = ${input.childThreadId}
            AND run_id = ${input.childRunId} AND status IN ('awaiting_link', 'delivering')`.pipe(
          Effect.mapError(() =>
            dagError("Could not requeue terminal correction deliveries.", dag.id),
          ),
        );
        return appendEvent(
          {
            ...dag,
            tasks: dag.tasks.map((item) =>
              item.id !== task.id
                ? item
                : {
                    ...item,
                    state: "running" as const,
                    executionLifecycle: "correction_in_progress" as const,
                    threadId: input.childThreadId,
                    runId: input.childRunId,
                    startedAt: item.startedAt ?? now,
                    finishedAt: null,
                    updatedAt: now,
                    correctionAttempts: attempts.map((attempt, position) =>
                      position === index ? linked : attempt,
                    ),
                  },
            ),
          },
          `evt_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          now,
          `Correction ${linked.attempt} started as delegated task ${input.childTaskId}.`,
          "live",
          task.id,
        );
      }),
    );

  const settleCorrection: PlotlineDagService["Service"]["settleCorrection"] = (projectId, input) =>
    mutate(projectId, input.dagId, (dag) =>
      Effect.gen(function* () {
        const task = dag.tasks.find((item) => item.id === input.taskId);
        if (!task) return yield* dagError("Task was not found in this DAG.", dag.id);
        const attempts = task.correctionAttempts ?? [];
        const index = attempts.findIndex((attempt) => attempt.id === input.correctionId);
        if (index < 0) return yield* dagError("Correction attempt was not found.", dag.id);
        const current = attempts[index]!;
        if (current.state === input.state) {
          if (input.state !== "completed" || current.verifierRequest !== undefined) return dag;
          const verifierRequest = makeVerifierRequest(dag, task, current);
          if (verifierRequest === undefined) return dag;
          const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
          return {
            ...dag,
            tasks: dag.tasks.map((item) =>
              item.id !== task.id
                ? item
                : {
                    ...item,
                    correctionAttempts: attempts.map((attempt, position) =>
                      position === index
                        ? { ...attempt, verifierRequest, updatedAt: now }
                        : attempt,
                    ),
                    updatedAt: now,
                  },
            ),
          };
        }
        if (
          current.state !== "running" &&
          !(current.state === "requested" && input.state === "failed")
        )
          return yield* dagError("Only a running correction can be settled.", dag.id);
        const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
        const verifierRequest =
          input.state === "completed"
            ? makeVerifierRequest(dag, task, current)
            : current.verifierRequest;
        const settled = {
          ...current,
          state: input.state,
          ...(verifierRequest === undefined ? {} : { verifierRequest }),
          updatedAt: now,
        };
        const nextTaskState = input.state === "completed" ? "running" : "failed";
        return appendEvent(
          {
            ...dag,
            tasks: dag.tasks.map((item) =>
              item.id !== task.id
                ? item
                : {
                    ...item,
                    state: nextTaskState,
                    executionLifecycle:
                      input.state === "completed"
                        ? ("awaiting_verification" as const)
                        : ("failed_escalated" as const),
                    correctionAttempts: attempts.map((attempt, position) =>
                      position === index ? settled : attempt,
                    ),
                    finishedAt: nextTaskState === "failed" ? now : null,
                    updatedAt: now,
                  },
            ),
          },
          `evt_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          now,
          `Correction ${current.attempt} ended ${input.state}.`,
          input.state === "completed" ? "ok" : "error",
          task.id,
        );
      }),
    );

  const updateVerifierRequest: PlotlineDagService["Service"]["updateVerifierRequest"] = (
    projectId,
    input,
  ) =>
    mutate(projectId, input.dagId, (dag) =>
      Effect.gen(function* () {
        const task = dag.tasks.find((item) => item.id === input.taskId);
        if (!task) return yield* dagError("Task was not found in this DAG.", dag.id);
        const attempts = task.correctionAttempts ?? [];
        const index = attempts.findIndex((attempt) => attempt.id === input.correctionId);
        if (index < 0) return yield* dagError("Correction attempt was not found.", dag.id);
        const current = attempts[index]!;
        const request = current.verifierRequest;
        if (!request) return yield* dagError("Verifier request was not found.", dag.id);
        if (
          (input.expectedState !== undefined && input.expectedState !== request.state) ||
          (input.expectedPersistenceFailures !== undefined &&
            input.expectedPersistenceFailures !== (request.persistenceFailures ?? 0)) ||
          (input.expectedRetryCount !== undefined &&
            input.expectedRetryCount !== (request.retryCount ?? 0)) ||
          (input.expectedCommandId !== undefined &&
            input.expectedCommandId !== request.commandId) ||
          (input.expectedChildTaskId !== undefined &&
            input.expectedChildTaskId !== request.childTaskId)
        )
          return dag;
        if (
          input.state === "dispatched" &&
          (!input.childTaskId || !input.childThreadId || !input.childRunId)
        )
          return yield* dagError("A dispatched verifier requires its full child identity.", dag.id);
        if (
          input.state !== "failed" &&
          (request.criteriaVersion !== (task.criteriaVersion ?? 1) ||
            request.expectedRunId !== (task.runId ?? null))
        )
          return yield* dagError("Verifier request is stale for current criteria or run.", dag.id);
        const allowed =
          request.state === input.state ||
          (request.state === "requested" &&
            (input.state === "dispatched" || input.state === "failed")) ||
          (request.state === "dispatched" &&
            (input.state === "completed" ||
              input.state === "failed" ||
              input.state === "requested"));
        if (!allowed)
          return yield* dagError(
            `Invalid verifier request transition: ${request.state} -> ${input.state}.`,
            dag.id,
          );
        const retrying = input.state === "requested" && input.diagnostic !== undefined;
        const escalate =
          input.state === "failed" &&
          ["pending", "running"].includes(task.state) &&
          request.criteriaVersion === (task.criteriaVersion ?? 1) &&
          request.expectedRunId === task.runId;
        if (
          request.state === input.state &&
          !retrying &&
          !input.persistenceFailure &&
          !input.refreshContext &&
          !escalate
        ) {
          if (
            (input.childTaskId !== undefined && request.childTaskId !== input.childTaskId) ||
            (input.childThreadId !== undefined && request.childThreadId !== input.childThreadId) ||
            (input.childRunId !== undefined && request.childRunId !== input.childRunId)
          )
            return yield* dagError("Verifier request identity cannot be changed.", dag.id);
          return dag;
        }
        const currentTime = DateTime.toUtc(yield* DateTime.now);
        const now = DateTime.formatIso(currentTime);
        const {
          childTaskId: _task,
          childThreadId: _thread,
          childRunId: _run,
          ...retryBase
        } = request;
        const refreshed =
          input.refreshContext &&
          request.state === "requested" &&
          request.promptVersion === undefined
            ? makeVerifierRequest(dag, task, { ...current, verifierRequest: undefined })
            : undefined;
        if (input.refreshContext && !refreshed)
          return yield* dagError("Verifier context cannot be refreshed.", dag.id);
        const nextRequest = {
          ...(retrying ? retryBase : request),
          ...(refreshed
            ? {
                task: refreshed.task,
                promptVersion: 2,
              }
            : {}),
          ...(retrying
            ? {
                retryCount: (request.retryCount ?? 0) + 1,
                commandId:
                  request.state === "requested" && !input.replaceCommandId
                    ? request.commandId
                    : `plotline-verifier-${current.id}-retry-${(request.retryCount ?? 0) + 1}`,
              }
            : {}),
          ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
          ...(retrying || input.persistenceFailure
            ? { nextRetryAt: DateTime.formatIso(DateTime.add(currentTime, { seconds: 1 })) }
            : {}),
          ...(input.persistenceFailure
            ? { persistenceFailures: (request.persistenceFailures ?? 0) + 1 }
            : {}),
          state: input.state,
          ...(input.childTaskId === undefined ? {} : { childTaskId: input.childTaskId }),
          ...(input.childThreadId === undefined ? {} : { childThreadId: input.childThreadId }),
          ...(input.childRunId === undefined ? {} : { childRunId: input.childRunId }),
        };
        return {
          ...dag,
          tasks: dag.tasks.map((item) =>
            item.id !== task.id
              ? item
              : {
                  ...item,
                  ...(escalate
                    ? {
                        state: "failed" as const,
                        executionLifecycle: "failed_escalated" as const,
                        finishedAt: now,
                      }
                    : {}),
                  correctionAttempts: attempts.map((attempt, position) =>
                    position === index
                      ? { ...attempt, verifierRequest: nextRequest, updatedAt: now }
                      : attempt,
                  ),
                  updatedAt: now,
                },
          ),
        };
      }),
    );

  const addEvent: PlotlineDagService["Service"]["addEvent"] = (projectId, input) =>
    mutate(projectId, input.dagId, (dag) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
        if (input.taskId && !dag.tasks.some((task) => task.id === input.taskId))
          return yield* dagError("Task was not found in this DAG.", dag.id);
        return appendEvent(
          dag,
          `evt_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          now,
          input.message,
          input.level ?? "info",
          input.taskId ?? null,
        );
      }),
    );

  const reconcileRun: PlotlineDagService["Service"]["reconcileRun"] = (threadId, runId, status) =>
    mutationLock.withPermits(1)(
      sql
        .withTransaction(
          Effect.gen(function* () {
            let changedAny = false;
            const matches = yield* sql<{
              readonly dag_id: string;
              readonly project_id: string;
              readonly task_id: string;
            }>`
            SELECT dag_id, project_id, task_id FROM plotline_task_run_index
            WHERE thread_id = ${threadId} AND run_id = ${runId}
          `;
            for (const match of matches) {
              const rows = yield* sql<{
                readonly payload_json: string;
                readonly updated_at: string;
              }>`
              SELECT payload_json, updated_at FROM plotline_dags WHERE dag_id = ${match.dag_id} AND project_id = ${match.project_id}
            `;
              const row = rows[0];
              if (!row) continue;
              const dag = yield* Effect.try({
                try: () => decodeDagJson(row.payload_json),
                catch: () => dagError("Saved DAG data is invalid.", match.dag_id),
              });
              const current = dag.tasks.find((task) => task.id === match.task_id);
              if (
                !current ||
                current.threadId !== threadId ||
                current.runId !== runId ||
                current.state !== "running"
              )
                continue;
              // Provider completion is never acceptance verification, including legacy tasks without criteria.
              const nextState: PlotlineDagTask["state"] =
                status === "failed" ? "failed" : "running";
              const executionLifecycle =
                status === "running"
                  ? "executing"
                  : status === "completed"
                    ? "awaiting_verification"
                    : "failed_escalated";
              const hasRunningCorrection = current.correctionAttempts?.some(
                (attempt) =>
                  attempt.childThreadId === threadId &&
                  attempt.childRunId === runId &&
                  attempt.state === "running",
              );
              if (
                nextState === current.state &&
                current.finishedAt === null &&
                (status === "running" ||
                  (current.executionLifecycle === executionLifecycle && !hasRunningCorrection))
              )
                continue;
              const now = nextUpdatedAt(
                dag.updatedAt,
                DateTime.formatIso(DateTime.toUtc(yield* DateTime.now)),
              );
              const task: PlotlineDagTask = {
                ...current,
                state: nextState,
                executionLifecycle,
                updatedAt: now,
                finishedAt: nextState === "running" ? null : now,
                correctionAttempts: current.correctionAttempts?.map((attempt) => {
                  if (
                    attempt.childThreadId !== threadId ||
                    attempt.childRunId !== runId ||
                    attempt.state !== "running"
                  )
                    return attempt;
                  const settled = {
                    ...attempt,
                    state: status === "completed" ? ("completed" as const) : ("failed" as const),
                    updatedAt: now,
                  };
                  const verifierRequest =
                    status === "completed" ? makeVerifierRequest(dag, current, settled) : undefined;
                  return verifierRequest === undefined ? settled : { ...settled, verifierRequest };
                }),
              };
              const next: PlotlineDagModel = {
                ...dag,
                tasks: dag.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)),
                state: deriveState(
                  dag.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)),
                ),
                updatedAt: now,
                finishedAt: ["done", "failed"].includes(
                  deriveState(
                    dag.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)),
                  ),
                )
                  ? now
                  : null,
              };
              const changed = yield* sql<{ readonly dag_id: string }>`
              UPDATE plotline_dags SET payload_json = ${encodeDagJson(next)}, updated_at = ${now}
              WHERE dag_id = ${match.dag_id} AND project_id = ${match.project_id} AND updated_at = ${row.updated_at}
              RETURNING dag_id
            `;
              if (changed.length > 0) changedAny = true;
            }
            return changedAny;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            isPlotlineDagError(error) ? error : dagError("Could not reconcile OpenCode run."),
          ),
          Effect.tap((changed) => (changed ? notify : Effect.void)),
          Effect.asVoid,
        ),
    );

  const removeInternal = Effect.fn("PlotlineDagService.delete")(function* (
    id: string,
    confirm: boolean,
  ) {
    if (!confirm) return yield* dagError("DAG deletion requires confirmation.", id);
    yield* sql`DELETE FROM plotline_dags WHERE dag_id = ${id}`.pipe(
      Effect.mapError(() => dagError("Could not delete DAG data.", id)),
    );
    yield* sql`DELETE FROM plotline_task_run_index WHERE dag_id = ${id}`.pipe(
      Effect.mapError(() => dagError("Could not delete DAG task index.", id)),
    );
    yield* notify;
  });
  const remove: PlotlineDagService["Service"]["delete"] = (id, confirm) =>
    mutationLock.withPermits(1)(removeInternal(id, confirm));

  return PlotlineDagService.of({
    list,
    subscribe,
    save,
    createForProject,
    getForProject,
    addTasks,
    updateTask,
    recordVerificationAttempt,
    beginCorrection,
    linkCorrection,
    settleCorrection,
    updateVerifierRequest,
    reconcileRun,
    addEvent,
    delete: remove,
  });
});

export const layer = Layer.effect(PlotlineDagService, make);
