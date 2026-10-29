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
  type PlotlineDagCreateInput,
  type PlotlineDag as PlotlineDagModel,
  type PlotlineDagTask,
  type PlotlineDagRecordVerificationInput as PlotlineDagRecordVerificationInputType,
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
const isPlotlineDagError = Schema.is(PlotlineDagError);
const terminal = new Set(["done", "skipped"]);
const transitions: Record<string, ReadonlyArray<string>> = {
  pending: ["running", "done", "failed", "skipped"],
  running: ["done", "failed", "skipped"],
  failed: ["running", "skipped"],
  skipped: ["running"],
  done: [],
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

function sameVerificationAttemptContent(
  stored: {
    readonly attemptId: string;
    readonly verdict: string;
    readonly summary: string;
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
            .filter((attempt) => (attempt.criteriaVersion ?? 1) === nextCriteriaVersion)
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
          criteriaVersion: task.criteriaVersion ?? 1,
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
                  updatedAt: now,
                }
              : item,
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
              if (nextState === current.state && current.finishedAt === null) continue;
              const now = nextUpdatedAt(
                dag.updatedAt,
                DateTime.formatIso(DateTime.toUtc(yield* DateTime.now)),
              );
              const task: PlotlineDagTask = {
                ...current,
                state: nextState,
                updatedAt: now,
                finishedAt: nextState === "running" ? null : now,
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
    reconcileRun,
    addEvent,
    delete: remove,
  });
});

export const layer = Layer.effect(PlotlineDagService, make);
