import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as PlotlineDags from "./PlotlineDagService.ts";

const TEST_TIME = "1970-01-01T00:00:00.000Z";

describe("PlotlineDagService", () => {
  it.effect("creates, updates, persists, and links a task to a T3 thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
      yield* sql`CREATE TABLE plotline_task_run_index (project_id TEXT NOT NULL, dag_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id, dag_id, task_id))`;
      const service = yield* PlotlineDags.PlotlineDagService;
      const now = TEST_TIME;
      const task = {
        id: "implement",
        title: "Implement DAG view",
        description: "",
        state: "pending" as const,
        effort: 3,
        dependsOn: [],
        threadId: null,
        runId: null,
        legacySessionIds: [],
        agent: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      };
      const created = yield* service.save({
        dag: {
          id: "native-plotline",
          projectId: "project:test",
          title: "Native Plotline",
          description: "",
          workspace: null,
          state: "waiting",
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          finishedAt: null,
          tasks: [task],
          events: [],
        },
      });
      assert.strictEqual(created.events.length, 1);

      const updated = yield* service.save({
        dag: {
          ...created,
          tasks: [
            { ...created.tasks[0]!, threadId: ThreadId.make("thread:test"), state: "running" },
          ],
        },
      });
      assert.strictEqual(updated.tasks[0]!.threadId, "thread:test");
      assert.strictEqual(updated.tasks[0]!.state, "running");
      assert.strictEqual(updated.events.length, 2);
      assert.strictEqual((yield* service.list({})).dags[0]!.tasks[0]!.threadId, "thread:test");
    }).pipe(
      Effect.provide(
        PlotlineDags.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
          ),
        ),
      ),
    ),
  );

  it.effect("rejects a task whose dependency is unfinished", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
      yield* sql`CREATE TABLE plotline_task_run_index (project_id TEXT NOT NULL, dag_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id, dag_id, task_id))`;
      const service = yield* PlotlineDags.PlotlineDagService;
      const now = TEST_TIME;
      const makeTask = (id: string, state: "pending" | "running", dependsOn: string[]) => ({
        id,
        title: id,
        description: "",
        state,
        effort: 1,
        dependsOn,
        threadId: null,
        runId: null,
        legacySessionIds: [],
        agent: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      });
      const result = yield* Effect.exit(
        service.save({
          dag: {
            id: "invalid-graph",
            projectId: "project:test",
            title: "Invalid graph",
            description: "",
            workspace: null,
            state: "waiting",
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            finishedAt: null,
            tasks: [makeTask("first", "pending", []), makeTask("second", "running", ["first"])],
            events: [],
          },
        }),
      );
      assert.isTrue(Exit.isFailure(result));
    }).pipe(
      Effect.provide(
        PlotlineDags.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "adds tasks incrementally, makes identical retries idempotent, and scopes DAG reads to the project",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
        yield* sql`CREATE TABLE plotline_task_run_index (project_id TEXT NOT NULL, dag_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id, dag_id, task_id))`;
        const service = yield* PlotlineDags.PlotlineDagService;
        const dag = yield* service.createForProject("project:a", "thread:a", "run:a", {
          title: "Migration",
          description: "",
        });
        const createRetry = yield* service.createForProject("project:a", "thread:a", "run:a", {
          title: "Migration",
          description: "",
        });
        assert.strictEqual(createRetry.id, dag.id);
        const tasks = [
          { id: "one", title: "One", description: "", effort: 2, dependsOn: [] },
          { id: "two", title: "Two", description: "", effort: 1, dependsOn: ["one"] },
        ];
        const first = yield* service.addTasks("project:a", { dagId: dag.id, tasks });
        const retry = yield* service.addTasks("project:a", { dagId: dag.id, tasks });
        assert.strictEqual(first.tasks.length, 2);
        assert.strictEqual(retry.tasks.length, 2);
        yield* Effect.all(
          [
            service.addTasks("project:a", {
              dagId: dag.id,
              tasks: [
                { id: "three", title: "Three", description: "", effort: 1, dependsOn: ["one"] },
              ],
            }),
            service.addTasks("project:a", {
              dagId: dag.id,
              tasks: [
                { id: "four", title: "Four", description: "", effort: 1, dependsOn: ["two"] },
              ],
            }),
          ],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(
          (yield* service.getForProject("project:a", dag.id)).tasks.map(({ id }) => id),
          ["one", "two", "three", "four"],
        );
        const beforeNoOp = yield* service.getForProject("project:a", dag.id);
        const noOp = yield* service.updateTask("project:a", { dagId: dag.id, taskId: "one" });
        assert.strictEqual(noOp.updatedAt, beforeNoOp.updatedAt);
        const staleSave = yield* Effect.exit(service.save({ dag }));
        assert.isTrue(Exit.isFailure(staleSave));
        assert.strictEqual((yield* service.getForProject("project:a", dag.id)).tasks.length, 4);
        const outside = yield* Effect.exit(service.getForProject("project:b", dag.id));
        assert.isTrue(Exit.isFailure(outside));
        const cycle = yield* Effect.exit(
          service.updateTask("project:a", {
            dagId: dag.id,
            taskId: "one",
            dependsOn: ["two"],
          }),
        );
        assert.isTrue(Exit.isFailure(cycle));
      }).pipe(
        Effect.provide(
          PlotlineDags.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
            ),
          ),
        ),
      ),
  );

  it.effect("reconciles only the exact indexed run and never treats success as verification", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
      yield* sql`CREATE TABLE plotline_task_run_index (project_id TEXT NOT NULL, dag_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id, dag_id, task_id))`;
      yield* sql`CREATE INDEX plotline_task_run_lookup_idx ON plotline_task_run_index(thread_id, run_id)`;
      const service = yield* PlotlineDags.PlotlineDagService;
      const dag = yield* service.createForProject("project:reconcile", "thread:origin", null, {
        title: "Reconcile",
        description: "",
      });
      yield* service.addTasks("project:reconcile", {
        dagId: dag.id,
        tasks: [{ id: "task", title: "Task", description: "", effort: 1, dependsOn: [] }],
      });
      yield* service.updateTask("project:reconcile", {
        dagId: dag.id,
        taskId: "task",
        state: "running",
        threadId: ThreadId.make("thread:exact"),
        runId: "run:exact",
        acceptanceCriteria: [{ id: "verified", description: "Explicit verification" }],
      });
      yield* service.reconcileRun("thread:wrong", "run:exact", "failed");
      yield* service.reconcileRun("thread:exact", "run:stale", "failed");
      assert.strictEqual(
        (yield* service.getForProject("project:reconcile", dag.id)).tasks[0]!.state,
        "running",
      );
      yield* service.reconcileRun("thread:exact", "run:exact", "completed");
      const unverified = (yield* service.getForProject("project:reconcile", dag.id)).tasks[0]!;
      assert.strictEqual(unverified.state, "running");
      assert.strictEqual(unverified.executionLifecycle, "awaiting_verification");
      assert.isNull(unverified.finishedAt);
      yield* service.reconcileRun("thread:exact", "run:exact", "failed");
      yield* service.reconcileRun("thread:exact", "run:exact", "failed");
      const reconciled = yield* service.getForProject("project:reconcile", dag.id);
      assert.strictEqual(reconciled.tasks[0]!.state, "failed");
      assert.strictEqual(reconciled.tasks[0]!.executionLifecycle, "failed_escalated");
      const restarted = yield* Effect.provide(
        PlotlineDags.PlotlineDagService,
        PlotlineDags.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(Layer.succeed(SqlClient.SqlClient, sql), NodeCrypto.layer),
          ),
        ),
      );
      assert.strictEqual(
        (yield* restarted.getForProject("project:reconcile", dag.id)).tasks[0]!.executionLifecycle,
        "failed_escalated",
      );
      assert.strictEqual(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM plotline_task_run_index WHERE thread_id = 'thread:exact' AND run_id = 'run:exact'`)[0]
          ?.count,
        1,
      );
    }).pipe(
      Effect.provide(
        PlotlineDags.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
          ),
        ),
      ),
    ),
  );

  it.effect("persists explicit verification attempts without completing the task", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
      yield* sql`CREATE TABLE plotline_task_run_index (project_id TEXT NOT NULL, dag_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id, dag_id, task_id))`;
      const service = yield* PlotlineDags.PlotlineDagService;
      const dag = yield* service.createForProject("project:v", "thread:v", null, {
        title: "Verification",
        description: "",
      });
      yield* service.addTasks("project:v", {
        dagId: dag.id,
        tasks: [{ id: "task", title: "Task", description: "", effort: 1, dependsOn: [] }],
      });
      yield* service.updateTask("project:v", {
        dagId: dag.id,
        taskId: "task",
        acceptanceCriteria: [
          { id: "works", description: "Behavior works" },
          { id: "tested", description: "Tests pass" },
        ],
      });
      const input = {
        dagId: dag.id,
        taskId: "task",
        attemptId: "attempt-1",
        expectedCriteriaVersion: 2,
        expectedRunId: null,
        verdict: "pass" as const,
        summary: "Verified",
        criterionResults: [
          { criterionId: "works", verdict: "pass" as const, evidence: "test passed" },
          { criterionId: "tested", verdict: "pass" as const, evidence: "tests passed" },
        ],
      };
      const incompletePass = yield* Effect.exit(
        service.recordVerificationAttempt("project:v", {
          ...input,
          attemptId: "incomplete",
          criterionResults: [input.criterionResults[0]!],
        }),
      );

      assert.isTrue(Exit.isFailure(incompletePass));
      const inconsistentPass = yield* Effect.exit(
        service.recordVerificationAttempt("project:v", {
          ...input,
          attemptId: "inconsistent",
          criterionResults: [
            input.criterionResults[0]!,
            { criterionId: "tested", verdict: "fail", evidence: "tests failed" },
          ],
        }),
      );
      assert.isTrue(Exit.isFailure(inconsistentPass));
      const first = yield* service.recordVerificationAttempt("project:v", input);
      const retry = yield* service.recordVerificationAttempt("project:v", input);
      assert.strictEqual(first.tasks[0]!.executionLifecycle, "verification_passed");
      assert.strictEqual(retry.tasks[0]!.executionLifecycle, "verification_passed");
      assert.strictEqual(first.tasks[0]!.verificationAttempts?.length, 1);
      assert.strictEqual(retry.tasks[0]!.verificationAttempts?.length, 1);
      assert.deepStrictEqual(
        (yield* service.list({ projectId: "project:v" })).dags[0]!.tasks[0]!.verificationAttempts,
        first.tasks[0]!.verificationAttempts,
      );
      assert.strictEqual(retry.tasks[0]!.state, "pending");
      assert.strictEqual(retry.state, "waiting");
      const changedCriteria = yield* service.updateTask("project:v", {
        dagId: dag.id,
        taskId: "task",
        acceptanceCriteria: [{ id: "works", description: "Behavior works differently" }],
      });
      assert.strictEqual(changedCriteria.tasks[0]!.verificationAttempts?.length, 1);
      assert.notStrictEqual(
        changedCriteria.tasks[0]!.verificationAttempts?.[0]?.criteriaVersion,
        changedCriteria.tasks[0]!.criteriaVersion,
      );
      const staleRetry = yield* Effect.exit(service.recordVerificationAttempt("project:v", input));
      assert.isTrue(Exit.isFailure(staleRetry));
      const staleNewSubmission = yield* Effect.exit(
        service.recordVerificationAttempt("project:v", {
          ...input,
          attemptId: "delayed-old-criteria",
        }),
      );
      assert.isTrue(Exit.isFailure(staleNewSubmission));
      const changedAfterRetry = yield* service.getForProject("project:v", dag.id);
      assert.strictEqual(changedAfterRetry.tasks[0]!.verificationAttempts?.length, 1);
      assert.strictEqual(
        changedAfterRetry.tasks[0]!.verificationAttempts?.[0]?.attemptId,
        "attempt-1",
      );
      assert.notStrictEqual(
        changedAfterRetry.tasks[0]!.verificationAttempts?.[0]?.criteriaVersion,
        changedAfterRetry.tasks[0]!.criteriaVersion,
      );
      assert.deepStrictEqual(
        changedAfterRetry.tasks[0]!.verificationAttempts?.[0]?.criterionResults.map(
          ({ criterionId }) => criterionId,
        ),
        ["works", "tested"],
      );
      assert.strictEqual(
        (yield* service.list({ projectId: "project:v" })).dags[0]!.tasks[0]!
          .verificationAttempts?.[0]?.verdict,
        "pass",
      );
      const conflict = yield* Effect.exit(
        service.recordVerificationAttempt("project:v", { ...input, verdict: "fail" }),
      );
      assert.isTrue(Exit.isFailure(conflict));
      const staleIdempotentRetry = yield* Effect.exit(
        service.recordVerificationAttempt("project:v", input),
      );
      assert.isTrue(Exit.isFailure(staleIdempotentRetry));

      const legacyPayload = JSON.parse(
        (yield* sql<{
          readonly payload_json: string;
        }>`SELECT payload_json FROM plotline_dags WHERE dag_id = ${dag.id}`)[0]!.payload_json,
      ) as { tasks: Array<Record<string, unknown>> };
      delete legacyPayload.tasks[0]!.criteriaVersion;
      const legacyAttempts = legacyPayload.tasks[0]!.verificationAttempts as
        | Array<Record<string, unknown>>
        | undefined;
      if (legacyAttempts?.[0]) delete legacyAttempts[0].criteriaVersion;
      yield* sql`UPDATE plotline_dags SET payload_json = ${JSON.stringify(legacyPayload)} WHERE dag_id = ${dag.id}`;
      const legacy = yield* service.getForProject("project:v", dag.id);
      assert.isUndefined(legacy.tasks[0]!.criteriaVersion);
      assert.isUndefined(legacy.tasks[0]!.verificationAttempts?.[0]?.criteriaVersion);
    }).pipe(
      Effect.provide(
        PlotlineDags.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "reserves bounded corrections idempotently and persists their delegated identities",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
        yield* sql`CREATE TABLE plotline_task_run_index (project_id TEXT NOT NULL, dag_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id, dag_id, task_id))`;
        yield* sql`CREATE TABLE harness_opencode_reconciliation (event_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, event_kind TEXT NOT NULL, status TEXT NOT NULL, next_attempt_at TEXT, updated_at TEXT NOT NULL)`;
        const service = yield* PlotlineDags.PlotlineDagService;
        const dag = yield* service.createForProject("project:correction", "thread:parent", null, {
          title: "Correction",
          description: "",
        });
        yield* service.addTasks("project:correction", {
          dagId: dag.id,
          tasks: [{ id: "task", title: "Task", description: "", effort: 1, dependsOn: [] }],
        });
        yield* service.updateTask("project:correction", {
          dagId: dag.id,
          taskId: "task",
          acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
        });
        const verification = yield* service.recordVerificationAttempt("project:correction", {
          dagId: dag.id,
          taskId: "task",
          attemptId: "failed-verification",
          expectedCriteriaVersion: 2,
          expectedRunId: null,
          verdict: "fail",
          summary: "The test failed.",
          criterionResults: [
            { criterionId: "works", verdict: "fail", evidence: "Assertion failed." },
          ],
        });
        assert.strictEqual(verification.tasks[0]!.verificationAttempts?.length, 1);
        assert.strictEqual(verification.tasks[0]!.executionLifecycle, "verification_failed");

        const input = {
          dagId: dag.id,
          taskId: "task",
          verificationAttemptId: "failed-verification",
          expectedCriteriaVersion: 2,
          expectedRunId: null,
          dispatchInput: {
            parentThreadId: ThreadId.make("thread:parent"),
            parentRunId: "run:parent",
            parentNodeId: "node:parent",
            task: "Apply the failed criterion correction.",
          },
        };
        const [first, duplicate] = yield* Effect.all(
          [
            service.beginCorrection("project:correction", input),
            service.beginCorrection("project:correction", input),
          ],
          { concurrency: "unbounded" },
        );
        if (!first.correction || !duplicate.correction)
          throw new Error("A failed verification should reserve a correction.");
        assert.strictEqual(first.correction.id, duplicate.correction.id);
        assert.strictEqual(first.shouldDispatch, true);
        assert.strictEqual(duplicate.shouldDispatch, true);
        assert.strictEqual(first.dag.tasks[0]!.correctionAttempts?.length, 1);
        assert.strictEqual(first.dag.tasks[0]!.executionLifecycle, "correction_in_progress");
        assert.deepStrictEqual(first.correction.dispatchInput, input.dispatchInput);

        const linked = yield* service.linkCorrection("project:correction", {
          dagId: dag.id,
          taskId: "task",
          correctionId: first.correction.id,
          childTaskId: "child-task",
          childThreadId: ThreadId.make("thread:child"),
          childRunId: "run:child",
        });
        assert.deepStrictEqual(
          [linked.tasks[0]!.threadId, linked.tasks[0]!.runId, linked.tasks[0]!.state],
          ["thread:child", "run:child", "running"],
        );
        assert.deepStrictEqual(
          [
            linked.tasks[0]!.correctionAttempts?.[0]?.childTaskId,
            linked.tasks[0]!.correctionAttempts?.[0]?.childThreadId,
            linked.tasks[0]!.correctionAttempts?.[0]?.childRunId,
            linked.tasks[0]!.correctionAttempts?.[0]?.state,
          ],
          ["child-task", "thread:child", "run:child", "running"],
        );
        yield* service.reconcileRun("thread:child", "run:child", "completed");
        let runId = "run:child";
        for (const cycle of [2, 3, 4]) {
          const attemptId = `failed-verification-${cycle}`;
          yield* service.recordVerificationAttempt("project:correction", {
            dagId: dag.id,
            taskId: "task",
            attemptId,
            expectedCriteriaVersion: 2,
            expectedRunId: runId,
            verdict: "fail",
            summary: `Cycle ${cycle} failed.`,
            criterionResults: [
              { criterionId: "works", verdict: "fail", evidence: `Cycle ${cycle} failed.` },
            ],
          });
          const next = yield* service.beginCorrection("project:correction", {
            dagId: dag.id,
            taskId: "task",
            verificationAttemptId: attemptId,
            expectedCriteriaVersion: 2,
            expectedRunId: runId,
          });
          if (cycle === 4) {
            assert.isTrue(next.escalated);
            assert.isNull(next.correction);
            assert.isFalse(next.shouldDispatch);
            assert.strictEqual(next.dag.tasks[0]!.executionLifecycle, "failed_escalated");
            assert.strictEqual(next.dag.tasks[0]!.state, "failed");
            break;
          }
          if (!next.correction)
            throw new Error("The correction budget should still allow this cycle.");
          assert.strictEqual(next.correction.attempt, cycle);
          const nextThreadId = ThreadId.make(`thread:child${cycle}`);
          const nextRunId = `run:child${cycle}`;
          yield* service.linkCorrection("project:correction", {
            dagId: dag.id,
            taskId: "task",
            correctionId: next.correction!.id,
            childTaskId: `child-task-${cycle}`,
            childThreadId: nextThreadId,
            childRunId: nextRunId,
          });
          yield* service.reconcileRun(nextThreadId, nextRunId, "completed");
          runId = nextRunId;
        }
        assert.strictEqual(
          (yield* service.getForProject("project:correction", dag.id)).tasks[0]!.correctionAttempts
            ?.length,
          3,
        );
        const restarted = yield* Effect.provide(
          PlotlineDags.PlotlineDagService,
          PlotlineDags.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(Layer.succeed(SqlClient.SqlClient, sql), NodeCrypto.layer),
            ),
          ),
        );
        const reloaded = yield* restarted.getForProject("project:correction", dag.id);
        assert.deepStrictEqual(
          reloaded.tasks[0]!.correctionAttempts?.[0]?.dispatchInput,
          input.dispatchInput,
          "correction dispatch input and owner must survive service restart",
        );
        assert.deepStrictEqual(
          reloaded.tasks[0]!.correctionAttempts?.map((attempt) => [
            attempt.attempt,
            attempt.state,
            attempt.childTaskId,
            attempt.childRunId,
          ]),
          [
            [1, "completed", "child-task", "run:child"],
            [2, "completed", "child-task-2", "run:child2"],
            [3, "completed", "child-task-3", "run:child3"],
          ],
        );
      }).pipe(
        Effect.provide(
          PlotlineDags.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
            ),
          ),
        ),
      ),
  );

  it.effect("persists escalation when a requested correction command is rejected", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
      yield* sql`CREATE TABLE plotline_task_run_index (project_id TEXT NOT NULL, dag_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id, dag_id, task_id))`;
      yield* sql`CREATE TABLE harness_opencode_reconciliation (event_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, event_kind TEXT NOT NULL, status TEXT NOT NULL, next_attempt_at TEXT, updated_at TEXT NOT NULL)`;
      const service = yield* PlotlineDags.PlotlineDagService;
      const dag = yield* service.createForProject(
        "project:rejected-correction",
        "thread:parent",
        null,
        {
          title: "Rejected correction",
          description: "",
        },
      );
      yield* service.addTasks("project:rejected-correction", {
        dagId: dag.id,
        tasks: [{ id: "task", title: "Task", description: "", effort: 1, dependsOn: [] }],
      });
      yield* service.updateTask("project:rejected-correction", {
        dagId: dag.id,
        taskId: "task",
        acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
      });
      yield* service.recordVerificationAttempt("project:rejected-correction", {
        dagId: dag.id,
        taskId: "task",
        attemptId: "failed-verification",
        expectedCriteriaVersion: 2,
        expectedRunId: null,
        verdict: "fail",
        summary: "The test failed.",
        criterionResults: [
          { criterionId: "works", verdict: "fail", evidence: "Assertion failed." },
        ],
      });
      const reserved = yield* service.beginCorrection("project:rejected-correction", {
        dagId: dag.id,
        taskId: "task",
        verificationAttemptId: "failed-verification",
        expectedCriteriaVersion: 2,
        expectedRunId: null,
        dispatchInput: {
          type: "delegated_task.request",
          parentThreadId: ThreadId.make("thread:parent"),
          parentRunId: "run:parent",
          parentNodeId: "node:parent",
          task: "Apply the failed criterion correction.",
        },
      });
      if (!reserved.correction) throw new Error("Expected a reserved correction.");
      const failed = yield* service.settleCorrection("project:rejected-correction", {
        dagId: dag.id,
        taskId: "task",
        correctionId: reserved.correction.id,
        state: "failed",
      });
      assert.strictEqual(failed.tasks[0]!.correctionAttempts?.[0]?.state, "failed");
      assert.strictEqual(failed.tasks[0]!.executionLifecycle, "failed_escalated");
      assert.strictEqual(failed.tasks[0]!.state, "failed");
    }).pipe(
      Effect.provide(
        PlotlineDags.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "keeps a completed correction unverified until a current verifier result is recorded",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
        yield* sql`CREATE TABLE plotline_task_run_index (project_id TEXT NOT NULL, dag_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id, dag_id, task_id))`;
        yield* sql`CREATE TABLE harness_opencode_reconciliation (event_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, event_kind TEXT NOT NULL, status TEXT NOT NULL, next_attempt_at TEXT, updated_at TEXT NOT NULL)`;
        const service = yield* PlotlineDags.PlotlineDagService;
        const dag = yield* service.createForProject("project:reverify", "thread:parent", null, {
          title: "Reverification boundary",
          description: "",
        });
        yield* service.addTasks("project:reverify", {
          dagId: dag.id,
          tasks: [{ id: "task", title: "Task", description: "", effort: 1, dependsOn: [] }],
        });
        yield* service.updateTask("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
        });
        yield* service.recordVerificationAttempt("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          attemptId: "initial-failure",
          expectedCriteriaVersion: 2,
          expectedRunId: null,
          verdict: "fail",
          summary: "The behavior failed.",
          criterionResults: [{ criterionId: "works", verdict: "fail", evidence: "Test failed." }],
        });
        const reserved = yield* service.beginCorrection("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          verificationAttemptId: "initial-failure",
          expectedCriteriaVersion: 2,
          expectedRunId: null,
          dispatchInput: {
            parentThreadId: ThreadId.make("thread:parent"),
            parentRunId: "run:parent",
            parentNodeId: "node:parent",
          },
        });
        if (!reserved.correction) throw new Error("Expected a correction attempt.");
        yield* service.linkCorrection("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          correctionId: reserved.correction.id,
          childTaskId: "correction-child",
          childThreadId: ThreadId.make("thread:reverify-correction"),
          childRunId: "run:reverify-correction",
        });

        yield* service.reconcileRun(
          ThreadId.make("thread:reverify-correction"),
          "run:reverify-correction",
          "completed",
        );
        yield* service.reconcileRun(
          ThreadId.make("thread:reverify-correction"),
          "run:reverify-correction",
          "completed",
        );
        const completed = yield* service.settleCorrection("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          correctionId: reserved.correction.id,
          state: "completed",
        });
        yield* service.settleCorrection("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          correctionId: reserved.correction.id,
          state: "completed",
        });
        const task = completed.tasks[0]!;
        assert.strictEqual(task.state, "running");
        assert.strictEqual(task.executionLifecycle, "awaiting_verification");
        assert.strictEqual(task.runId, "run:reverify-correction");
        assert.strictEqual(task.verificationAttempts?.length, 1);
        assert.notStrictEqual(task.state, "done");
        assert.deepStrictEqual(task.correctionAttempts?.[0]?.verifierRequest, {
          commandId: `plotline-verifier-${reserved.correction.id}`,
          parentThreadId: ThreadId.make("thread:parent"),
          parentRunId: "run:parent",
          parentNodeId: "node:parent",
          completionWake: "always",
          criteriaVersion: 2,
          expectedRunId: "run:reverify-correction",
          correctionId: reserved.correction.id,
          state: "requested",
          promptVersion: 2,
          task: [
            "Independently verify task task in project project:reverify, DAG " + dag.id + ".",
            "Working directory: Use the correction child thread working directory.",
            "Task: Task\n",
            `Correction ${reserved.correction.id}, child thread thread:reverify-correction, run run:reverify-correction.`,
            "Use the supplied context and criteria directly; do not use Plotline MCP tools to discover the parent DAG.",
            "Evaluate every current acceptance criterion against run run:reverify-correction.",
            "Return structured JSON with verdict (pass, fail, or inconclusive), a concise summary, and one result per criterion with criterionId, verdict, and reproducible evidence.",
            'Current criteria: [{"id":"works","description":"Behavior works"}]',
            "Do not modify the task or claim success without evidence.",
          ].join("\n\n"),
        });
        const restarted = yield* Effect.provide(
          PlotlineDags.PlotlineDagService,
          PlotlineDags.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(Layer.succeed(SqlClient.SqlClient, sql), NodeCrypto.layer),
            ),
          ),
        );
        const afterRestart = yield* restarted.getForProject("project:reverify", dag.id);
        assert.strictEqual(
          afterRestart.tasks[0]!.correctionAttempts?.[0]?.verifierRequest &&
            (afterRestart.tasks[0]!.correctionAttempts[0]!.verifierRequest as { state: string })
              .state,
          "requested",
          "the verifier request remains recoverable after a service restart",
        );
        yield* sql`UPDATE plotline_dags SET payload_json = json_set(json_remove(payload_json, '$.tasks[0].correctionAttempts[0].verifierRequest.promptVersion'), '$.tasks[0].correctionAttempts[0].verifierRequest.task', 'legacy prompt') WHERE dag_id = ${dag.id}`;
        const migrated = yield* restarted.updateVerifierRequest("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          correctionId: reserved.correction.id,
          state: "requested",
          refreshContext: true,
          expectedCommandId: `plotline-verifier-${reserved.correction.id}`,
          expectedRetryCount: 0,
        });
        const migratedRequest = migrated.tasks[0]!.correctionAttempts![0]!.verifierRequest!;
        assert.strictEqual(
          migratedRequest.commandId,
          `plotline-verifier-${reserved.correction.id}`,
        );
        assert.strictEqual(migratedRequest.promptVersion, 2);
        assert.include(
          migratedRequest.task,
          'Current criteria: [{"id":"works","description":"Behavior works"}]',
        );
        const dispatched = yield* restarted.updateVerifierRequest("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          correctionId: reserved.correction.id,
          state: "dispatched",
          childTaskId: "verifier-child",
          childThreadId: ThreadId.make("thread:verifier"),
          childRunId: "run:verifier",
        });
        assert.strictEqual(
          dispatched.tasks[0]!.correctionAttempts?.[0]?.verifierRequest?.state,
          "dispatched",
        );
        const backwards = yield* Effect.exit(
          restarted.updateVerifierRequest("project:reverify", {
            dagId: dag.id,
            taskId: "task",
            correctionId: reserved.correction.id,
            state: "requested",
          }),
        );
        assert.isTrue(backwards._tag === "Failure", "verifier states cannot move backwards");
        const retry = yield* restarted.updateVerifierRequest("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          correctionId: reserved.correction.id,
          state: "requested",
          diagnostic: "Verifier interrupted",
          expectedRetryCount: 0,
          expectedCommandId: `plotline-verifier-${reserved.correction.id}`,
          expectedChildTaskId: "verifier-child",
        });
        const duplicateRetry = yield* restarted.updateVerifierRequest("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          correctionId: reserved.correction.id,
          state: "requested",
          diagnostic: "Verifier interrupted",
          expectedRetryCount: 0,
          expectedCommandId: `plotline-verifier-${reserved.correction.id}`,
          expectedChildTaskId: "verifier-child",
        });
        assert.strictEqual(
          duplicateRetry.tasks[0]!.correctionAttempts?.[0]?.verifierRequest?.retryCount,
          1,
        );
        const retryRequest = retry.tasks[0]!.correctionAttempts?.[0]?.verifierRequest;
        assert.strictEqual(retryRequest?.retryCount, 1);
        assert.strictEqual(
          Date.parse(retryRequest!.nextRetryAt!) - Date.parse(retry.tasks[0]!.updatedAt),
          1000,
        );
        assert.strictEqual(retryRequest?.diagnostic, "Verifier interrupted");
        assert.strictEqual(retryRequest?.childThreadId, undefined);
        assert.strictEqual(retry.tasks[0]!.verificationAttempts?.length, 1);
        yield* restarted.updateVerifierRequest("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          correctionId: reserved.correction.id,
          state: "dispatched",
          childTaskId: "verifier-retry",
          childThreadId: ThreadId.make("thread:verifier-retry"),
          childRunId: "run:verifier-retry",
        });
        const verifierCompleted = yield* restarted.updateVerifierRequest("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          correctionId: reserved.correction.id,
          state: "completed",
        });
        assert.strictEqual(
          verifierCompleted.tasks[0]!.correctionAttempts?.[0]?.verifierRequest?.state,
          "completed",
        );
        yield* restarted.updateTask("project:reverify", {
          dagId: dag.id,
          taskId: "task",
          acceptanceCriteria: [{ id: "works", description: "Updated behavior" }],
        });
        const staleVerifier = yield* Effect.exit(
          restarted.updateVerifierRequest("project:reverify", {
            dagId: dag.id,
            taskId: "task",
            correctionId: reserved.correction.id,
            state: "completed",
          }),
        );
        assert.isTrue(
          staleVerifier._tag === "Failure",
          "criteria edits invalidate old verifier runs",
        );
      }).pipe(
        Effect.provide(
          PlotlineDags.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
            ),
          ),
        ),
      ),
  );

  it.effect("does not accept a passing verification attempt from an earlier linked run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
      yield* sql`CREATE TABLE plotline_task_run_index (project_id TEXT NOT NULL, dag_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id, dag_id, task_id))`;
      const service = yield* PlotlineDags.PlotlineDagService;
      const dag = yield* service.createForProject(
        "project:run-verification",
        "thread:run-verification",
        "run:first",
        { title: "Run-bound verification", description: "" },
      );
      yield* service.addTasks("project:run-verification", {
        dagId: dag.id,
        tasks: [{ id: "task", title: "Task", description: "", effort: 1, dependsOn: [] }],
      });
      yield* service.updateTask("project:run-verification", {
        dagId: dag.id,
        taskId: "task",
        threadId: ThreadId.make("thread:run-verification"),
        runId: "run:first",
      });
      yield* service.updateTask("project:run-verification", {
        dagId: dag.id,
        taskId: "task",
        acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
      });
      const currentRunVerification = {
        dagId: dag.id,
        taskId: "task",
        attemptId: "first-run-pass",
        expectedCriteriaVersion: 2,
        expectedRunId: "run:first",
        verdict: "pass" as const,
        summary: "Passed",
        criterionResults: [
          { criterionId: "works", verdict: "pass" as const, evidence: "test passed" },
        ],
      };
      yield* service.recordVerificationAttempt("project:run-verification", {
        ...currentRunVerification,
      });
      const replay = yield* service.recordVerificationAttempt(
        "project:run-verification",
        currentRunVerification,
      );
      assert.strictEqual(replay.tasks[0]!.verificationAttempts?.length, 1);
      assert.strictEqual(replay.tasks[0]!.executionLifecycle, "verification_passed");
      yield* service.updateTask("project:run-verification", {
        dagId: dag.id,
        taskId: "task",
        threadId: ThreadId.make("thread:run-verification"),
        runId: "run:second",
      });
      const delayedOldRun = yield* Effect.exit(
        service.recordVerificationAttempt("project:run-verification", {
          ...currentRunVerification,
          attemptId: "delayed-old-run",
        }),
      );
      assert.strictEqual(
        (yield* service.getForProject("project:run-verification", dag.id)).tasks[0]!
          .executionLifecycle,
        "executing",
      );
      assert.isTrue(Exit.isFailure(delayedOldRun));
      const staleIdempotentReplay = yield* Effect.exit(
        service.recordVerificationAttempt("project:run-verification", currentRunVerification),
      );
      assert.isTrue(Exit.isFailure(staleIdempotentReplay));
      const staleCompletion = yield* Effect.exit(
        service.updateTask("project:run-verification", {
          dagId: dag.id,
          taskId: "task",
          state: "done",
        }),
      );
      assert.isTrue(Exit.isFailure(staleCompletion));
      const latest = yield* service.getForProject("project:run-verification", dag.id);
      assert.strictEqual(latest.tasks[0]!.verificationAttempts?.[0]?.runId, "run:first");
    }).pipe(
      Effect.provide(
        PlotlineDags.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "requires a passing verification for current criteria before completing or releasing dependencies",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
        yield* sql`CREATE TABLE plotline_task_run_index (project_id TEXT NOT NULL, dag_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id, dag_id, task_id))`;
        const service = yield* PlotlineDags.PlotlineDagService;
        const dag = yield* service.createForProject("project:gate", "thread:gate", null, {
          title: "Verification gate",
          description: "",
        });
        yield* service.addTasks("project:gate", {
          dagId: dag.id,
          tasks: [
            { id: "parent", title: "Parent", description: "", effort: 1, dependsOn: [] },
            { id: "child", title: "Child", description: "", effort: 1, dependsOn: ["parent"] },
            { id: "legacy", title: "Legacy", description: "", effort: 1, dependsOn: [] },
            {
              id: "criteria-reset",
              title: "Criteria reset",
              description: "",
              effort: 1,
              dependsOn: [],
            },
            {
              id: "criteria-race",
              title: "Criteria race",
              description: "",
              effort: 1,
              dependsOn: [],
            },
          ],
        });
        const emptyCriteriaPass = yield* Effect.exit(
          service.recordVerificationAttempt("project:gate", {
            dagId: dag.id,
            taskId: "legacy",
            attemptId: "empty-criteria",
            expectedCriteriaVersion: 1,
            expectedRunId: null,
            verdict: "pass",
            summary: "No criteria",
            criterionResults: [],
          }),
        );
        assert.isTrue(Exit.isFailure(emptyCriteriaPass));
        yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "parent",
          acceptanceCriteria: [{ id: "works", description: "Behavior works" }],
        });
        const prematureDone = yield* Effect.exit(
          service.updateTask("project:gate", { dagId: dag.id, taskId: "parent", state: "done" }),
        );
        assert.isTrue(Exit.isFailure(prematureDone));
        const prematureRelease = yield* Effect.exit(
          service.updateTask("project:gate", { dagId: dag.id, taskId: "child", state: "running" }),
        );
        assert.isTrue(Exit.isFailure(prematureRelease));

        const failedPrerequisite = yield* Effect.exit(
          service.updateTask("project:gate", { dagId: dag.id, taskId: "parent", state: "failed" }),
        );
        assert.isTrue(Exit.isSuccess(failedPrerequisite));
        const failedPrerequisiteRelease = yield* Effect.exit(
          service.updateTask("project:gate", { dagId: dag.id, taskId: "child", state: "running" }),
        );
        assert.isTrue(Exit.isFailure(failedPrerequisiteRelease));
        yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "parent",
          state: "running",
        });

        const concurrent = yield* Effect.all(
          [
            Effect.exit(
              service.updateTask("project:gate", {
                dagId: dag.id,
                taskId: "child",
                state: "running",
              }),
            ),
            Effect.exit(
              service.updateTask("project:gate", {
                dagId: dag.id,
                taskId: "parent",
                state: "done",
              }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        assert.isTrue(Exit.isFailure(concurrent[0]!));

        const pass = {
          dagId: dag.id,
          taskId: "parent",
          attemptId: "current-pass",
          expectedCriteriaVersion: 2,
          expectedRunId: null,
          verdict: "pass" as const,
          summary: "Verified",
          criterionResults: [
            { criterionId: "works", verdict: "pass" as const, evidence: "test passed" },
          ],
        };
        yield* service.recordVerificationAttempt("project:gate", pass);
        const changedAndDone = yield* Effect.exit(
          service.updateTask("project:gate", {
            dagId: dag.id,
            taskId: "parent",
            acceptanceCriteria: [{ id: "new-version", description: "New requirement" }],
            state: "done",
          }),
        );
        assert.isTrue(Exit.isFailure(changedAndDone));
        yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "parent",
          acceptanceCriteria: [{ id: "works-now", description: "Behavior still works" }],
        });
        const staleVerificationDone = yield* Effect.exit(
          service.updateTask("project:gate", { dagId: dag.id, taskId: "parent", state: "done" }),
        );
        assert.isTrue(Exit.isFailure(staleVerificationDone));
        yield* service.recordVerificationAttempt("project:gate", {
          ...pass,
          attemptId: "latest-pass",
          expectedCriteriaVersion: 3,
          criterionResults: [
            { criterionId: "works-now", verdict: "pass" as const, evidence: "rerun passed" },
          ],
        });
        const completed = yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "parent",
          state: "done",
        });
        assert.strictEqual(completed.tasks.find((task) => task.id === "parent")!.state, "done");
        const released = yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "child",
          state: "running",
        });
        assert.strictEqual(released.tasks.find((task) => task.id === "child")!.state, "running");
        const failedVerificationWithActiveDependent = yield* Effect.exit(
          service.recordVerificationAttempt("project:gate", {
            dagId: dag.id,
            taskId: "parent",
            attemptId: "failed-after-dependent-started",
            expectedCriteriaVersion: 3,
            expectedRunId: null,
            verdict: "fail",
            summary: "Latest verification failed",
            criterionResults: [{ criterionId: "works-now", verdict: "fail", evidence: "failed" }],
          }),
        );
        assert.isTrue(Exit.isFailure(failedVerificationWithActiveDependent));

        const parentCriteriaEditWithActiveDependent = yield* Effect.exit(
          service.updateTask("project:gate", {
            dagId: dag.id,
            taskId: "parent",
            acceptanceCriteria: [{ id: "revised", description: "Revised requirement" }],
          }),
        );
        assert.isTrue(Exit.isFailure(parentCriteriaEditWithActiveDependent));
        yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "child",
          state: "done",
        });
        const parentCriteriaEditWithCompletedDependent = yield* Effect.exit(
          service.updateTask("project:gate", {
            dagId: dag.id,
            taskId: "parent",
            acceptanceCriteria: [{ id: "revised-again", description: "Another revision" }],
          }),
        );
        assert.isTrue(Exit.isFailure(parentCriteriaEditWithCompletedDependent));
        const legacyCompleted = yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "legacy",
          state: "done",
        });
        assert.strictEqual(
          legacyCompleted.tasks.find((task) => task.id === "legacy")!.state,
          "done",
        );

        yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "criteria-race",
          acceptanceCriteria: [{ id: "before", description: "Initial requirement" }],
        });
        yield* service.recordVerificationAttempt("project:gate", {
          dagId: dag.id,
          taskId: "criteria-race",
          attemptId: "criteria-race-pass",
          expectedCriteriaVersion: 2,
          expectedRunId: null,
          verdict: "pass",
          summary: "Verified",
          criterionResults: [{ criterionId: "before", verdict: "pass", evidence: "passed" }],
        });
        yield* Effect.all(
          [
            service.updateTask("project:gate", {
              dagId: dag.id,
              taskId: "criteria-race",
              acceptanceCriteria: [{ id: "after", description: "Changed requirement" }],
            }),
            Effect.exit(
              service.updateTask("project:gate", {
                dagId: dag.id,
                taskId: "criteria-race",
                state: "done",
              }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        assert.notStrictEqual(
          (yield* service.getForProject("project:gate", dag.id)).tasks.find(
            (task) => task.id === "criteria-race",
          )!.state,
          "done",
        );

        yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "criteria-reset",
          acceptanceCriteria: [{ id: "old", description: "Old requirement" }],
        });
        yield* service.recordVerificationAttempt("project:gate", {
          dagId: dag.id,
          taskId: "criteria-reset",
          attemptId: "criteria-reset-pass",
          expectedCriteriaVersion: 2,
          expectedRunId: null,
          verdict: "pass",
          summary: "Verified",
          criterionResults: [{ criterionId: "old", verdict: "pass", evidence: "passed" }],
        });
        yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "criteria-reset",
          state: "done",
        });
        const criteriaChangedAfterDone = yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "criteria-reset",
          acceptanceCriteria: [{ id: "new", description: "New requirement" }],
        });
        assert.notStrictEqual(
          criteriaChangedAfterDone.tasks.find((task) => task.id === "criteria-reset")!.state,
          "done",
        );
        yield* service.recordVerificationAttempt("project:gate", {
          dagId: dag.id,
          taskId: "criteria-reset",
          attemptId: "criteria-reset-current-pass",
          expectedCriteriaVersion: 3,
          expectedRunId: null,
          verdict: "pass",
          summary: "Verified current criteria",
          criterionResults: [{ criterionId: "new", verdict: "pass", evidence: "passed" }],
        });
        yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "criteria-reset",
          state: "done",
        });
        const incompleteFailure = yield* service.recordVerificationAttempt("project:gate", {
          dagId: dag.id,
          taskId: "criteria-reset",
          attemptId: "incomplete-failure",
          expectedCriteriaVersion: 3,
          expectedRunId: null,
          verdict: "fail",
          summary: "One criterion was not assessed",
          criterionResults: [],
        });
        assert.strictEqual(
          incompleteFailure.tasks
            .find((task) => task.id === "criteria-reset")!
            .verificationAttempts?.at(-1)?.verdict,
          "fail",
        );
        assert.strictEqual(
          incompleteFailure.tasks.find((task) => task.id === "criteria-reset")!.state,
          "pending",
        );
        yield* service.recordVerificationAttempt("project:gate", {
          dagId: dag.id,
          taskId: "criteria-reset",
          attemptId: "criteria-reset-repass",
          expectedCriteriaVersion: 3,
          expectedRunId: null,
          verdict: "pass",
          summary: "Passed again",
          criterionResults: [{ criterionId: "new", verdict: "pass", evidence: "passed" }],
        });
        yield* service.updateTask("project:gate", {
          dagId: dag.id,
          taskId: "criteria-reset",
          state: "done",
        });
        const incompleteInconclusive = yield* service.recordVerificationAttempt("project:gate", {
          dagId: dag.id,
          taskId: "criteria-reset",
          attemptId: "incomplete-inconclusive",
          expectedCriteriaVersion: 3,
          expectedRunId: null,
          verdict: "inconclusive",
          summary: "The remaining criterion was not assessed",
          criterionResults: [],
        });
        assert.strictEqual(
          incompleteInconclusive.tasks
            .find((task) => task.id === "criteria-reset")!
            .verificationAttempts?.at(-1)?.verdict,
          "inconclusive",
        );
        assert.strictEqual(
          incompleteInconclusive.tasks.find((task) => task.id === "criteria-reset")!.state,
          "pending",
        );
        assert.strictEqual(
          incompleteInconclusive.tasks.find((task) => task.id === "criteria-reset")!
            .executionLifecycle,
          "awaiting_verification",
        );
        const incompleteFailureCannotComplete = yield* Effect.exit(
          service.updateTask("project:gate", {
            dagId: dag.id,
            taskId: "criteria-reset",
            state: "done",
          }),
        );
        assert.isTrue(Exit.isFailure(incompleteFailureCannotComplete));
        for (let index = 0; index < 95; index++)
          yield* service.recordVerificationAttempt("project:gate", {
            dagId: dag.id,
            taskId: "criteria-reset",
            attemptId: `attempt_${index}`,
            expectedCriteriaVersion: 3,
            expectedRunId: null,
            verdict: "fail",
            summary: "Still failing",
            criterionResults: [{ criterionId: "new", verdict: "fail", evidence: "failed" }],
          });
        const overflow = yield* Effect.exit(
          service.recordVerificationAttempt("project:gate", {
            dagId: dag.id,
            taskId: "criteria-reset",
            attemptId: "attempt-overflow",
            expectedCriteriaVersion: 3,
            expectedRunId: null,
            verdict: "fail",
            summary: "Overflow",
            criterionResults: [{ criterionId: "new", verdict: "fail", evidence: "failed" }],
          }),
        );
        assert.isTrue(Exit.isFailure(overflow));
        assert.strictEqual(
          (yield* service.getForProject("project:gate", dag.id)).tasks.find(
            (task) => task.id === "criteria-reset",
          )!.verificationAttempts?.length,
          100,
        );
      }).pipe(
        Effect.provide(
          PlotlineDags.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
            ),
          ),
        ),
      ),
  );
  it.effect("never marks a legacy no-criteria task done from a successful run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE plotline_dags (dag_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
      yield* sql`CREATE TABLE plotline_task_run_index (project_id TEXT NOT NULL, dag_id TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(project_id, dag_id, task_id))`;
      const service = yield* PlotlineDags.PlotlineDagService;
      const dag = yield* service.createForProject("project:legacy-run", "thread:origin", null, {
        title: "Legacy",
        description: "",
      });
      yield* service.addTasks("project:legacy-run", {
        dagId: dag.id,
        tasks: [{ id: "legacy", title: "Legacy task", description: "", effort: 1, dependsOn: [] }],
      });
      yield* service.updateTask("project:legacy-run", {
        dagId: dag.id,
        taskId: "legacy",
        state: "running",
        threadId: ThreadId.make("thread:legacy"),
        runId: "run:legacy",
      });
      yield* service.reconcileRun("thread:legacy", "run:legacy", "completed");
      assert.strictEqual(
        (yield* service.getForProject("project:legacy-run", dag.id)).tasks[0]!.state,
        "running",
      );
    }).pipe(
      Effect.provide(
        PlotlineDags.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
          ),
        ),
      ),
    ),
  );
});
