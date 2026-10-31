import {
  PlotlinePlan,
  PlotlineStorageError,
  type PlotlinePlan as Plan,
  type PlotlinePlanCreate as CreateInput,
  type PlotlineTaskAdd as AddInput,
  type PlotlineTaskUpdate as UpdateInput,
  type PlotlineTaskBind as BindInput,
  type PlotlinePlanMutationResult as MutationResult,
  type PlotlinePlanTask as PlanTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

export type PlanMutation =
  | { readonly kind: "create"; readonly rootThreadId: string; readonly actorThreadId: string; readonly input: CreateInput }
  | { readonly kind: "add"; readonly rootThreadId: string; readonly actorThreadId: string; readonly input: AddInput }
  | { readonly kind: "update"; readonly rootThreadId: string; readonly actorThreadId: string; readonly input: UpdateInput }
  | { readonly kind: "bind"; readonly rootThreadId: string; readonly actorThreadId: string; readonly input: BindInput & { readonly childThreadId: string | null } };

const codec = Schema.fromJsonString(PlotlinePlan);
const decode = Schema.decodeUnknownSync(codec);
const encode = Schema.encodeSync(codec);
const fail = (message: string) => new PlotlineStorageError({ message });
const MAX_TASKS = 300;
const MAX_BYTES = 1024 * 1024;

/** Task IDs are stable within a plan; cycles are forbidden in both hierarchy and dependencies. */
export const assertValidPlan = (plan: Plan): void => {
  if (!plan.rootThreadId || !plan.title.trim() || plan.title.length > 200) throw Error("Invalid plan title or thread.");
  if (plan.tasks.length > MAX_TASKS) throw Error("Plan exceeds the task limit.");
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  if (tasks.size !== plan.tasks.length) throw Error("Duplicate task IDs.");
  for (const task of plan.tasks) {
    if (!task.id.trim() || task.id.length > 128 || !task.title.trim() || task.title.length > 200 ||
        task.detail.length > 4000 || task.dependsOn.length > MAX_TASKS) throw Error("Invalid task metadata.");
    if (task.parentTaskId !== null && !tasks.has(task.parentTaskId)) throw Error("Unknown parent task.");
    if (new Set(task.dependsOn).size !== task.dependsOn.length ||
        task.dependsOn.some((id) => !tasks.has(id))) throw Error("Invalid dependencies.");
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw Error("The DAG must not contain a cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    const task = tasks.get(id)!;
    for (const prev of [...task.dependsOn, ...(task.parentTaskId === null ? [] : [task.parentTaskId])]) visit(prev);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of plan.tasks) visit(task.id);
};

/** Apply only plan metadata. Running/completed statuses always come from native T3. */
export const evolvePlan = (current: Plan | null, mutation: PlanMutation, now: string): Plan => {
  const { kind, rootThreadId, actorThreadId, input } = mutation;
  const isRoot = rootThreadId === actorThreadId;
  if (kind === "create") {
    if (!isRoot) throw Error("Only the root orchestrator may initialize the plan.");
    if (current) throw Error("Plan already initialized.");
    const tasks: PlanTask[] = input.tasks.map((task) => ({
      id: task.id, title: task.title, detail: task.detail ?? "",
      parentTaskId: task.parentTaskId ?? null, dependsOn: [...(task.dependsOn ?? [])],
      planState: "planned", reason: null, createdByThreadId: actorThreadId,
      boundThreadId: null, boundTaskId: null,
    }));
    const plan: Plan = { rootThreadId, title: input.title, tasks, revision: 1, updatedAt: now };
    assertValidPlan(plan);
    return plan;
  }
  if (!current) throw Error("The root orchestrator must initialize the plan first.");
  const tasks = [...current.tasks];
  const find = (id: string) => tasks.findIndex((task) => task.id === id);
  if (kind === "add") {
    const task = input.task;
    if (find(task.id) !== -1) throw Error("Task ID already exists.");
    const parentTaskId = task.parentTaskId ?? null;
    if (!isRoot) {
      const parent = parentTaskId === null ? null : tasks.find((entry) => entry.id === parentTaskId);
      if (!parent || (parent.boundThreadId !== actorThreadId && parent.createdByThreadId !== actorThreadId))
        throw Error("A worker may add subtasks only under its assigned task.");
    }
    tasks.push({
      id: task.id, title: task.title, detail: task.detail ?? "",
      parentTaskId, dependsOn: [...(task.dependsOn ?? [])], planState: "planned",
      reason: null, createdByThreadId: actorThreadId, boundThreadId: null, boundTaskId: null,
    });
  } else {
    const i = find(input.taskId);
    if (i === -1) throw Error("Unknown task ID.");
    const task = tasks[i]!;
    if (!isRoot && task.createdByThreadId !== actorThreadId && task.boundThreadId !== actorThreadId)
      throw Error("A worker may update only its own or assigned tasks.");
    if (kind === "update") {
      if (task.boundTaskId && input.planState && input.planState !== "planned")
        throw Error("A bound task's native execution status cannot be overridden.");
      if (input.planState !== undefined && input.planState !== "planned" &&
          !(input.reason?.trim())) throw Error("Skipped/cancelled plans require a reason.");
      tasks[i] = {
        ...task,
        title: input.title ?? task.title,
        detail: input.detail ?? task.detail,
        dependsOn: input.dependsOn === undefined ? task.dependsOn : [...input.dependsOn],
        planState: input.planState ?? task.planState,
        reason: input.reason ?? task.reason,
      };
    } else {
      if (!isRoot) throw Error("Only the root orchestrator can bind native delegations.");
      if (tasks.some((other) => other.id !== task.id && other.boundTaskId === input.delegatedTaskId))
        throw Error("Native delegation is already bound to another plan task.");
      if (task.boundTaskId !== null && task.boundTaskId !== input.delegatedTaskId)
        throw Error("Native delegation binding cannot be replaced.");
      tasks[i] = { ...task, boundTaskId: input.delegatedTaskId, boundThreadId: input.childThreadId };
    }
  }
  const plan: Plan = { ...current, tasks, revision: current.revision + 1, updatedAt: now };
  assertValidPlan(plan);
  return plan;
};

/**
 * Every mutation is a SQLite transaction plus a unique request receipt.
 * Concurrent agents cannot overwrite one another with last-writer-wins JSON.
 */
export const makePlanOperations = (sql: SqlClient.SqlClient) => {
  const getPlan = (rootThreadId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM fork_plotline_plans WHERE root_thread_id = ${rootThreadId}
      `;
      if (rows.length === 0) return null;
      return yield* Effect.try({
        try: () => decode(rows[0]!.payload_json),
        catch: () => fail("Persisted Plotline plan is invalid."),
      });
    }).pipe(Effect.mapError((error) => fail(error instanceof Error ? error.message : "Plan read failed.")));

  const mutatePlan = (mutation: PlanMutation): Effect.Effect<MutationResult, PlotlineStorageError> =>
    sql.withTransaction(
      Effect.gen(function* () {
        const id = mutation.input.requestId;
        if (!id.trim() || id.length > 128) return yield* fail("Invalid request ID.");
        const requestJson = JSON.stringify(mutation.input);
        const receipts = yield* sql<{
          readonly revision: number;
          readonly operation: string;
          readonly actor_thread_id: string;
          readonly payload_json: string;
        }>`
          SELECT revision, operation, actor_thread_id, payload_json FROM fork_plotline_plan_events
          WHERE root_thread_id = ${mutation.rootThreadId} AND request_id = ${id}
        `;
        if (receipts.length) {
          const receipt = receipts[0]!;
          if (receipt.operation !== mutation.kind ||
              receipt.actor_thread_id !== mutation.actorThreadId ||
              receipt.payload_json !== requestJson) return yield* fail("Request ID reused with different data.");
          return { rootThreadId: mutation.rootThreadId, revision: receipt.revision, updated: false };
        }
        const previous = yield* getPlan(mutation.rootThreadId);
        const now = DateTime.formatIso(DateTime.toUtc(yield* DateTime.now));
        const plan = yield* Effect.try({
          try: () => evolvePlan(previous, mutation, now),
          catch: (error) => fail(error instanceof Error ? error.message : "Invalid plan mutation."),
        });
        const json = yield* Effect.try({
          try: () => encode(plan),
          catch: () => fail("Could not serialize Plotline plan."),
        });
        if (new TextEncoder().encode(json).byteLength > MAX_BYTES) return yield* fail("Plan exceeds the storage limit.");
        yield* sql`
          INSERT INTO fork_plotline_plans (root_thread_id, revision, payload_json, created_at, updated_at)
          VALUES (${plan.rootThreadId}, ${plan.revision}, ${json}, ${now}, ${now})
          ON CONFLICT(root_thread_id) DO UPDATE SET
            revision = excluded.revision, payload_json = excluded.payload_json, updated_at = excluded.updated_at
        `;
        yield* sql`
          INSERT INTO fork_plotline_plan_events
            (root_thread_id, request_id, revision, actor_thread_id, operation, payload_json, created_at)
          VALUES (${plan.rootThreadId}, ${id}, ${plan.revision}, ${mutation.actorThreadId}, ${mutation.kind}, ${requestJson}, ${now})
        `;
        return { rootThreadId: plan.rootThreadId, revision: plan.revision, updated: true };
      }),
    ).pipe(Effect.mapError((error) => fail(error instanceof Error ? error.message : "Plan mutation failed.")));

  return { getPlan, mutatePlan };
};
