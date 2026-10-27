import {
  PlotlineDag,
  PlotlineDagError,
  PlotlineDagListInput,
  PlotlineDagListResult,
  PlotlineDagSaveInput,
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
      const base: PlotlineDagModel = {
        ...input.dag,
        createdAt: previous?.createdAt ?? input.dag.createdAt,
        events: previous?.events ?? input.dag.events,
      };
      const validationError = validateDag(base, previous);
      if (validationError) return yield* validationError;

      const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
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
      yield* notify;
      return withEvent;
    },
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

  return PlotlineDagService.of({ list, subscribe, save, delete: remove });
});

export const layer = Layer.effect(PlotlineDagService, make);
