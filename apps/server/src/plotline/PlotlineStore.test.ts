import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Database from "./PlotlineDatabase.ts";
import * as Store from "./PlotlineStore.ts";

/** No upstream migration registry or state.sqlite connection is present here. */
describe("Plotline extension persistence", () => {
  it.effect("applies its own append-only migration exactly once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Database.migratePlotlineDatabase;
      const versions = yield* sql<{ readonly version: number }>`
        SELECT version FROM plotline_schema_migrations ORDER BY version
      `;
      assert.deepStrictEqual(versions.map((row) => row.version), [1]);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      assert.deepStrictEqual(tables, []);
    }).pipe(Effect.provide(Database.layerMemory)),
  );

  it.effect("upserts a run snapshot and lists it without duplicate rows", () =>
    Effect.gen(function* () {
      const store = yield* Store.PlotlineStore;
      const input = {
        threadId: "thread-A",
        runId: "run-1",
        title: "Pricing",
        nodes: [
          {
            id: "run-1",
            parentId: null,
            title: "Pricing",
            kind: "run" as const,
            status: "running",
            provider: null,
            detail: "",
            result: null,
          },
        ],
        edges: [],
      };
      yield* store.save(input);
      yield* store.save({ ...input, nodes: input.nodes.map((node) => ({ ...node, status: "completed" })) });
      const items = yield* store.list({ threadId: "thread-A" });
      assert.equal(items.dags.length, 1);
      assert.equal(items.dags[0]?.runId, "run-1");
      assert.equal(items.dags[0]?.nodes[0]?.status, "completed");
      assert.deepStrictEqual((yield* store.list({ threadId: "other" })).dags, []);
    }).pipe(Effect.provide(Store.layerMemory)),
  );
});
