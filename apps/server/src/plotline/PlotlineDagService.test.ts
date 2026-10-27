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
});
