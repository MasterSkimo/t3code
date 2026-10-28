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
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
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

const nextUpdatedAt = (previous: string | undefined, now: string) =>
  previous !== undefined && now <= previous
    ? DateTime.formatIso(
        DateTime.toUtc(DateTime.add(DateTime.makeUnsafe(previous), { milliseconds: 1 })),
      )
    : now;

function validateDag(dag: PlotlineDagModel, previous?: PlotlineDagModel): PlotlineDagError | null {
  const ids = new Set<string>();
  for (const task of dag.tasks) {
    if (ids.has(task.id)) return dagError(`Duplicate task id: ${task.id}`, dag.id);
    ids.add(task.id);
    if (!Number.isInteger(task.effort) || task.effort < 1 || task.effort > 5)
      return dagError(`Task effort must be an integer from 1 to 5: ${task.id}`, dag.id);
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
      if (old && old.state !== task.state && !transitions[old.state]?.includes(task.state))
        return dagError(`Invalid task transition ${old.state} → ${task.state}: ${task.id}`, dag.id);
    }
  }
  return null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const list: PlotlineDagService["Service"]["list"] = Effect.fn("PlotlineDagService.list")(
    function* (input) {
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

  const save: PlotlineDagService["Service"]["save"] = Effect.fn("PlotlineDagService.save")(
    function* (input) {
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
    },
  );

  const getForProject: PlotlineDagService["Service"]["getForProject"] = Effect.fn(
    "PlotlineDagService.getForProject",
  )(function* (projectId, id) {
    const result = yield* list({ projectId });
    const dag = result.dags.find((item) => item.id === id);
    return dag ?? (yield* dagError("DAG was not found in the current project.", id));
  });

  const createForProject: PlotlineDagService["Service"]["createForProject"] = Effect.fn(
    "PlotlineDagService.createForProject",
  )(function* (projectId, threadId, runId, input) {
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

  const mutate: (
    projectId: string,
    dagId: string,
    operation: (dag: PlotlineDagModel) => Effect.Effect<PlotlineDagModel, PlotlineDagError>,
  ) => Effect.Effect<PlotlineDagModel, PlotlineDagError> = (projectId, dagId, operation) =>
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
          return withEvent;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPlotlineDagError(error) ? error : dagError("Could not update DAG data.", dagId),
        ),
        Effect.tap(() => notify),
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
        const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
        const task = {
          ...current,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
          ...(input.state === undefined ? {} : { state: input.state }),
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          updatedAt: now,
          ...(input.state === undefined || input.state === current.state
            ? {}
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

  const remove: PlotlineDagService["Service"]["delete"] = Effect.fn("PlotlineDagService.delete")(
    function* (id, confirm) {
      if (!confirm) return yield* dagError("DAG deletion requires confirmation.", id);
      yield* sql`DELETE FROM plotline_dags WHERE dag_id = ${id}`.pipe(
        Effect.mapError(() => dagError("Could not delete DAG data.", id)),
      );
      yield* notify;
    },
  );

  return PlotlineDagService.of({
    list,
    subscribe,
    save,
    createForProject,
    getForProject,
    addTasks,
    updateTask,
    addEvent,
    delete: remove,
  });
});

export const layer = Layer.effect(PlotlineDagService, make);
